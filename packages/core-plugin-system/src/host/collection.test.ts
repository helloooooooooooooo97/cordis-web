import { test } from 'vitest'
import assert from 'node:assert/strict'
import type { DbRecord } from '@biu/type-file-system'
import { pluginsCollection } from './collection.ts'
import type { PluginStoreService } from './store.ts'
import { defaultStoreShell } from '../shell.ts'

function stubStore(partial: Partial<PluginStoreService>): PluginStoreService {
  return {
    list: () => Promise.resolve([]),
    listSandboxes: () => Promise.resolve([]),
    readReadme: async () => '',
    writeReadme: async () => {},
    openPlugin() {},
    close() {},
    pack() {},
    uninstall() {},
    ...partial,
  } as PluginStoreService
}

test('pluginsCollection lists installed plugins and sandboxes in one table', async () => {
  const items: DbRecord[] = [{ id: 'demo', name: 'Demo', enabled: false }]
  const calls: string[] = []
  const spec = pluginsCollection(stubStore({
    list: () =>
      Promise.resolve([
        {
          id: 'demo',
          name: 'Demo',
          blurb: 'hi',
          tags: ['lab'],
          author: 'ann',
          authorUrl: '',
          enabled: false,
          running: false,
          bytes: 12,
          createdAt: 1,
          updatedAt: 2,
          lastRunAt: null,
          hasHost: true,
          hasWeb: true,
          codeVersion: 'abc123def456',
          shell: defaultStoreShell(),
        },
      ]),
    listSandboxes: () =>
      Promise.resolve([
        {
          id: 'draft-hello',
          name: 'Hello',
          blurb: '',
          tags: [],
          author: '',
          authorUrl: '',
          hasHost: true,
          hasWeb: false,
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
    openPlugin(id: string) {
      calls.push(`open:${id}`)
      items[0]!.enabled = true
    },
    close(id: string) {
      calls.push(`close:${id}`)
      items[0]!.enabled = false
    },
    pack(id: string) {
      calls.push(`pack:${id}`)
    },
    uninstall(id: string) {
      calls.push(`uninstall:${id}`)
    },
  }))
  assert.equal(spec.path, '/plugins')
  assert.equal(spec.view?.moduleId, 'plugins')
  const listed = await spec.list()
  const demo = listed.find((row) => row.id === 'demo')
  const draft = listed.find((row) => row.id === 'draft-hello')
  assert.equal(demo?.installed, true)
  assert.equal(demo?.sandbox, undefined)
  assert.equal(demo?.shellWidth, defaultStoreShell().width)
  assert.equal(demo?.hasWeb, true)
  assert.equal(demo?.codeVersion, 'abc123def456')
  assert.equal(demo?.headless, undefined)
  assert.equal(draft?.sandbox, true)
  assert.equal(draft?.installed, undefined)
  assert.equal(draft?.running, undefined)
  assert.equal(draft?.bytes, undefined)
  assert.equal(draft?.codeVersion, undefined)
  assert.equal(draft?.shellWidth, undefined)
  assert.deepEqual(
    spec.actions?.map((item) => item.id),
    ['sandbox', 'start', 'stop', 'pack', 'reload', 'uninstall'],
  )
  await spec.actions!.find((item) => item.id === 'start')!.run('demo', demo!)
  await spec.actions!.find((item) => item.id === 'pack')!.run('draft-hello', draft!)
  assert.deepEqual(calls, ['open:demo', 'pack:draft-hello'])
  assert.equal(typeof spec.update, 'function')
  assert.equal(spec.schema.contentField, 'readme')
  assert.match(String(spec.view?.blurb ?? ''), /示例写法/)
  assert.match(String(spec.view?.blurb ?? ''), /:::pageBlock/)
  assert.equal(spec.schema.labelField, 'title')
  assert.ok(spec.schema.fields.title)
  assert.equal(spec.schema.fields.name, undefined)
  assert.equal(spec.schema.columns?.[0], 'title')
  assert.deepEqual(spec.records, { update: false, create: false, delete: true })
  assert.equal(typeof spec.remove, 'function')
  assert.ok(spec.schema.columns?.includes('sandbox'))
  assert.ok(spec.schema.columns?.includes('installed'))
  assert.ok(spec.schema.columns?.includes('tags'))
  assert.ok(spec.schema.columns?.includes('codeVersion'))
  assert.equal(spec.schema.fields.codeVersion?.label, '代码版本')
  assert.equal(spec.schema.fields.tags?.writable, true)
  assert.equal(spec.schema.fields.emoji?.writable, true)
  assert.deepEqual(spec.actions?.find((item) => item.id === 'start')?.when, { installed: true, running: false })
  assert.deepEqual(spec.actions?.find((item) => item.id === 'pack')?.when, { sandbox: true })
  assert.deepEqual(spec.actions?.find((item) => item.id === 'uninstall')?.when, { installed: true })
  assert.equal(spec.actions?.find((item) => item.id === 'sandbox')?.for, 'agent')
  assert.equal(spec.actions?.find((item) => item.id === 'start')?.for, undefined)
})

test('headless plugins omit shell columns', async () => {
  const spec = pluginsCollection(stubStore({
    list: () =>
      Promise.resolve([
        {
          id: 'skin',
          name: 'Skin',
          blurb: '',
          tags: [],
          author: '',
          authorUrl: '',
          enabled: true,
          running: true,
          bytes: 8,
          createdAt: 1,
          updatedAt: 2,
          lastRunAt: null,
          hasHost: false,
          hasWeb: true,
          headless: true,
        },
      ]),
    listSandboxes: () => Promise.resolve([]),
    openPlugin() {},
    close() {},
    pack() {},
    uninstall() {},
  }))
  const listed = await spec.list()
  assert.equal(listed[0]?.headless, true)
  assert.equal(listed[0]?.shellWidth, undefined)
  assert.ok(spec.schema.columns?.includes('headless'))
})

test('same id with sandbox and install merges into one row', async () => {
  const spec = pluginsCollection(stubStore({
    list: () =>
      Promise.resolve([
        {
          id: 'echo',
          name: 'Echo',
          blurb: 'packed',
          tags: [],
          author: '',
          authorUrl: '',
          enabled: true,
          running: true,
          bytes: 40,
          createdAt: 1,
          updatedAt: 4,
          lastRunAt: 3,
          hasHost: true,
          hasWeb: false,
          shell: defaultStoreShell(),
        },
      ]),
    listSandboxes: () =>
      Promise.resolve([
        {
          id: 'echo',
          name: 'Echo draft',
          blurb: 'src',
          tags: [],
          author: '',
          authorUrl: '',
          hasHost: true,
          hasWeb: false,
          createdAt: 1,
          updatedAt: 9,
        },
      ]),
    openPlugin() {},
    close() {},
    pack() {},
    uninstall() {},
  }))
  const listed = await spec.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.id, 'echo')
  assert.equal(listed[0]?.installed, true)
  assert.equal(listed[0]?.sandbox, true)
  assert.equal(listed[0]?.running, true)
  assert.equal(listed[0]?.updatedAt, 9)
})

test('plugin intro is README.md via contentField readme', async () => {
  const files = new Map<string, string>()
  const spec = pluginsCollection(
    stubStore({
      list: () =>
        Promise.resolve([
          {
            id: 'demo',
            name: 'Demo',
            blurb: 'hi',
            tags: [],
            author: '',
            authorUrl: '',
            enabled: false,
            running: false,
            bytes: 12,
            createdAt: 1,
            updatedAt: 2,
            lastRunAt: null,
            hasHost: true,
            hasWeb: false,
          },
        ]),
      readReadme: async (id) => files.get(id) ?? '',
      writeReadme: async (id, markdown) => {
        files.set(id, markdown)
      },
    }),
  )
  const row = await spec.get!('demo')
  assert.equal(row?.readme, '')
  const written = await spec.update!('demo', { readme: '# Demo\n\n介绍\n' })
  assert.equal(written.readme, '# Demo\n\n介绍\n')
  assert.equal(files.get('demo'), '# Demo\n\n介绍\n')
  await assert.rejects(() => spec.update!('demo', { name: '改名' }), /not writable/)
})
