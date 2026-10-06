import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：全库只占一个 localStorage 键，演练整改队列与业务记录同源同写同读，
// 杜绝「一个动作写两处、只有一边落库」。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
const DB_VERSION = 2

// 整改提交在落库前进入的续办队列：同一条演练只占一格（按 drillId 去重），
// 落库失败或中途退出后，下次进入按 enqueuedAt 从最早断掉的那一条接着走。
export type RectificationItem = {
  drillId: number
  measures: string
  crewList: string
  conclusion: string
  submittedAt: string // 整改日期：始终认头一次提交的日期，重交不覆盖
  enqueuedAt: number
  attempts: number
}

export type Database = {
  version: number
  rows: Record<string, EntryRow[]>
  rectificationQueue: RectificationItem[]
}

export class StorageReadError extends Error {
  constructor(message = '本地数据读取失败，请重试') {
    super(message)
    this.name = 'StorageReadError'
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

// 统一取数口径：整改期限 = 整改日期（头一次提交日）+ 7 个自然日，格式 YYYY-MM-DD。
// 以安全巡检整改问题清单里那条的「整改期限」为唯一准绳，演练页不再各算一份。
const RECTIFY_DEADLINE_DAYS = 7

export function rectifyDeadline(submittedAt: string): string {
  const [year, month, day] = submittedAt.split('-').map(Number)
  if (!year || !month || !day) {
    return ''
  }
  const base = new Date(year, month - 1, day)
  base.setDate(base.getDate() + RECTIFY_DEADLINE_DAYS)
  return (
    `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`
  )
}

function freshSeed(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

function todayText(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

// 存量演练按演练日期照旧补录：已经是「已整改」的，按它自己的演练日期补整改日期，
// 并在安全巡检整改问题清单补一条来源唯一的闭环问题（单号 DRIL-RECT-XXXX），
// 两边的待闭环数天然对得上；非已整改的存量演练不动。
function backfillLegacyRectifications(rows: Record<string, EntryRow[]>): void {
  const drills = rows.drill ?? []
  const safety = rows.safety ?? []
  let seq = 1
  for (const drill of drills) {
    if (String(drill.status) !== '已整改') {
      continue
    }
    const submittedAt = String(drill.整改日期 ?? '') || String(drill.演练日期 ?? '')
    if (!submittedAt) {
      continue
    }
    drill.整改日期 = submittedAt
    const deadline = rectifyDeadline(submittedAt)
    if (deadline) {
      drill.整改期限 = deadline
    }
    const sourceNo = `DRIL-RECT-${String(seq++).padStart(4, '0')}`
    drill.整改单号 = sourceNo
    const already = safety.some((item) => item.来源单号 === sourceNo)
    if (!already) {
      safety.push({
        id: safety.length + 1,
        status: '已闭环',
        pending: false,
        abnormal: false,
        巡检编号: sourceNo,
        巡检区域: '应急演练',
        巡检项目: String(drill.演练科目 ?? ''),
        发现问题: String(drill.发现问题 ?? ''),
        隐患等级: '一般',
        整改期限: deadline,
        巡检人员: String(drill.组织人 ?? '演练组织人'),
        巡检状态: '已闭环',
        来源类型: '演练整改',
        来源单号: String(drill.演练编号 ?? ''),
        整改措施: String(drill.整改措施 ?? ''),
        整改结论: String(drill.整改结论 ?? drill.整改措施 ?? '演练整改已闭环'),
        整改日期: submittedAt,
        闭环日期: submittedAt,
      })
    }
  }
  rows.safety = safety
}

function toDatabase(raw: unknown): { db: Database; migrated: boolean } {
  // v1：老版本是裸的 Record<string, EntryRow[]>，原样保留并做一次存量补录。
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !('version' in raw)) {
    const rows = raw as Record<string, EntryRow[]>
    backfillLegacyRectifications(rows)
    return {
      db: { version: DB_VERSION, rows, rectificationQueue: [] },
      migrated: true,
    }
  }
  const candidate = raw as Partial<Database> | null
  if (!candidate || typeof candidate !== 'object' || !candidate.rows) {
    throw new StorageReadError()
  }
  const db: Database = {
    version: DB_VERSION,
    rows: clone(candidate.rows) as Record<string, EntryRow[]>,
    rectificationQueue: Array.isArray(candidate.rectificationQueue)
      ? clone(candidate.rectificationQueue)
      : [],
  }
  backfillLegacyRectifications(db.rows)
  return { db, migrated: Number(candidate.version) !== DB_VERSION }
}

function readRaw(): string | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  // 取不到数据时重试，而不是把上一版（seed）顶回来：连续三次读异常才认失败。
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return window.localStorage.getItem(STORAGE_KEY)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? new StorageReadError(lastError.message)
    : new StorageReadError()
}

function writeRaw(payload: string): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // 入库失败一律不落：localStorage 抛错（如配额满）时直接向上抛，
  // 由调用方保证内存缓存不被半条记录污染。
  window.localStorage.setItem(STORAGE_KEY, payload)
}

let cache: Database | null = null

function seedDatabase(): Database {
  const rows = freshSeed()
  return { version: DB_VERSION, rows, rectificationQueue: [] }
}

export function getDb(): Database {
  if (cache !== null) {
    return cache
  }
  const raw = readRaw()
  if (raw === null) {
    cache = seedDatabase()
    return cache
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 解析失败属于取不到数据：抛读错误，绝不用上一版（seed）顶回来。
    throw new StorageReadError()
  }
  const { db, migrated } = toDatabase(parsed)
  cache = db
  if (migrated) {
    // 迁移结果立即落盘：版本号与存量补录一次写全，下次读取直接是新版。
    writeRaw(JSON.stringify(db))
  }
  return cache
}

// 原子提交：演练措施/进度/班组与巡检整改清单、续办队列在同一次写入里落库。
// 任何一步抛错，整笔退回，内存与存储都保持提交前的样子，不留半条记录。
export function commit(mutate: (db: Database) => void): Database {
  const current = getDb()
  const draft: Database = clone(current)
  mutate(draft)
  writeRaw(JSON.stringify(draft))
  cache = draft
  return draft
}

// 只重新解析磁盘上那份，保证「读取与写入同源」：刷新、返回再进都看到落库那份。
export function reloadDb(): Database {
  cache = null
  return getDb()
}

export function allRows(): Record<string, EntryRow[]> {
  return getDb().rows
}

export function listRows(key: string): EntryRow[] {
  return getDb().rows[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit((db) => {
    db.rows[key] = rows
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

export { todayText }
