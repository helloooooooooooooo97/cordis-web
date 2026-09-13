import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Service, type Context, type Plugin } from 'cordis'
import type { CatalogEntry } from '@biu/host-hub'
import {
  buildStoreManifest,
  bundleStoreEntry,
  findEntry,
  HOST_ENTRIES,
  persistStoreManifestCreatedAt,
  listingCreatedAt,
  WEB_ENTRIES,
  type PluginCreateInput,
  type StoreManifestFields,
} from './plugin-create.ts'
import { parseStoreShell, requireDeclaredShell, type StoreShell } from '../shell.ts'

export type StoreListing = {
  id: string
  name: string
  blurb: string
  tags: string[]
  author: string
  authorUrl: string
  enabled: boolean
  running: boolean
  bytes: number
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  hasHost: boolean
  hasWeb: boolean
  /** 已安装 host.js + web.js 的内容短哈希，与加载 URL 的 v 参数一致。 */
  codeVersion?: string
  headless?: boolean
  shell?: StoreShell
}

export type StoreManifest = StoreManifestFields

type StoreHub = {
  adopt(entry: CatalogEntry): Promise<unknown>
  drop(id: string): Promise<unknown>
  snapshot(): { plugins: Array<{ id: string; enabled?: boolean; state?: string }> }
}

const ALLOWED_FILES = new Set(['manifest.json', 'host.js', 'web.js'])
const README_FILE = 'README.md'
/** pack 进 .plugin 的可执行代码；版本号按这两个文件一起算。 */
const PLUGIN_CODE_FILES = ['host.js', 'web.js'] as const

/** 已安装插件代码短版本：host.js 与 web.js 按文件名顺序一起 SHA-1，取前 12 位。 */
export async function hashInstalledPluginCode(dir: string): Promise<string | undefined> {
  const hash = createHash('sha1')
  let any = false
  for (const name of PLUGIN_CODE_FILES) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    hash.update(name)
    hash.update('\0')
    hash.update(await readFile(file))
    any = true
  }
  return any ? hash.digest('hex').slice(0, 12) : undefined
}

export function storeWebUrl(id: string, version?: string | number) {
  const base = `/api/plugin-store/files/${encodeURIComponent(id)}/web.js`
  // 带上整包代码短哈希（host + web），让前端的「挂载键」随每次重打包变化，
  // 从而触发真正的卸载 + 重新 import；否则前端会一直用最早加载的模块实例。
  return version === undefined ? base : `${base}?v=${encodeURIComponent(String(version))}`
}

export function defaultPluginDir() {
  return process.env.BIU_PLUGIN_DIR || join(process.cwd(), '.plugin')
}

export function defaultSandboxDir() {
  return process.env.BIU_PLUGIN_DEV_DIR || join(process.cwd(), '.plugin-dev')
}

export function defaultStatePath() {
  return process.env.BIU_PLUGIN_STATE || join(process.cwd(), '.plugin', 'store.json')
}

function isSafeId(id: string) {
  return /^[a-z][a-z0-9-]{1,40}$/.test(id)
}

/** 用分隔符判断，避免 `.plugin` 误匹配 `.plugin-dev`。 */
export function isPathInside(root: string, dir: string) {
  const base = resolve(root)
  const target = resolve(dir)
  return target === base || target.startsWith(`${base}${sep}`)
}

