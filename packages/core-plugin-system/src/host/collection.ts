import type { CollectionSpec, DbRecord } from '@biu/type-file-system'
import { recordBuiltinValues, REQUIRED_RECORD_FIELDS } from '@biu/type-file-system'
import {
  createArgs,
  PLUGIN_PACK_DESCRIPTION,
  PLUGIN_SANDBOX_DESCRIPTION,
  PLUGIN_SANDBOX_PROPERTIES,
} from './plugin-create.ts'
import type { PluginStoreService, StoreListing } from './store.ts'

type SandboxListing = Awaited<ReturnType<PluginStoreService['listSandboxes']>>[number]

function omitEmpty(row: DbRecord): DbRecord {
  const next: DbRecord = { id: row.id }
  for (const [key, value] of Object.entries(row)) {
    if (key === 'id') continue
    if (value == null || value === '' || value === false) continue
    if (Array.isArray(value) && value.length === 0) continue
    next[key] = value
  }
  return { ...next, ...recordBuiltinValues(row) }
}

function asInstalledRecord(row: StoreListing): DbRecord {
  const shell = row.shell
  return omitEmpty({
    id: row.id,
    name: row.name,
    title: row.name,
    blurb: row.blurb,
    tags: row.tags,
    author: row.author,
    authorUrl: row.authorUrl,
    installed: true,
    enabled: row.enabled,
    running: row.running,
    bytes: row.bytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRunAt: row.lastRunAt,
    hasHost: row.hasHost,
    hasWeb: row.hasWeb,
    codeVersion: row.codeVersion,
    headless: row.headless === true,
    ...(row.headless || !shell
      ? {}
      : {
          shellWidth: shell.width,
          shellHeight: shell.height,
          shellMinWidth: shell.minWidth,
          shellMinHeight: shell.minHeight,
          shellResizable: shell.resizable,
        }),
  })
}

