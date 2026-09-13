/** @vitest-environment node */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import type { CatalogEntry } from '@biu/host-hub'
import { PluginStoreService, defaultPluginDir, defaultStatePath } from './index.ts'
import { hashInstalledPluginCode } from './store.ts'

function stubHub(ctx: Context) {
  const adopted: string[] = []
  const dropped: string[] = []
  const forks = new Map<string, CatalogEntry>()
  ;(ctx as unknown as { hub: unknown }).hub = {
    async adopt(entry: CatalogEntry) {
      forks.set(entry.id, entry)
      adopted.push(entry.id)
    },
    async drop(id: string) {
      forks.delete(id)
      dropped.push(id)
    },
    snapshot() {
      return {
        plugins: [...forks.values()].map((entry) => ({
          id: entry.id,
          enabled: true,
          state: 'active',
          web: entry.web,
        })),
      }
    },
  }
  return { adopted, dropped, forks }
}

test('default plugin dir is repo-root .plugin, not nested catalog', () => {
  const dir = defaultPluginDir().replace(/\\/g, '/')
  assert.equal(dir.endsWith('/.plugin') || dir.endsWith('.plugin'), true)
  assert.equal(dir.includes('plugin-catalog'), false)
  assert.equal(dir.includes('.biu'), false)
})

test('default store state is .plugin/store.json', () => {
  const path = defaultStatePath().replace(/\\/g, '/')
  assert.ok(path.endsWith('/.plugin/store.json') || path.endsWith('.plugin/store.json'))
})