function importHostModule(code: string) {
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`)
}

async function importHostFile(hostFile: string) {
  try {
    return await import(`${pathToFileURL(hostFile).href}?t=${Date.now()}`)
  } catch {
    return importHostModule(await readFile(hostFile, 'utf8'))
  }
}

export { listingCreatedAt } from './plugin-create.ts'

async function pluginDirStats(dir: string): Promise<Pick<StoreListing, 'bytes' | 'updatedAt' | 'hasHost' | 'hasWeb'>> {
  const names = await readdir(dir)
  let bytes = 0
  let updatedAt = 0
  for (const name of names) {
    const file = join(dir, name)
    const st = await stat(file)
    if (!st.isFile()) continue
    bytes += st.size
    const modified = Math.floor(st.mtimeMs)
    if (modified > updatedAt) updatedAt = modified
  }
  return {
    bytes,
    updatedAt,
    hasHost: existsSync(join(dir, 'host.js')),
    hasWeb: existsSync(join(dir, 'web.js')),
  }
}

async function readManifest(dir: string): Promise<StoreManifest> {
  try {
    return await persistStoreManifestCreatedAt(dir)
  } catch {
    throw new Error(`invalid plugin manifest in ${dir}`)
  }
}

type StoreState = { enabled: string[]; lastRunAt: Record<string, number> }

function emptyState(): StoreState {
  return { enabled: [], lastRunAt: {} }
}

function parseState(raw: unknown): StoreState {
  if (!raw || typeof raw !== 'object') return emptyState()
  const enabled = (raw as { enabled?: unknown }).enabled
  const lastRaw = (raw as { lastRunAt?: unknown }).lastRunAt
  const lastRunAt: Record<string, number> = {}
  if (lastRaw && typeof lastRaw === 'object') {
    for (const [id, ts] of Object.entries(lastRaw as Record<string, unknown>)) {
      const n = Number(ts)
      if (/^[a-z][a-z0-9-]{1,40}$/.test(id) && Number.isFinite(n) && n > 0) lastRunAt[id] = Math.floor(n)
    }
  }
  if (!Array.isArray(enabled)) return { enabled: [], lastRunAt }
  return {
    enabled: [...new Set(enabled.map((id) => String(id)).filter((id) => /^[a-z][a-z0-9-]{1,40}$/.test(id)))].sort(),
    lastRunAt,
  }
}

export class PluginStoreService extends Service {
  private state: StoreState = emptyState()
  private listCache: StoreListing[] | null = null

  constructor(
    ctx: Context,
    readonly pluginDir: string,
    private readonly statePath: string,
    readonly sandboxDir: string = defaultSandboxDir(),
  ) {
    super(ctx, 'pluginStore')
  }

  open() {
    mkdirSync(dirname(this.statePath), { recursive: true })
    this.state = this.readState()
    return this
  }

  private hub(): StoreHub {
    return this.ctx.hub as unknown as StoreHub
  }

  private readState(): StoreState {
    if (!existsSync(this.statePath)) return emptyState()
    try {
      return parseState(JSON.parse(readFileSync(this.statePath, 'utf8')))
    } catch {
      return emptyState()
    }
  }

  private writeState() {
    this.invalidateList()
    mkdirSync(dirname(this.statePath), { recursive: true })
    writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`)
  }

  private invalidateList() {
    this.listCache = null
  }

  private isEnabled(id: string) {
    return this.state.enabled.includes(id)
  }

  private setEnabled(id: string, enabled: boolean) {
    const next = new Set(this.state.enabled)
    if (enabled) next.add(id)
    else next.delete(id)
    this.state = { enabled: [...next].sort(), lastRunAt: this.state.lastRunAt }
    this.writeState()
  }

  private touchLastRun(id: string) {
    this.state = { ...this.state, lastRunAt: { ...this.state.lastRunAt, [id]: Date.now() } }
    this.writeState()
  }

  pluginPath(id: string) {
    return join(this.pluginDir, id)
  }

  sandboxPath(id: string) {
    return join(this.sandboxDir, id)
  }

  /** 在 .plugin-dev/<id>/ 开沙箱，不写入已安装目录。 */
  async initSandbox(input: PluginCreateInput) {
    const id = String(input.id ?? '').trim()
    const name = String(input.name ?? '').trim()
    if (!isSafeId(id)) throw new Error(`invalid plugin id: ${id}`)
    if (!name) throw new Error('plugin name required')
    const dest = this.sandboxPath(id)
    mkdirSync(dest, { recursive: true })
    const hostJs = String(input.hostJs ?? '').trim()
    const webSrc = input.webJs != null ? String(input.webJs).trim() : ''
    const hasWeb = Boolean(webSrc) || Boolean(findEntry(dest, WEB_ENTRIES))
    const existing = existsSync(join(dest, 'manifest.json')) ? await readManifest(dest).catch(() => undefined) : undefined
    requireDeclaredShell(input.shell, hasWeb, 'sandbox', Boolean(input.headless) || Boolean(existing?.headless))
    const manifest = buildStoreManifest(input, existing)
    await writeFile(join(dest, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    if (hostJs) await writeFile(join(dest, 'host.ts'), hostJs.endsWith('\n') ? hostJs : `${hostJs}\n`)
    if (webSrc) await writeFile(join(dest, 'web.tsx'), webSrc.endsWith('\n') ? webSrc : `${webSrc}\n`)
    await this.ensureReadme(dest, manifest.name, manifest.blurb)
    return { id, sandboxPath: dest }
  }

  /** 把沙箱 bundle 进 .plugin/<id>/。 */
  async pack(id: string) {
    if (!isSafeId(id)) throw new Error(`invalid plugin id: ${id}`)
    const sandbox = this.sandboxPath(id)
    if (!existsSync(join(sandbox, 'manifest.json'))) throw new Error(`sandbox not found: ${sandbox}`)
    const manifest = await persistStoreManifestCreatedAt(sandbox)
    const raw = JSON.parse(await readFile(join(sandbox, 'manifest.json'), 'utf8')) as unknown
    const hostEntry = findEntry(sandbox, HOST_ENTRIES)
    const webEntry = findEntry(sandbox, WEB_ENTRIES)
    if (!hostEntry && !webEntry) throw new Error('sandbox needs host.ts/js or web.tsx/ts/js')
    requireDeclaredShell(
      raw && typeof raw === 'object' ? (raw as { shell?: unknown }).shell : undefined,
      Boolean(webEntry),
      'pack',
      Boolean(manifest.headless),
    )
    this.invalidateList()
    const dest = this.pluginPath(manifest.id)
    mkdirSync(dest, { recursive: true })
    await writeFile(join(dest, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    if (hostEntry) await writeFile(join(dest, 'host.js'), await bundleStoreEntry(hostEntry, 'host'))
    else if (existsSync(join(dest, 'host.js'))) await rm(join(dest, 'host.js'))
    if (webEntry) await writeFile(join(dest, 'web.js'), await bundleStoreEntry(webEntry, 'web'))
    else if (existsSync(join(dest, 'web.js'))) await rm(join(dest, 'web.js'))
    const sandboxReadme = join(sandbox, README_FILE)
    if (existsSync(sandboxReadme)) await writeFile(join(dest, README_FILE), await readFile(sandboxReadme))
    else await this.ensureReadme(dest, manifest.name, manifest.blurb)
    // 运行中才重新挂载（保持原有语义）；停止状态下的重载请用 reload。
    if (this.isEnabled(manifest.id)) await this.mountFromDisk(manifest, dest)
    return { id: manifest.id, sandboxPath: sandbox, pluginPath: dest }
  }

  async listSandboxes() {
    const names = existsSync(this.sandboxDir) ? await readdir(this.sandboxDir) : []
    const items: Array<{
      id: string
      name: string
      blurb: string
      tags: string[]
      author: string
      authorUrl: string
      hasHost: boolean
      hasWeb: boolean
      headless?: boolean
      createdAt: number
      updatedAt: number
    }> = []
    for (const name of names.sort()) {
      const dir = join(this.sandboxDir, name)
      if (!(await stat(dir)).isDirectory()) continue
      if (!existsSync(join(dir, 'manifest.json'))) continue
      const manifest = await readManifest(dir)
      const stats = await pluginDirStats(dir)
      items.push({
        id: manifest.id,
        name: manifest.name,
        blurb: manifest.blurb,
        tags: manifest.tags,
        author: manifest.author,
        authorUrl: manifest.authorUrl,
        hasHost: Boolean(findEntry(dir, HOST_ENTRIES)),
        hasWeb: Boolean(findEntry(dir, WEB_ENTRIES)),
        ...(manifest.headless ? { headless: true } : {}),
        createdAt: listingCreatedAt(manifest.createdAt),
        updatedAt: stats.updatedAt,
      })
    }
    return items
  }

  async list(): Promise<StoreListing[]> {
    if (this.listCache) return this.listCache
    const names = existsSync(this.pluginDir) ? await readdir(this.pluginDir) : []
    const running = new Set(
      this.hub()
        .snapshot()
        .plugins.filter((row) => row.enabled || row.state === 'active')
        .map((row) => row.id),
    )
    const items: StoreListing[] = []
    for (const name of names.sort()) {
      const dir = join(this.pluginDir, name)
      if (!(await stat(dir)).isDirectory()) continue
      if (!existsSync(join(dir, 'manifest.json'))) continue
      const manifest = await readManifest(dir)
      const enabled = this.isEnabled(manifest.id)
      const stats = await pluginDirStats(dir)
      const codeVersion = await hashInstalledPluginCode(dir)
      items.push({
        ...manifest,
        enabled,
        running: running.has(manifest.id),
        bytes: stats.bytes,
        createdAt: listingCreatedAt(manifest.createdAt),
        updatedAt: stats.updatedAt,
        lastRunAt: this.state.lastRunAt[manifest.id] ?? null,
        hasHost: stats.hasHost,
        hasWeb: stats.hasWeb,
        ...(codeVersion ? { codeVersion } : {}),
        ...(manifest.headless ? { headless: true } : { shell: parseStoreShell(manifest.shell) }),
      })
    }
    this.listCache = items
    return items
  }

  async openPlugin(id: string) {
    if (!isSafeId(id)) throw new Error(`invalid plugin id: ${id}`)
    const hit = await this.findPluginDir(id)
    if (!hit) throw new Error(`unknown store plugin: ${id}`)
    const manifest = await readManifest(hit)
    this.setEnabled(manifest.id, true)
    this.touchLastRun(manifest.id)
    await this.mountFromDisk(manifest, hit)
    this.invalidateList()
    return (await this.list()).find((item) => item.id === manifest.id)
  }

  /**
   * 重载：重新挂载已安装的插件，让 snapshot 里的 web 入口带上最新内容 hash，
   * 前端据此 dispose 旧模块并重新 import —— 改完代码即可生效，无需反复 start。
   */
  async reload(id: string) {
    if (!isSafeId(id)) throw new Error(`invalid plugin id: ${id}`)
    const hit = await this.findPluginDir(id)
    if (!hit) throw new Error(`unknown store plugin: ${id}`)
    const manifest = await readManifest(hit)
    await this.mountFromDisk(manifest, hit)
    this.invalidateList()
    return (await this.list()).find((item) => item.id === manifest.id)
  }

  /** 关闭：停运行，.plugin 代码留着。 */
  async close(id: string) {
    if (!isSafeId(id)) throw new Error(`invalid plugin id: ${id}`)
    await this.hub().drop(id)
    this.setEnabled(id, false)
    this.invalidateList()
  }

  /** 卸载：停运行，只删 .plugin/<id>/，不动 .plugin-dev。 */
  async uninstall(id: string) {
    if (!isSafeId(id)) throw new Error(`invalid plugin id: ${id}`)
    await this.hub().drop(id)
    this.setEnabled(id, false)
    const dest = this.pluginPath(id)
    if (isPathInside(this.pluginDir, dest) && !isPathInside(this.sandboxDir, dest) && existsSync(dest)) {
      await rm(dest, { recursive: true, force: true })
    }
    this.invalidateList()
    const lastRunAt = { ...this.state.lastRunAt }
    delete lastRunAt[id]
    this.state = { ...this.state, lastRunAt }
    this.writeState()
  }

  private readmeDir(id: string) {
    const sandbox = this.sandboxPath(id)
    if (existsSync(join(sandbox, 'manifest.json'))) return sandbox
    const installed = this.pluginPath(id)
    if (existsSync(join(installed, 'manifest.json'))) return installed
    return null
  }

  private async ensureReadme(dir: string, name: string, blurb: string) {
    const path = join(dir, README_FILE)
    if (existsSync(path)) return
    const body = `# ${name}\n\n${blurb.trim()}\n`
    await writeFile(path, body)
  }

  async readReadme(id: string) {
    const dir = this.readmeDir(id)
    if (!dir) return ''
    const path = join(dir, README_FILE)
    if (!existsSync(path)) return ''
    return readFile(path, 'utf8')
  }

  async writeReadme(id: string, markdown: string) {
    const dir = this.readmeDir(id)
    if (!dir) throw new Error(`unknown plugin: ${id}`)
    await writeFile(join(dir, README_FILE), String(markdown ?? ''))
    this.invalidateList()
  }

  async restore() {
    for (const id of this.state.enabled) {
      const hit = await this.findPluginDir(id)
      if (!hit) continue
      try {
        await this.mountFromDisk(await readManifest(hit), hit)
      } catch (error) {
        this.ctx.logger('core-plugin-system').error(error)
      }
    }
  }

  async readInstalledFile(id: string, file: string) {
    if (!isSafeId(id) || !ALLOWED_FILES.has(file)) throw new Error('not found')
    if (!this.isEnabled(id)) throw new Error('not found')
    const hit = await this.findPluginDir(id)
    if (!hit) throw new Error('not found')
    const path = join(hit, file)
    if (!existsSync(path)) throw new Error('not found')
    return readFile(path, 'utf8')
  }

  private async findPluginDir(id: string) {
    if (!existsSync(this.pluginDir)) return null
    const guess = this.pluginPath(id)
    if (existsSync(join(guess, 'manifest.json'))) return guess
    for (const name of await readdir(this.pluginDir)) {
      const dir = join(this.pluginDir, name)
      if (!(await stat(dir)).isDirectory()) continue
      if (!existsSync(join(dir, 'manifest.json'))) continue
      const manifest = await readManifest(dir)
      if (manifest.id === id) return dir
    }
    return null
  }

  private async mountFromDisk(manifest: StoreManifest, dir: string) {
    const hostFile = join(dir, 'host.js')
    const webFile = join(dir, 'web.js')
    const hostCode = existsSync(hostFile) ? (await readFile(hostFile, 'utf8')).trim() : ''
    const hasWeb = existsSync(webFile)
    const codeVersion = await hashInstalledPluginCode(dir)
    if (!hostCode && !hasWeb) throw new Error(`plugin ${manifest.id} has neither host nor web`)
    const mod = (hostCode
      ? await importHostFile(hostFile)
      : { name: manifest.id, apply() {} }) as Plugin & { inject?: string[] }
    const entry: CatalogEntry = {
      id: manifest.id,
      name: manifest.name,
      layer: 'capability',
      blurb: manifest.blurb,
      plugin: mod,
      inject: mod.inject,
      togglable: true,
      enabled: true,
      web: hasWeb ? storeWebUrl(manifest.id, codeVersion) : undefined,
      packageName: `store:${manifest.id}`,
    }
    await this.hub().adopt(entry)
  }
}

export async function openStore(ctx: Context) {
  const store = new PluginStoreService(ctx, defaultPluginDir(), defaultStatePath(), defaultSandboxDir()).open()
  try {
    await store.restore()
  } catch (error) {
    ctx.logger('core-plugin-system').error(error)
  }

  ctx.http.route('GET', '/api/plugin-store/files/:id/:file', async (route) => {
    try {
      const body = await store.readInstalledFile(route.params.id, route.params.file)
      const mime = route.params.file.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : 'application/json; charset=utf-8'
      route.res.writeHead(200, {
        'content-type': mime,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      })
      route.res.end(body)
    } catch {
      route.send(404, { error: 'not found' })
    }
  })
  return store
}

declare module 'cordis' {
  interface Context {
    pluginStore: PluginStoreService
  }
}
