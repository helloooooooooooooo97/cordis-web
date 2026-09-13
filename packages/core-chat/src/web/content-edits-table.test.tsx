import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CONTENT_JUMP_EVENT } from '@biu/type-file-system'
import { ChatNodeList } from './thread.tsx'
import {
  INSPECTOR_REVEAL_EVENT,
  addedJumpFromSnapshot,
  compactEqualLines,
  contentEditLabel,
  numberDiffLines,
  revealContentEdit,
  type ContentEditRow,
} from './content-edits-table.tsx'
import type { ChatNode } from '@biu/web-session-view'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function helloPages(): ContentEditRow[] {
  return [1, 2, 3, 4, 5].map((n) => ({
    path: `/pages/p${n}`,
    title: '你好',
    added: 1,
    removed: 0,
    jump_line: 1,
  }))
}

describe('contentEditLabel', () => {
  it('keeps a unique title as-is', () => {
    expect(contentEditLabel({ path: '/pages/home', title: '首页', added: 1, removed: 0, jump_line: 1 }, helloPages().slice(0, 1))).toBe(
      '首页',
    )
  })

  it('disambiguates five pages that all share the title 你好', () => {
    const files = helloPages()
    expect(files.map((file) => contentEditLabel(file, files))).toEqual([
      '你好 · p1',
      '你好 · p2',
      '你好 · p3',
      '你好 · p4',
      '你好 · p5',
    ])
  })
})

describe('addedJumpFromSnapshot', () => {
  it('covers the whole added markdown, not the first line only', () => {
    expect(addedJumpFromSnapshot('', '# 标题\n\n第一段\n\n第二段')).toEqual({
      start_line: 1,
      end_line: 5,
      text: '# 标题\n\n第一段\n\n第二段',
    })
  })
})

describe('revealContentEdit', () => {
  it('opens the record in the right inspector and jumps, without navigating the chat route', () => {
    const seen: Array<{ type: string; detail: unknown }> = []
    const onReveal = (event: Event) => seen.push({ type: event.type, detail: (event as CustomEvent).detail })
    const onJump = (event: Event) => seen.push({ type: event.type, detail: (event as CustomEvent).detail })
    window.addEventListener(INSPECTOR_REVEAL_EVENT, onReveal)
    window.addEventListener(CONTENT_JUMP_EVENT, onJump)
    const href = window.location.href
    revealContentEdit('/pages/p3', 1)
    expect(window.location.href).toBe(href)
    expect(seen).toEqual([
      { type: INSPECTOR_REVEAL_EVENT, detail: { collection: '/pages', recordId: 'p3', unique: true } },
      { type: CONTENT_JUMP_EVENT, detail: { path: '/pages/p3', start_line: 1, end_line: 1, navigate: true } },
    ])
    window.removeEventListener(INSPECTOR_REVEAL_EVENT, onReveal)
    window.removeEventListener(CONTENT_JUMP_EVENT, onJump)
  })
})

