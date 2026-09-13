import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { diffLineStats } from './line-diff.ts'

export type ContentTurnFile = {
  path: string
  title: string
  before: string
  after: string
}

export type TurnOp = { op: 'create' | 'update' | 'delete'; path: string; title: string }

export type ContentEditSummary = {
  path: string
  title: string
  added: number
  removed: number
  jump_line: number
  kind?: 'content' | 'create' | 'update' | 'delete'
}

type TurnBucket = {
  files: Record<string, ContentTurnFile>
  ops: TurnOp[]
}

type StoreShape = {
  sessions: Record<string, Record<string, TurnBucket>>
}

const MAX_SESSIONS = 40
const MAX_TURNS = 32

function asBucket(raw: unknown): TurnBucket {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { files: {}, ops: [] }
  const rec = raw as { files?: unknown; ops?: unknown }
  if (rec.files && typeof rec.files === 'object' && !Array.isArray(rec.files)) {
    return {
      files: rec.files as Record<string, ContentTurnFile>,
      ops: Array.isArray(rec.ops) ? (rec.ops as TurnOp[]) : [],
    }
  }
  return { files: raw as Record<string, ContentTurnFile>, ops: [] }
}

export class ContentTurnStore {
  private file = ''
  private data: StoreShape = { sessions: {} }

  open(path: string) {
    this.file = path
    if (path === ':memory:') {
      this.data = { sessions: {} }
      return this
    }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: Record<string, Record<string, unknown>> }
      const sessions: StoreShape['sessions'] = {}
      for (const [sid, turns] of Object.entries(raw?.sessions ?? {})) {
        sessions[sid] = {}
        for (const [turn, bucket] of Object.entries(turns ?? {})) {
          sessions[sid]![turn] = asBucket(bucket)
        }
      }
      this.data = { sessions }
    } catch {
      this.data = { sessions: {} }
    }
    return this
  }

  private bucket(sessionId: string, turn: number) {
    const sid = sessionId.trim()
    if (!sid || !Number.isInteger(turn) || turn < 1) return null
    const turns = (this.data.sessions[sid] ??= {})
    return (turns[String(turn)] ??= { files: {}, ops: [] })
  }

  record(input: { sessionId: string; turn: number; path: string; title: string; before: string; after: string }) {
    const bucket = this.bucket(input.sessionId, input.turn)
    const path = input.path.trim()
    if (!bucket || !path) return
    const prev = bucket.files[path]
    bucket.files[path] = {
      path,
      title: input.title || prev?.title || path,
      before: prev?.before ?? input.before,
      after: input.after,
    }
    this.trim(input.sessionId.trim())
    this.flush()
  }

  recordOp(sessionId: string, turn: number, op: TurnOp) {
    const bucket = this.bucket(sessionId, turn)
    if (!bucket || !op.path.trim()) return
    if (bucket.ops.some((row) => row.op === op.op && row.path === op.path)) return
    bucket.ops.push({ op: op.op, path: op.path, title: op.title })
    this.trim(sessionId.trim())
    this.flush()
  }

  summaries(sessionId: string, turn: number): ContentEditSummary[] {
    return this.listFiles(sessionId, turn)
      .map((row) => {
        const stats = diffLineStats(row.before, row.after)
        return {
          path: row.path,
          title: row.title,
          added: stats.added,
          removed: stats.removed,
          jump_line: stats.jump_line,
          kind: 'content' as const,
        }
      })
      .filter((row) => row.added > 0 || row.removed > 0)
  }

  listFiles(sessionId: string, turn: number) {
    const files = this.data.sessions[sessionId.trim()]?.[String(turn)]?.files
    return files ? Object.values(files) : []
  }

  /** 回合内某文件的 before/after；过期裁剪后没有。不进 session 事件，避免把全文再存一份。 */
  snapshot(sessionId: string, turn: number, path: string) {
    const files = this.data.sessions[sessionId.trim()]?.[String(turn)]?.files
    return files?.[path.trim()] ?? null
  }

  private trim(sessionId: string) {
    const ids = Object.keys(this.data.sessions)
    if (ids.length > MAX_SESSIONS) {
      for (const id of ids.slice(0, ids.length - MAX_SESSIONS)) delete this.data.sessions[id]
    }
    const turns = this.data.sessions[sessionId]
    if (!turns) return
    const keys = Object.keys(turns)
      .map(Number)
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b)
    while (keys.length > MAX_TURNS) {
      const drop = keys.shift()
      if (drop != null) delete turns[String(drop)]
    }
  }

  private flush() {
    if (!this.file || this.file === ':memory:') return
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data))
  }
}
