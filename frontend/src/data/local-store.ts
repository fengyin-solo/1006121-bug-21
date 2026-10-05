import { SEED_ROWS } from './seed'
import type { EntryRow, PersistedState, RectificationOp } from './types'

// 本地持久化：演练整改只有这一份数据源，写入是整笔事务，读写同 key、同版本结构。
const STORAGE_KEY = 'shield-tunnel-construction:entries:v2'
// 重构前的旧 key：首次启动时清掉，避免任何入口读到上一版。
const LEGACY_STORAGE_KEY = 'shield-tunnel-construction:entries'
const SCHEMA_VERSION = 2
const MAX_READ_RETRY = 3
const MAX_WRITE_RETRY = 3

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function freshState(): PersistedState {
  return {
    version: SCHEMA_VERSION,
    entries: clone(SEED_ROWS),
    ops: {},
    migration: { drillCursor: 0, done: false },
  }
}

function parseState(raw: string): PersistedState | null {
  const parsed = JSON.parse(raw) as Partial<PersistedState>
  if (parsed && typeof parsed === 'object' && parsed.entries) {
    return {
      version: SCHEMA_VERSION,
      entries: parsed.entries as Record<string, EntryRow[]>,
      ops: parsed.ops ?? {},
      migration: parsed.migration ?? { drillCursor: 0, done: false },
    }
  }
  return null
}

/** 旧结构升级：业务行原样搬进 v2 并以新字段为准（缺的整改字段走补录），随后删除旧 key，两侧只留一份。 */
function upgradeLegacy(): PersistedState {
  const state = freshState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return state
  }
  const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
  if (raw) {
    try {
      const legacy = JSON.parse(raw) as Record<string, EntryRow[]>
      state.entries = { ...state.entries, ...legacy }
    } catch {
      // 旧数据解不出来就保持新播种数据，但不写回旧 key，也不顶回上一版。
    }
    window.localStorage.removeItem(LEGACY_STORAGE_KEY)
  }
  return state
}

/**
 * 直接从存储读，取不到/解不出就重试，绝不拿上一版（seed）顶回来；
 * 只有存储里确实一行都没有（首次使用）才播种。
 */
function readFromStorage(): PersistedState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return freshState()
  }
  let lastError: unknown = null
  for (let attempt = 1; attempt <= MAX_READ_RETRY; attempt += 1) {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (raw === null) {
        // 首次用新结构：把旧版业务行整体升级进 v2（旧版里的「已整改」由补录流程接着走），再删旧 key。
        const upgraded = upgradeLegacy()
        try {
          writeToStorage(upgraded)
        } catch {
          // 播种阶段持久化不可用时降级为内存态，先让页面能用；用户提交时若仍写不进，会按事务失败整笔退回。
        }
        return upgraded
      }
      const state = parseState(raw)
      if (state) {
        return state
      }
      lastError = new Error('已落库数据结构无法识别')
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `已落库数据连续 ${MAX_READ_RETRY} 次取不到，已保留现场未覆盖，请稍后重试（${
      lastError instanceof Error ? lastError.message : '未知错误'
    }）`,
  )
}

function writeToStorage(state: PersistedState): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const payload = JSON.stringify(state)
  let lastError: unknown = null
  for (let attempt = 1; attempt <= MAX_WRITE_RETRY; attempt += 1) {
    try {
      window.localStorage.setItem(STORAGE_KEY, payload)
      const verify = window.localStorage.getItem(STORAGE_KEY)
      if (verify === payload) {
        return
      }
      lastError = new Error('写入后校验不一致')
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `入库连续失败 ${MAX_WRITE_RETRY} 次，已整笔退回、未落任何半条记录（${
      lastError instanceof Error ? lastError.message : '未知错误'
    }）`,
  )
}

let cache: PersistedState | null = null

function loadState(): PersistedState {
  if (cache !== null) {
    return cache
  }
  cache = readFromStorage()
  return cache
}

/**
 * 唯一的落库口：改之前先整份克隆，改完整笔提交（含写入后回读校验）。
 * 任一环失败都恢复旧快照并抛错——写不全就整笔退回，不许留下半条记录。
 */
export function commitState(mutate: (draft: PersistedState) => void): PersistedState {
  const base = loadState()
  const draft = clone(base)
  mutate(draft)
  try {
    writeToStorage(draft)
  } catch (error) {
    // 入库失败：内存快照可能已落后于落库那份，立即作废，下次读取从存储重取，避免重试时重复补写。
    cache = null
    throw error
  }
  cache = draft
  return draft
}

export function allRows(): Record<string, EntryRow[]> {
  return loadState().entries
}

export function stateSnapshot(): PersistedState {
  return loadState()
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitState((draft) => {
    draft.entries[key] = rows
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/** 幂等日志：key 为 `${drillId}`，同一演练重复提交只认第一次。 */
export function listOps(): Record<string, RectificationOp> {
  return loadState().ops
}

export function storageKey(): string {
  return STORAGE_KEY
}
