import { MODULE_BY_KEY } from '@/data/modules'
import {
  commit,
  getDb,
  listRows,
  rectifyDeadline,
  reloadDb,
  resetRows,
  saveRows,
  todayText,
  type RectificationItem,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  RectificationPayload,
  RectificationResult,
  Role,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 演练整改问题进入安全巡检清单时的统一来源标记，两侧只留一份。
const SOURCE_TYPE_DRILL = '演练整改'
const ROLE_LABEL: Record<Role, string> = {
  admin: '值班管理员',
  organizer: '演练组织人',
  safety: '安全员',
  crew: '参演班组',
}

// 未单独声明动作权限的模块：管理员、组织人、安全员都可操作，参演班组只读。
const DEFAULT_ACTION_ROLES: Role[] = ['admin', 'organizer', 'safety']

export function roleLabel(role: Role): string {
  return ROLE_LABEL[role]
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function allowedRoles(meta: ModuleMeta, action: string): Role[] {
  return meta.actionRoles?.[action] ?? DEFAULT_ACTION_ROLES
}

export function canRunAction(key: string, action: string, role: Role): boolean {
  return allowedRoles(moduleMeta(key), action).includes(role)
}

function checkPermission(meta: ModuleMeta, action: string, role: Role): ActionResult | null {
  const roles = allowedRoles(meta, action)
  if (!roles.includes(role)) {
    return {
      ok: false,
      blockedAt: 'permission',
      message: `权限拦截：${ROLE_LABEL[role]}无权执行「${action}」，该环节限${roles
        .map((item) => ROLE_LABEL[item])
        .join('、')}办理（卡在权限校验环）`,
    }
  }
  return null
}

// 通用动作：先过权限，再校验状态不许越级跳；通过后整笔落库。
export function runAction(key: string, id: number, action: string, role: Role = 'admin'): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const denied = checkPermission(meta, action, role)
  if (denied) {
    return denied
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, blockedAt: 'transition', message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const currentIndex = meta.statuses.indexOf(current)
  const targetIndex = meta.statuses.indexOf(target)
  if (currentIndex < 0 || targetIndex < 0 || targetIndex !== currentIndex + 1) {
    return {
      ok: false,
      blockedAt: 'transition',
      message: `越级拦截：${meta.entity}当前为「${current}」，必须先流转到「${meta.statuses[currentIndex + 1] ?? '下一环节'}」，不能直接「${action}」跳到「${target}」（卡在状态流转环）`,
    }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: targetIndex !== meta.statuses.length - 1,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
  } catch {
    return { ok: false, message: '入库失败，本次操作整笔未落库，请重试' }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ---------------------------------------------------------------------------
// 应急演练 · 登记整改：整改措施、演练进度、参演班组名单、巡检整改问题清单，
// 在同一次原子提交里写进同一份数据；写不全整笔退回，不留半条记录。
// ---------------------------------------------------------------------------

function findDrill(id: number): EntryRow | null {
  return listRows('drill').find((row) => Number(row.id) === id) ?? null
}

// 演练对应的巡检整改问题（唯一一份，按来源单号 = 演练编号去重）。
export function linkedIssue(drill: EntryRow): EntryRow | undefined {
  const code = String(drill.演练编号 ?? '')
  return listRows('safety').find(
    (item) => item.来源类型 === SOURCE_TYPE_DRILL && String(item.来源单号 ?? '') === code,
  )
}

function nextSourceNo(existing: EntryRow[]): string {
  let max = 0
  for (const row of existing) {
    const code = String(row.巡检编号 ?? '')
    const match = /^DRIL-RECT-(\d+)$/.exec(code)
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `DRIL-RECT-${String(max + 1).padStart(4, '0')}`
}

function applyItem(db: ReturnType<typeof getDb>, item: RectificationItem): EntryRow {
  const drills = db.rows.drill ?? []
  const index = drills.findIndex((row) => Number(row.id) === item.drillId)
  if (index < 0) {
    throw new Error(`演练 ${item.drillId} 不存在`)
  }
  const drill = drills[index]
  const code = String(drill.演练编号 ?? '')
  const safety = db.rows.safety ?? []
  const issueIndex = safety.findIndex(
    (row) => row.来源类型 === SOURCE_TYPE_DRILL && String(row.来源单号 ?? '') === code,
  )
  const deadline = rectifyDeadline(item.submittedAt)
  const sourceNo = issueIndex >= 0
    ? String(safety[issueIndex].巡检编号)
    : String(drill.整改单号 ?? '') || nextSourceNo(safety)

  // 同一份演练记录：措施、结论、日期、期限、单号、参演班组名单、进度状态一起落。
  const updatedDrill: EntryRow = {
    ...drill,
    整改措施: item.measures,
    整改结论: item.conclusion,
    整改日期: item.submittedAt,
    整改期限: deadline,
    整改单号: sourceNo,
    参与班组: item.crewList,
    status: '已整改',
    pending: false,
    abnormal: false,
  }
  drills[index] = updatedDrill
  db.rows.drill = drills

  // 整改结论落到安全巡检整改问题清单；已存在（重交/续办）则更新同一条，绝不新增第二条。
  const issue: EntryRow = issueIndex >= 0
    ? {
        ...safety[issueIndex],
        整改措施: item.measures,
        整改结论: item.conclusion,
        整改日期: item.submittedAt,
        整改期限: deadline,
      }
    : {
        id: safety.length ? Math.max(...safety.map((row) => Number(row.id))) + 1 : 1,
        status: '待整改',
        pending: true,
        abnormal: false,
        巡检编号: sourceNo,
        巡检区域: '应急演练',
        巡检项目: String(updatedDrill.演练科目 ?? ''),
        发现问题: String(updatedDrill.发现问题 ?? ''),
        隐患等级: '一般',
        整改期限: deadline,
        巡检人员: String(updatedDrill.组织人 ?? ROLE_LABEL.organizer),
        巡检状态: '待整改',
        来源类型: SOURCE_TYPE_DRILL,
        来源单号: code,
        整改措施: item.measures,
        整改结论: item.conclusion,
        整改日期: item.submittedAt,
        闭环日期: '',
      }
  if (issueIndex >= 0) {
    safety[issueIndex] = issue
  } else {
    safety.push(issue)
  }
  db.rows.safety = safety
  return updatedDrill
}

// 从中断那一条接着走：按入队时间从最早开始逐条提交，任何一条失败就停在原处，
// 已成功的条目同事务移除；没处理完的下次继续。
export function drainRectificationQueue(): RectificationResult {
  const db = getDb()
  const pending = [...db.rectificationQueue]
    .filter((item) => findDrill(item.drillId))
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.drillId - b.drillId)
  let applied: RectificationItem | null = null
  for (const item of pending) {
    try {
      commit((draft) => {
        applyItem(draft, item)
        draft.rectificationQueue = draft.rectificationQueue.filter(
          (queued) => queued.drillId !== item.drillId,
        )
      })
      applied = item
    } catch {
      // 入库失败整笔不落：队列里这一条原样保留，后面的也先不越过它。
      break
    }
  }
  if (applied) {
    return {
      ok: true,
      resumed: pending.some((item) => item.attempts > 0),
      rectifiedAt: applied.submittedAt,
      deadline: rectifyDeadline(applied.submittedAt),
      message: '登记整改已整笔落库（整改措施、演练进度、参演班组名单、巡检整改清单同源写入）',
    }
  }
  return { ok: false, message: '整改队列暂无可落库记录' }
}

export function pendingRectificationCount(): number {
  return getDb().rectificationQueue.length
}

// 某条演练挂在续办队列里的那版内容（中断时已填、尚未落库）；没有断点返回 null。
export function queuedRectification(id: number): RectificationPayload | null {
  const item = getDb().rectificationQueue.find((queued) => queued.drillId === id)
  if (!item) {
    return null
  }
  return { measures: item.measures, crewList: item.crewList, conclusion: item.conclusion }
}

// 登记整改：重复点两回也只落一条；同一条演练再次提交仍按头一条的整改日期算。
export function submitRectification(
  id: number,
  payload: RectificationPayload,
  role: Role = 'admin',
): RectificationResult {
  const denied = checkPermission(moduleMeta('drill'), '登记整改', role)
  if (denied) {
    return denied
  }
  const drill = findDrill(id)
  if (!drill) {
    return { ok: false, blockedAt: 'validation', message: `没有找到编号为 ${id} 的应急演练` }
  }
  const status = String(drill.status)
  if (status === '已整改' && !getDb().rectificationQueue.some((item) => item.drillId === id)) {
    return {
      ok: false,
      blockedAt: 'transition',
      message: '该演练已完成整改，整改记录只认第一次提交，不能重复登记整改',
    }
  }
  if (status !== '已完成' && status !== '已整改') {
    return {
      ok: false,
      blockedAt: 'transition',
      message: `越级拦截：演练当前为「${status}」，需先「确认完成」后才能登记整改（卡在状态流转环）`,
    }
  }
  const measures = payload.measures.trim()
  const crewList = payload.crewList.trim()
  const conclusion = payload.conclusion.trim()
  if (!measures || !crewList || !conclusion) {
    return {
      ok: false,
      blockedAt: 'validation',
      message: '整笔退回：整改措施、参演班组名单、整改结论必须写全，缺一项都不落库（卡在内容校验环）',
    }
  }

  // 幂等入口：同一演练在队列里只占一格。已入队的（中断续交）保留头一次的整改日期，
  // 只更新本次补全的内容；尚未入队的以今天为整改日期。
  let firstDate = ''
  let resumed = false
  commit((draft) => {
    const existing = draft.rectificationQueue.find((item) => item.drillId === id)
    if (existing) {
      firstDate = existing.submittedAt
      resumed = true
      existing.measures = measures
      existing.crewList = crewList
      existing.conclusion = conclusion
      existing.attempts += 1
    } else {
      firstDate = todayText()
      const item: RectificationItem = {
        drillId: id,
        measures,
        crewList,
        conclusion,
        submittedAt: firstDate,
        enqueuedAt: Date.now(),
        attempts: 1,
      }
      draft.rectificationQueue.push(item)
    }
  })

  // 立即把队列往落库方向推：成功就是一次落到底；失败也已留下可续办的那一条。
  const drained = drainRectificationQueue()
  if (!drained.ok) {
    return {
      ok: false,
      message: '入库失败，本次整改整笔未落库，已保留断点，重新进入时从该条接着提交',
    }
  }
  return {
    ok: true,
    resumed,
    rectifiedAt: firstDate,
    deadline: rectifyDeadline(firstDate),
    message: resumed
      ? `续办成功：仍按头一次整改日期 ${firstDate} 计算，整改措施等已整笔落库`
      : `登记整改已一次落到底，整改日期 ${firstDate}，整改期限 ${rectifyDeadline(firstDate)}（整改日 + 7 个自然日）`,
  }
}

// 已经完成整改的演练不许再改演练科目；其他状态由组织人/管理员修改，整笔落库。
export function changeDrillSubject(id: number, subject: string, role: Role = 'admin'): ActionResult {
  const denied = checkPermission(moduleMeta('drill'), '修改科目', role)
  if (denied) {
    return denied
  }
  const drill = findDrill(id)
  if (!drill) {
    return { ok: false, blockedAt: 'validation', message: `没有找到编号为 ${id} 的应急演练` }
  }
  const value = subject.trim()
  if (!value) {
    return { ok: false, blockedAt: 'validation', message: '演练科目不能为空，修改整笔退回' }
  }
  if (String(drill.status) === '已整改') {
    return {
      ok: false,
      blockedAt: 'transition',
      message: '该演练已完成整改，演练科目锁定，不允许再修改（卡在状态流转环）',
    }
  }
  try {
    commit((draft) => {
      const drills = draft.rows.drill ?? []
      const index = drills.findIndex((row) => Number(row.id) === id)
      drills[index] = { ...drills[index], 演练科目: value }
      draft.rows.drill = drills
    })
  } catch {
    return { ok: false, message: '入库失败，科目修改整笔未落库，请重试' }
  }
  return { ok: true, message: `演练科目已更新为「${value}」` }
}

// 安全巡检侧的统计口径：待闭环问题只看「待整改」。
export function safetyPendingCount(): number {
  return listRows('safety').filter((row) => String(row.status) === '待整改').length
}

// 演练侧的待整改问题数与巡检清单同源：只数来源于演练整改、且尚未闭环的问题。
// 两处待闭环问题数因此始终对得上（巡检页是全集，演练页是其中演练来源的子集）。
export function drillPendingCount(): number {
  return listRows('safety').filter(
    (row) => row.来源类型 === SOURCE_TYPE_DRILL && String(row.status) === '待整改',
  ).length
}

export function drillStats() {
  const drills = listRows('drill')
  return {
    pendingPlan: drills.filter((row) => String(row.status) === '待策划').length,
    completed: drills.filter((row) => String(row.status) === '已完成').length,
    pendingRectify: drillPendingCount(),
    queue: pendingRectificationCount(),
    queuedIds: getDb().rectificationQueue.map((item) => item.drillId),
  }
}

// 从磁盘重读落库那份：刷新/返回再进时不取内存旧版。
export function refreshFromStorage(): void {
  reloadDb()
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = getDb().rows
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