describe('ContentEditsTable', () => {
  it('renders under the reply without a revert control', () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    const nodes: ChatNode[] = [
      { id: 'u-1', kind: 'user', text: '改首页' },
      {
        id: 'r-1',
        kind: 'reply',
        copyText: '改好了',
        turn: 3,
        parts: [{ id: 'a-1', kind: 'assistant', text: '改好了' }],
        contentEdits: [{ path: '/pages/home', title: '首页', added: 4, removed: 1, jump_line: 8 }],
      },
    ]
    render(<ChatNodeList nodes={nodes} sessionId="sess-1" onInspect={() => undefined} onFork={() => undefined} />)
    expect(screen.getByTestId('content-edits-table')).toBeTruthy()
    expect(screen.getByText('数据改动')).toBeTruthy()
    expect(screen.getByText('首页')).toBeTruthy()
    expect(screen.queryByLabelText('撤销 首页')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hides create rows and only lists content line edits', () => {
    const nodes: ChatNode[] = [
      { id: 'u-1', kind: 'user', text: '建页' },
      {
        id: 'r-1',
        kind: 'reply',
        copyText: '好了',
        turn: 1,
        parts: [{ id: 'a-1', kind: 'assistant', text: '好了' }],
        contentEdits: [
          { path: '/pages/new', title: '新页', added: 0, removed: 0, jump_line: 1, kind: 'create' },
          { path: '/pages/home', title: '首页', added: 12, removed: 3, jump_line: 2, kind: 'content' },
        ],
      },
    ]
    render(<ChatNodeList nodes={nodes} sessionId="sess-hide" onInspect={() => undefined} onFork={() => undefined} />)
    expect(screen.queryByText(/新建/)).toBeNull()
    expect(screen.getByText('首页')).toBeTruthy()
    expect(screen.getAllByText('+12').length).toBeGreaterThan(0)
    expect(screen.getAllByText('−3').length).toBeGreaterThan(0)
  })

  it('lists all five 你好 pages as separate rows and reveals the clicked one in the inspector', async () => {
    const seen: unknown[] = []
    const jumps: unknown[] = []
    const onReveal = (event: Event) => seen.push((event as CustomEvent).detail)
    const onJump = (event: Event) => jumps.push((event as CustomEvent).detail)
    window.addEventListener(INSPECTOR_REVEAL_EVENT, onReveal)
    window.addEventListener(CONTENT_JUMP_EVENT, onJump)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/content-turns/file')) {
        return { ok: true, json: async () => ({ before: '', after: '你好\n' }) }
      }
      return { ok: true, json: async () => ({}) }
    })
    const href = window.location.href
    const nodes: ChatNode[] = [
      { id: 'u-1', kind: 'user', text: '五页都写你好' },
      {
        id: 'r-1',
        kind: 'reply',
        copyText: '写好了',
        turn: 4,
        parts: [{ id: 'a-1', kind: 'assistant', text: '写好了' }],
        contentEdits: helloPages(),
      },
    ]
    render(<ChatNodeList nodes={nodes} sessionId="sess-2" onInspect={() => undefined} onFork={() => undefined} />)
    const table = screen.getByTestId('content-edits-table')
    expect(table.querySelectorAll('li')).toHaveLength(5)
    expect(screen.getByText('你好 · p1')).toBeTruthy()
    expect(screen.getByText('你好 · p5')).toBeTruthy()
    fireEvent.click(screen.getByText('你好 · p4'))
    expect(window.location.href).toBe(href)
    expect(seen).toEqual([{ collection: '/pages', recordId: 'p4', unique: true }])
    await waitFor(() =>
      expect(jumps).toEqual([
        { path: '/pages/p4', start_line: 1, end_line: 1, navigate: true, text: '你好\n' },
      ]),
    )
    window.removeEventListener(INSPECTOR_REVEAL_EVENT, onReveal)
    window.removeEventListener(CONTENT_JUMP_EVENT, onJump)
  })

  it('loads a file diff from content-turns when the row chevron is opened', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/content-turns/file')) {
        return {
          ok: true,
          json: async () => ({ before: 'keep\na\nkeep2\n', after: 'keep\nb\nkeep2\n' }),
        }
      }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const nodes: ChatNode[] = [
      { id: 'u-1', kind: 'user', text: '改' },
      {
        id: 'r-1',
        kind: 'reply',
        copyText: '好了',
        turn: 7,
        parts: [{ id: 'a-1', kind: 'assistant', text: '好了' }],
        contentEdits: [{ path: '/pages/home', title: '首页', added: 1, removed: 1, jump_line: 2 }],
      },
    ]
    render(<ChatNodeList nodes={nodes} sessionId="sess-diff" onInspect={() => undefined} onFork={() => undefined} />)
    fireEvent.click(screen.getByLabelText('查看 首页 的 diff'))
    await waitFor(() => expect(screen.getByTestId('content-edit-diff')).toBeTruthy())
    expect(screen.getByTestId('content-edit-diff').textContent).toContain('a')
    expect(screen.getByTestId('content-edit-diff').textContent).toContain('b')
    const diff = screen.getByTestId('content-edit-diff')
    expect(diff.querySelector('[data-old-line="2"]')?.textContent).toContain('a')
    expect(diff.querySelector('[data-new-line="2"]')?.textContent).toContain('b')
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('session=sess-diff') && String(call[0]).includes('turn=7'))).toBe(true)
  })
})

describe('numberDiffLines', () => {
  it('tags add and remove with source line numbers', () => {
    const rows = numberDiffLines([
      { type: 'equal', text: 'keep' },
      { type: 'remove', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'equal', text: 'keep2' },
    ])
    expect(rows[1]).toMatchObject({ type: 'remove', oldLine: 2 })
    expect(rows[2]).toMatchObject({ type: 'add', newLine: 2 })
    expect(rows[3]).toMatchObject({ type: 'equal', oldLine: 3, newLine: 3 })
  })
})

describe('compactEqualLines', () => {
  it('keeps unchanged lines next to edits and skips the rest', () => {
    const rows = compactEqualLines(
      [
        { type: 'equal', text: '1' },
        { type: 'equal', text: '2' },
        { type: 'equal', text: '3' },
        { type: 'equal', text: '4' },
        { type: 'equal', text: '5' },
        { type: 'add', text: 'x' },
        { type: 'equal', text: '6' },
        { type: 'equal', text: '7' },
        { type: 'equal', text: '8' },
        { type: 'equal', text: '9' },
        { type: 'equal', text: '10' },
      ],
      2,
      3,
    )
    expect(rows.some((row) => row.type === 'skip')).toBe(true)
    expect(rows.some((row) => row.type === 'add' && row.text === 'x')).toBe(true)
  })
})