function asSandboxRecord(row: SandboxListing): DbRecord {
  return omitEmpty({
    id: row.id,
    name: row.name,
    title: row.name,
    blurb: row.blurb,
    tags: row.tags,
    author: row.author,
    authorUrl: row.authorUrl,
    sandbox: true,
    hasHost: row.hasHost,
    hasWeb: row.hasWeb,
    headless: row.headless === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

function mergeLifecycle(installed: StoreListing | undefined, sandbox: SandboxListing | undefined): DbRecord {
  if (installed && sandbox) {
    return omitEmpty({
      ...asInstalledRecord(installed),
      sandbox: true,
      updatedAt: Math.max(installed.updatedAt, sandbox.updatedAt),
    })
  }
  if (installed) return asInstalledRecord(installed)
  if (sandbox) return asSandboxRecord(sandbox)
  throw new Error('empty plugin row')
}

export function pluginsCollection(store: PluginStoreService): CollectionSpec {
  const list = async () => {
    const [installed, sandboxes] = await Promise.all([store.list(), store.listSandboxes()])
    const ids = new Set([...installed.map((row) => row.id), ...sandboxes.map((row) => row.id)])
    const byInstalled = new Map(installed.map((row) => [row.id, row]))
    const bySandbox = new Map(sandboxes.map((row) => [row.id, row]))
    return [...ids]
      .sort()
      .map((id) => mergeLifecycle(byInstalled.get(id), bySandbox.get(id)))
  }
  const find = async (id: string) => {
    const row = (await list()).find((item) => item.id === id) ?? null
    if (!row) return null
    return { ...row, readme: await store.readReadme(id) }
  }
  return {
    id: 'plugins',
    path: '/plugins',
    label: '插件',
    view: {
      moduleId: 'plugins',
      route: '/plugins',
      title: '插件',
      inspector: true,
      blurb: '这是插件（可安装的小程序），不是代理。用户说「再开一个 agent」请去 /sessions db_create，不要在这张表 create。已安装（.plugin）和沙箱（.plugin-dev）同一张表。列表 db_list /plugins。README 用 db_content /plugins/<id>。页面块插件先读介绍里的「示例写法」再写 :::pageBlock。name 等只读（facet/tags 仍可写）。不能 db_create。窗口尺寸看 shellWidth/shellHeight。codeVersion 是已安装 host.js+web.js 的内容短哈希，和加载 URL 的 v 参数相同。安装只能 sandbox 再 pack：先 db_action path=/plugins/<插件id> action=sandbox 建 .plugin-dev/<id>/（记录可以还不存在），写完代码再 action=pack 打进 .plugin。不要直写 .plugin。start=打开已安装插件窗口（when：installed 且未 running）；stop=关掉运行中的插件（when：installed 且 running）；uninstall=删除 .plugin/<id>/（沙箱还在则这行还在）。',
      order: 30,
      icon: 'puzzle-piece',
    },
    records: { update: false, create: false, delete: true },
    schema: {
      labelField: 'title',
      contentField: 'readme',
      columns: [
        'title',
        'blurb',
        'installed',
        'sandbox',
        'running',
        'enabled',
        'tags',
        'author',
        'bytes',
        'shellWidth',
        'shellHeight',
        'hasHost',
        'hasWeb',
        'codeVersion',
        'headless',
      ],
      fields: {
        ...REQUIRED_RECORD_FIELDS,
        title: { type: 'string', label: '标题' },
        blurb: { type: 'string', label: '简介' },
        installed: { type: 'boolean', label: '已安装' },
        sandbox: { type: 'boolean', label: '沙箱' },
        enabled: { type: 'boolean', label: '已打开' },
        running: { type: 'boolean', label: '运行中' },
        tags: { type: 'multi-select', label: '标签', writable: true },
        bytes: { type: 'number', label: '大小' },
        createdAt: { type: 'datetime', label: '创建时间' },
        updatedAt: { type: 'datetime', label: '更新时间' },
        lastRunAt: { type: 'datetime', label: '上次运行' },
        hasHost: { type: 'boolean', label: 'Host' },
        hasWeb: { type: 'boolean', label: 'Web' },
        codeVersion: { type: 'string', label: '代码版本' },
        headless: { type: 'boolean', label: '无头' },
        author: { type: 'string', label: '作者' },
        authorUrl: { type: 'url', label: '作者链接' },
        shellWidth: { type: 'number', label: '窗口宽' },
        shellHeight: { type: 'number', label: '窗口高' },
        shellMinWidth: { type: 'number', label: '最小宽' },
        shellMinHeight: { type: 'number', label: '最小高' },
        shellResizable: { type: 'boolean', label: '可缩放' },
        readme: { type: 'file', label: '介绍', writable: true },
      },
    },
    list,
    get: find,
    update: async (id, patch) => {
      const extra = Object.keys(patch).filter((key) => key !== 'readme')
      if (extra.length) throw new Error(`plugin fields not writable: ${extra.join(', ')}`)
      if ('readme' in patch) await store.writeReadme(id, String(patch.readme ?? ''))
      return (await find(id)) ?? (() => {
        throw new Error(`unknown plugin: ${id}`)
      })()
    },
    remove: async (query) => {
      const ids = query.ids ?? []
      for (const id of ids) await store.uninstall(id)
      return ids
    },
    actions: [
      {
        id: 'sandbox',
        label: '开沙箱',
        for: 'agent',
        placement: [],
        allowMissing: true,
        description: PLUGIN_SANDBOX_DESCRIPTION,
        parameters: {
          type: 'object',
          description: PLUGIN_SANDBOX_DESCRIPTION,
          properties: PLUGIN_SANDBOX_PROPERTIES,
          required: ['name'],
        },
        run: async (id, _record, args = {}) => store.initSandbox(createArgs({ ...args, id })),
      },
      {
        id: 'start',
        label: '运行',
        when: { installed: true, running: false },
        description: '打开已安装插件窗口（无头则只挂 host）。when：installed 且未 running。不要对纯沙箱、未 pack 的行调用。',
        run: async (id) => {
          await store.openPlugin(id)
        },
      },
      {
        id: 'stop',
        label: '停止',
        when: { installed: true, running: true },
        description: '关掉运行中的插件窗口/host。when：installed 且 running。',
        run: async (id) => {
          await store.close(id)
        },
      },
      {
        id: 'pack',
        label: '打包安装',
        when: { sandbox: true },
        description: PLUGIN_PACK_DESCRIPTION,
        parameters: { type: 'object', description: PLUGIN_PACK_DESCRIPTION, properties: {} },
        run: async (id) => store.pack(id),
      },
      {
        id: 'reload',
        label: '重载',
        when: { installed: true },
        description:
          '重新挂载已安装插件，让前端丢弃旧模块并重新加载 web.js —— 改完代码立即生效。' +
          '改动源码后：先 pack，再 reload（比 uninstall + start 更省事，不会中断运行中的窗口太久）。',
        run: async (id) => {
          await store.reload(id)
        },
      },
      {
        id: 'uninstall',
        label: '卸载',
        tone: 'danger',
        confirm: '确定卸载这个插件？已安装的代码会被删掉。',
        when: { installed: true },
        description: '删除 .plugin/<id>/。沙箱 .plugin-dev/<id>/ 还在的话行不会消失，只是 installed 变 false。',
        run: async (id) => {
          await store.uninstall(id)
        },
      },
    ],
  }
}
