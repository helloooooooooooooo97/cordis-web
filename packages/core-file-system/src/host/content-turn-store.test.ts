import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ContentTurnStore } from './content-turn-store.ts'

test('content turn store keeps first before and latest after', () => {
  const store = new ContentTurnStore().open(':memory:')
  store.record({ sessionId: 's1', turn: 1, path: '/pages/p1', title: '首页', before: 'old\n', after: 'old\nmid\n' })
  store.record({ sessionId: 's1', turn: 1, path: '/pages/p1', title: '首页', before: 'old\nmid\n', after: 'old\nmid\nend\n' })
  const sum = store.summaries('s1', 1)
  assert.equal(sum.length, 1)
  assert.equal(sum[0]?.added, 2)
  assert.equal(sum[0]?.removed, 0)
})

test('five pages that all write 你好 still produce five summary rows', () => {
  const store = new ContentTurnStore().open(':memory:')
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) {
    store.record({ sessionId: 's1', turn: 2, path: `/pages/${id}`, title: '你好', before: '', after: '你好' })
  }
  const sum = store.summaries('s1', 2)
  assert.equal(sum.length, 5)
  assert.deepEqual(
    sum.map((row) => row.path),
    ['/pages/p1', '/pages/p2', '/pages/p3', '/pages/p4', '/pages/p5'],
  )
  for (const row of sum) {
    assert.equal(row.title, '你好')
    assert.equal(row.added, 1)
    assert.equal(row.removed, 1)
  }
})

test('trailing newline counts as a line, not extra characters', () => {
  const store = new ContentTurnStore().open(':memory:')
  store.record({ sessionId: 's1', turn: 4, path: '/pages/p', title: '你好', before: '', after: '你好\n' })
  const sum = store.summaries('s1', 4)
  assert.equal(sum[0]?.added, 1)
  assert.equal(sum[0]?.removed, 0)
})

test('snapshot returns before/after without putting them on summaries', () => {
  const store = new ContentTurnStore().open(':memory:')
  store.record({ sessionId: 's1', turn: 5, path: '/pages/p', title: '你好', before: '旧\n', after: '你好\n' })
  const snap = store.snapshot('s1', 5, '/pages/p')
  assert.equal(snap?.before, '旧\n')
  assert.equal(snap?.after, '你好\n')
  assert.equal(store.summaries('s1', 5)[0]?.added, 1)
})

test('summaries count lines and omit create ops', () => {
  const store = new ContentTurnStore().open(':memory:')
  store.recordOp('s1', 3, { op: 'create', path: '/pages/a', title: '你好' })
  store.recordOp('s1', 3, { op: 'create', path: '/pages/b', title: '你好' })
  store.record({ sessionId: 's1', turn: 3, path: '/pages/a', title: '你好', before: '', after: '你好' })
  const sum = store.summaries('s1', 3)
  assert.equal(sum.length, 1)
  assert.equal(sum[0]?.path, '/pages/a')
  assert.equal(sum[0]?.added, 1)
  assert.equal(sum[0]?.removed, 1)
  assert.equal(sum.filter((row) => row.kind === 'create').length, 0)
})