test('restore skips a broken enabled plugin and continues', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-root-'))
  const pluginDir = join(dir, '.plugin')
  try {
    const ctx = new Context()
    const { adopted } = stubHub(ctx)
    const store = new PluginStoreService(ctx, pluginDir, join(dir, 'store.json'), join(dir, '.plugin-dev')).open()
    await store.initSandbox({
      id: 'store-ok',
      name: 'Ok',
      hostJs: `export const name = 'store-ok'\nexport function apply() {}\n`,
    })
    await store.pack('store-ok')
    await store.openPlugin('store-ok')
    await store.initSandbox({
      id: 'store-bad',
      name: 'Bad',
      hostJs: `export const name = 'store-bad'\nexport function apply() {}\n`,
    })
    await store.pack('store-bad')
    await store.openPlugin('store-bad')
    await writeFile(join(pluginDir, 'store-bad', 'host.js'), 'throw new SyntaxError("nope")\n')
    const ctx2 = new Context()
    const { adopted: restored } = stubHub(ctx2)
    const store2 = new PluginStoreService(ctx2, pluginDir, join(dir, 'store.json'), join(dir, '.plugin-dev')).open()
    await store2.restore()
    assert.ok(restored.includes('store-ok'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('missing .plugin lists no plugins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-root-'))
  try {
    const ctx = new Context()
    stubHub(ctx)
    const store = new PluginStoreService(ctx, join(dir, 'missing'), join(dir, 'store.json'), join(dir, '.plugin-dev')).open()
    assert.deepEqual(await store.list(), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sandbox then pack writes .plugin/<id>/; close keeps code; uninstall deletes .plugin/<id>/', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-root-'))
  const pluginDir = join(dir, '.plugin')
  try {
    const ctx = new Context()
    const { adopted, dropped, forks } = stubHub(ctx)
    const store = new PluginStoreService(ctx, pluginDir, join(dir, 'store.json'), join(dir, '.plugin-dev')).open()
    await store.initSandbox({
      id: 'store-echo',
      name: 'Echo',
      hostJs: `export const name = 'store-echo'\nexport function apply() {}\n`,
    })
    const created = await store.pack('store-echo')
    assert.equal(created.pluginPath, join(pluginDir, 'store-echo'))
    const echo = (await store.list()).find((item) => item.id === 'store-echo')
    assert.ok(echo)
    assert.equal(echo.enabled, false)

    const opened = await store.openPlugin('store-echo')
    assert.equal(opened?.enabled, true)
    const saved = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8')) as { enabled: string[] }
    assert.deepEqual(saved.enabled, ['store-echo'])
    assert.deepEqual(adopted, ['store-echo'])
    assert.equal(forks.get('store-echo')?.packageName, 'store:store-echo')
    assert.equal(forks.get('store-echo')?.web, undefined)
    assert.match(await store.readInstalledFile('store-echo', 'host.js'), /store-echo/)

    await store.close('store-echo')
    assert.deepEqual(dropped, ['store-echo'])
    assert.equal((await store.list()).find((item) => item.id === 'store-echo')?.enabled, false)
    await access(join(pluginDir, 'store-echo', 'host.js'))

    await store.uninstall('store-echo')
    assert.equal((await store.list()).find((item) => item.id === 'store-echo'), undefined)
    await assert.rejects(() => access(join(pluginDir, 'store-echo', 'host.js')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('uninstall deletes .plugin/<id>/ and leaves .plugin-dev/<id>/', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-root-'))
  const pluginDir = join(dir, '.plugin')
  const sandboxDir = join(dir, '.plugin-dev')
  try {
    const ctx = new Context()
    stubHub(ctx)
    const store = new PluginStoreService(ctx, pluginDir, join(dir, 'store.json'), sandboxDir).open()
    await store.initSandbox({
      id: 'store-keep-src',
      name: 'Keep src',
      hostJs: `export const name = 'store-keep-src'\nexport function apply() {}\n`,
    })
    await store.pack('store-keep-src')
    await access(join(pluginDir, 'store-keep-src', 'host.js'))
    await access(join(sandboxDir, 'store-keep-src', 'host.ts'))
    await store.uninstall('store-keep-src')
    await assert.rejects(() => access(join(pluginDir, 'store-keep-src', 'host.js')))
    await access(join(sandboxDir, 'store-keep-src', 'host.ts'))
    await access(join(sandboxDir, 'store-keep-src', 'manifest.json'))
    const row = (await store.listSandboxes()).find((item) => item.id === 'store-keep-src')
    assert.ok(row)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('web-only plugin opens without host.js', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-root-'))
  try {
    const ctx = new Context()
    const { forks } = stubHub(ctx)
    const store = new PluginStoreService(ctx, join(dir, '.plugin'), join(dir, 'store.json'), join(dir, '.plugin-dev')).open()
    await store.initSandbox({
      id: 'store-banner',
      name: 'Banner',
      shell: { width: 360, height: 240 },
      webJs: `export const name = 'store-banner-web'\nexport const inject = ['slots']\nexport function apply() {}\n`,
    })
    await assert.rejects(() => store.pack('store-empty'), /sandbox not found/)
    await store.pack('store-banner')
    const sandboxes = await store.listSandboxes()
    assert.equal(sandboxes.find((row) => row.id === 'store-banner')?.hasWeb, true)
    await store.openPlugin('store-banner')
    const listed = (await store.list()).find((row) => row.id === 'store-banner')
    assert.ok(listed?.codeVersion)
    assert.match(listed.codeVersion, /^[0-9a-f]{12}$/)
    // web 入口会带上整包代码 hash（host + web），用于让前端在重打包后重新加载。
    assert.equal(
      forks.get('store-banner')?.web,
      `/api/plugin-store/files/store-banner/web.js?v=${listed.codeVersion}`,
    )
    assert.equal(listed.codeVersion, await hashInstalledPluginCode(join(dir, '.plugin', 'store-banner')))
    await assert.rejects(() => store.readInstalledFile('store-banner', 'host.js'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('codeVersion hashes host.js and web.js together', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-root-'))
  try {
    const ctx = new Context()
    stubHub(ctx)
    const pluginDir = join(dir, '.plugin')
    const store = new PluginStoreService(ctx, pluginDir, join(dir, 'store.json'), join(dir, '.plugin-dev')).open()
    await store.initSandbox({
      id: 'store-both',
      name: 'Both',
      shell: { width: 360, height: 240 },
      hostJs: `export const name = 'store-both'\nexport function apply() {}\n`,
      webJs: `export const name = 'store-both-web'\nexport const inject = ['slots']\nexport function apply() {}\n`,
    })
    await store.pack('store-both')
    const packed = join(pluginDir, 'store-both')
    const before = await hashInstalledPluginCode(packed)
    const listed = (await store.list()).find((row) => row.id === 'store-both')
    assert.equal(listed?.codeVersion, before)
    assert.ok(listed?.hasHost)
    assert.ok(listed?.hasWeb)
    await writeFile(join(packed, 'host.js'), `export const name = 'store-both'\nexport function apply() { return 1 }\n`)
    const afterHost = await hashInstalledPluginCode(packed)
    assert.notEqual(afterHost, before)
    await writeFile(join(packed, 'web.js'), `export const name = 'store-both-web'\nexport function apply() { return 2 }\n`)
    const afterWeb = await hashInstalledPluginCode(packed)
    assert.notEqual(afterWeb, afterHost)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
