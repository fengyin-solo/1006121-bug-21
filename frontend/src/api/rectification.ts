import { allRows, commitState, listOps, listRows, stateSnapshot } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  HazardLevel,
  RectificationOp,
  Role,
} from '@/data/types'

/**
 * 整改登记的唯一业务入口。
 * 设计约束（对应演练现场的整改要求）：
 * 1. 整改措施、演练进度、参演班组名单、安全巡检整改问题清单——同一份事务一次落到底；
 * 2. 幂等：同一演练重复提交只认第一次，整改日期/期限不被第二遍覆盖；
 * 3. 同源：读写都走 local-store 的单份状态，不另开第二处存储；
 * 4. 权限与状态机前置拦截，卡在哪一环就明说卡在哪一环。
 */

const DRILL_KEY = 'drill'
const SAFETY_KEY = 'safety'
const DRILL_RECTIFIED = '已整改'
const SAFETY_PENDING = '待整改'
const SAFETY_CLOSED = '已闭环'

export const ROLE_LABELS: Record<Role, string> = {
  organizer: '组织人',
  safety: '安全员',
  crew: '参演班组',
}

const DEADLINE_DAYS: Record<HazardLevel, number> = {
  重大隐患: 1,
  较大隐患: 3,
  一般隐患: 7,
}

const HAZARD_LEVELS: HazardLevel[] = ['一般隐患', '较大隐患', '重大隐患']

export function hazardLevels(): HazardLevel[] {
  return [...HAZARD_LEVELS]
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function toDateText(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function todayText(): string {
  return toDateText(new Date())
}

/**
 * 整改期限的唯一取数口径（演练与安全巡检两侧都调它，只有这一份算法）：
 * 以整改登记首次落库日为第 0 天，按自然日顺延——
 * 重大隐患 1 天、较大隐患 3 天、一般隐患 7 天，输出 YYYY-MM-DD。
 */
export function calcDeadline(dateText: string, level: HazardLevel): string {
  const [year, month, day] = dateText.split('-').map((part) => Number(part))
  if (!year || !month || !day) {
    throw new Error('整改登记日期格式不是 YYYY-MM-DD，无法计算整改期限')
  }
  const base = new Date(year, month - 1, day)
  base.setDate(base.getDate() + DEADLINE_DAYS[level])
  return toDateText(base)
}

export function drillRows(): EntryRow[] {
  return listRows(DRILL_KEY)
}

export function safetyRows(): EntryRow[] {
  return listRows(SAFETY_KEY)
}

/** 由演练整改派生的巡检问题：两侧对的就是这一批。 */
export function drillSourceIssues(): EntryRow[] {
  return safetyRows().filter((row) => row['问题来源'] === '应急演练')
}

/** 待闭环问题数的唯一统计口径：安全巡检清单里「来源=应急演练」且未闭环的条数。 */
export function pendingCloseCount(): number {
  return drillSourceIssues().filter((row) => String(row.status) !== SAFETY_CLOSED).length
}

function findDrill(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function linkedIssue(rows: EntryRow[], drillId: number): EntryRow | undefined {
  return rows.find((row) => Number(row['来源演练ID']) === drillId)
}

function nextSafetyIssueId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

export type RectificationInput = {
  drillId: number
  measure: string
  level: HazardLevel
  roster: string
  conclusion: string
  date?: string
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

/**
 * 登记整改一次落到底。
 * 返回 ok=false 表示在「权限环 / 状态环 / 完整性环 / 幂等环」之一被拦下，未写任何数据；
 * 抛异常表示入库失败：事务保证整笔退回，同样不会留下半条记录。
 */
export function registerRectification(input: RectificationInput, role: Role): ActionResult {
  // —— 第一环：权限。只有组织人能登记整改。 ——
  if (role !== 'organizer') {
    return fail(`已拦在「权限校验」环：当前身份是${ROLE_LABELS[role]}，只有组织人能登记整改`)
  }

  const measure = input.measure.trim()
  const roster = input.roster.trim()
  const level = input.level
  const conclusion = input.conclusion.trim()

  // —— 第二环：取数与状态。演练必须存在，且停在「已完成」才能登记整改。 ——
  const snapshot = allRows()
  const drills = snapshot[DRILL_KEY] ?? []
  const safety = snapshot[SAFETY_KEY] ?? []
  const drill = findDrill(drills, input.drillId)
  if (!drill) {
    return fail(`已拦在「取数校验」环：找不到编号为 ${input.drillId} 的演练记录`)
  }
  const drillNo = String(drill['演练编号'] ?? '')
  const status = String(drill.status)
  if (status === DRILL_RECTIFIED) {
    const op = listOps()[String(input.drillId)]
    return fail(
      `已拦在「状态流转」环：演练 ${drillNo} 已完成整改，整改结论与演练科目均已锁定；` +
        `首次整改日期为 ${op?.date ?? '—'}，重复提交只认第一次`,
    )
  }
  if (status !== '已完成') {
    return fail(
      `已拦在「状态流转」环：演练 ${drillNo} 当前为「${status}」，须先「确认完成」再登记整改`,
    )
  }

  // —— 第三环：幂等。已经有成功落库的一笔时，再交一遍仍按头一条算。 ——
  const existed = listOps()[String(input.drillId)]
  if (existed) {
    return fail(
      `已拦在「幂等校验」环：演练 ${drillNo} 已有首笔整改（${existed.date} 登记、期限 ${existed.deadline}），重复点按第一笔算`,
    )
  }
  if (linkedIssue(safety, input.drillId)) {
    return fail(`已拦在「幂等校验」环：演练 ${drillNo} 的整改问题已在巡检清单中，不重复登记`)
  }

  // —— 第四环：完整性。写不全就整笔退回。 ——
  const missing: string[] = []
  if (!measure) missing.push('整改措施')
  if (!roster) missing.push('参演班组名单')
  if (!HAZARD_LEVELS.includes(level)) missing.push('隐患等级')
  if (missing.length > 0) {
    return fail(`已拦在「完整性校验」环：${missing.join('、')}未填全，整笔退回，未落任何记录`)
  }

  const date = (input.date ?? todayText()).trim() || todayText()
  const deadline = calcDeadline(date, level)
  const issueId = nextSafetyIssueId(safety)

  // —— 第五环：整笔事务。演练行、巡检问题、幂等日志同一笔提交。 ——
  commitState((draft) => {
    const drillIndex = draft.entries[DRILL_KEY].findIndex(
      (row) => Number(row.id) === input.drillId,
    )
    const before = draft.entries[DRILL_KEY][drillIndex]
    // 已整改的演练，演练科目保持原值锁死，这里再次兜底。
    draft.entries[DRILL_KEY][drillIndex] = {
      ...before,
      status: DRILL_RECTIFIED,
      pending: false,
      abnormal: false,
      整改措施: measure,
      整改结论: conclusion || '已落实整改措施，待安全巡检闭环',
      整改日期: date,
      整改期限: deadline,
      隐患等级: level,
      参演班组名单: roster,
      演练进度: DRILL_RECTIFIED,
      演练状态: DRILL_RECTIFIED,
    }

    const issue: EntryRow = {
      id: issueId,
      status: SAFETY_PENDING,
      pending: true,
      abnormal: false,
      巡检编号: `SAFE-DR-${String(issueId).padStart(4, '0')}`,
      巡检区域: '应急演练',
      巡检项目: `${drillNo} 演练整改`,
      发现问题: String(before['发现问题'] ?? '').trim() || '演练中发现问题待整改',
      隐患等级: level,
      整改期限: deadline,
      巡检人员: ROLE_LABELS.organizer,
      巡检状态: SAFETY_PENDING,
      整改措施: measure,
      整改结论: conclusion || '',
      整改日期: date,
      问题来源: '应急演练',
      来源演练编号: drillNo,
      来源演练ID: input.drillId,
    }
    draft.entries[SAFETY_KEY] = [...(draft.entries[SAFETY_KEY] ?? []), issue]

    const op: RectificationOp = {
      drillId: input.drillId,
      drillNo,
      date,
      deadline,
      level,
      measure,
      roster,
      safetyIssueId: issueId,
    }
    draft.ops[String(input.drillId)] = op
  })

  return {
    ok: true,
    message: `演练 ${drillNo} 整改已整笔落库：措施、演练进度（${DRILL_RECTIFIED}）、参演班组名单、巡检整改问题（期限 ${deadline}）同一份写入`,
  }
}

export type RectificationDraft = {
  measure: string
  level: HazardLevel
  roster: string
  conclusion: string
  deadline: string
  op?: RectificationOp
  linked?: EntryRow
}

/** 弹窗打开时的回显：全部取自落库的那一份，不再另有第二份草稿。 */
export function getRectificationDraft(drillId: number): RectificationDraft | null {
  const drills = drillRows()
  const drill = findDrill(drills, drillId)
  if (!drill) {
    return null
  }
  const op = listOps()[String(drillId)]
  const linked = linkedIssue(safetyRows(), drillId)
  const level = (op?.level ??
    (HAZARD_LEVELS.includes(String(drill['隐患等级']) as HazardLevel)
      ? (drill['隐患等级'] as HazardLevel)
      : '一般隐患')) as HazardLevel
  const date = op?.date ?? String(drill['整改日期'] ?? '')
  return {
    measure: op?.measure ?? String(drill['整改措施'] ?? ''),
    level,
    roster: op?.roster ?? String(drill['参演班组名单'] ?? drill['参与班组'] ?? ''),
    conclusion: String(linked?.['整改结论'] ?? drill['整改结论'] ?? ''),
    deadline: String(linked?.['整改期限'] ?? drill['整改期限'] ?? (date ? calcDeadline(date, level) : '')),
    op,
    linked,
  }
}

/** 安全巡检环：闭环演练派生问题，演练侧状态本就已「已整改」，此处只闭合清单。 */
export function closeLinkedIssue(drillId: number, role: Role): ActionResult {
  if (role !== 'safety') {
    return fail(`已拦在「权限校验」环：当前身份是${ROLE_LABELS[role]}，只有安全员能确认闭环`)
  }
  const issues = safetyRows()
  const issue = linkedIssue(issues, drillId)
  if (!issue) {
    return fail('已拦在「取数校验」环：巡检清单里没有这条演练整改问题')
  }
  if (String(issue.status) === SAFETY_CLOSED) {
    return fail('已拦在「状态流转」环：该问题已闭环，重复操作不认')
  }
  commitState((draft) => {
    const list = draft.entries[SAFETY_KEY]
    const index = list.findIndex((row) => Number(row.id) === Number(issue.id))
    list[index] = {
      ...list[index],
      status: SAFETY_CLOSED,
      pending: false,
      巡检状态: SAFETY_CLOSED,
    }
  })
  return { ok: true, message: `演练整改问题 ${issue['巡检编号']} 已闭环` }
}

/** 安全巡检通用动作的权限闸：提交巡检归安全员/组织人，派发与闭环只归安全员，越权一律拒绝。 */
export function canSafetyAction(action: string, role: Role): ActionResult | null {
  const safetyOnly = ['派发整改', '确认闭环']
  if (role === 'crew') {
    return fail(`已拦在「权限校验」环：当前身份是参演班组，巡检整改只有查看权，「${action}」一律拒绝`)
  }
  if (safetyOnly.includes(action) && role !== 'safety') {
    return fail(`已拦在「权限校验」环：当前身份是${ROLE_LABELS[role]}，「${action}」只有安全员能执行，越权派发一律拒绝`)
  }
  return null
}

/** 安全员对巡检问题补整改结论；演练派生问题会把结论同步回同一份演练记录，两侧不留两份。 */
export function submitIssueConclusion(
  issueId: number,
  conclusion: string,
  role: Role,
): ActionResult {
  if (role !== 'safety') {
    return fail(`已拦在「权限校验」环：当前身份是${ROLE_LABELS[role]}，只有安全员能登记整改结论`)
  }
  const text = conclusion.trim()
  if (!text) {
    return fail('已拦在「完整性校验」环：整改结论不能为空，整笔退回')
  }
  const issues = safetyRows()
  const issue = issues.find((row) => Number(row.id) === issueId)
  if (!issue) {
    return fail(`已拦在「取数校验」环：找不到编号为 ${issueId} 的巡检问题`)
  }
  commitState((draft) => {
    const list = draft.entries[SAFETY_KEY]
    const index = list.findIndex((row) => Number(row.id) === issueId)
    list[index] = { ...list[index], 整改结论: text }
    // 演练派生问题：结论同源同步，参演班组与演练页读到的就是这一份。
    const sourceDrillId = Number(list[index]['来源演练ID'])
    if (list[index]['问题来源'] === '应急演练' && sourceDrillId) {
      const drillIndex = draft.entries[DRILL_KEY].findIndex(
        (row) => Number(row.id) === sourceDrillId,
      )
      if (drillIndex >= 0) {
        draft.entries[DRILL_KEY][drillIndex] = {
          ...draft.entries[DRILL_KEY][drillIndex],
          整改结论: text,
        }
      }
    }
  })
  return { ok: true, message: `巡检问题 ${issue['巡检编号']} 的整改结论已落库` }
}

/** 改演练科目：已完成整改的演练科目锁死，任何身份都不许改。 */
export function updateDrillSubject(
  drillId: number,
  subject: string,
  role: Role,
): ActionResult {
  if (role !== 'organizer') {
    return fail(`已拦在「权限校验」环：当前身份是${ROLE_LABELS[role]}，只有组织人能修改演练科目`)
  }
  const value = subject.trim()
  if (!value) {
    return fail('已拦在「完整性校验」环：演练科目不能为空')
  }
  const drill = findDrill(drillRows(), drillId)
  if (!drill) {
    return fail(`已拦在「取数校验」环：找不到编号为 ${drillId} 的演练记录`)
  }
  if (String(drill.status) === DRILL_RECTIFIED) {
    return fail('已拦在「锁定校验」环：演练已完成整改，演练科目已锁定，不许再改')
  }
  commitState((draft) => {
    const list = draft.entries[DRILL_KEY]
    const index = list.findIndex((row) => Number(row.id) === drillId)
    list[index] = { ...list[index], 演练科目: value }
  })
  return { ok: true, message: `演练 ${drill['演练编号']} 的科目已更新为「${value}」` }
}

/**
 * 存量演练按演练日期照旧补录：只动历史上已经走到「已整改」的存量行，
 * 为其补齐幂等日志与巡检问题；一条一笔事务，断掉后下次从游标接着走。
 */
export function migrateLegacyRectifications(onProgress?: (done: number, total: number) => void): void {
  for (;;) {
    const state = allRowsState()
    if (state.migration.done) {
      return
    }
    const rows = state.entries[DRILL_KEY] ?? []
    const pendingLegacy = rows.filter(
      (row) =>
        String(row.status) === DRILL_RECTIFIED &&
        !state.ops[String(row.id)] &&
        !linkedIssue(state.entries[SAFETY_KEY] ?? [], Number(row.id)),
    )
    if (pendingLegacy.length === 0) {
      commitState((draft) => {
        draft.migration.done = true
        draft.migration.drillCursor = rows.length
      })
      onProgress?.(rows.length, rows.length)
      return
    }
    const drill = pendingLegacy.reduce((earliest, row) =>
      String(row['演练日期']) < String(earliest['演练日期']) ? row : earliest,
    )
    const drillId = Number(drill.id)
    const drillNo = String(drill['演练编号'] ?? `DRIL-${drillId}`)
    const date = String(drill['整改日期'] ?? drill['演练日期'] ?? todayText())
    const level = (HAZARD_LEVELS.includes(String(drill['隐患等级']) as HazardLevel)
      ? drill['隐患等级']
      : '一般隐患') as HazardLevel
    const measure = String(drill['整改措施'] ?? '').trim() || '存量演练：按演练日期补录整改措施'
    const roster = String(drill['参演班组名单'] ?? drill['参与班组'] ?? '').trim() || '存量参演班组'
    const deadline = calcDeadline(date, level)

    commitState((draft) => {
      const list = draft.entries[SAFETY_KEY] ?? []
      const issueId = nextSafetyIssueId(list)
      draft.entries[SAFETY_KEY] = [
        ...list,
        {
          id: issueId,
          status: SAFETY_PENDING,
          pending: true,
          abnormal: false,
          巡检编号: `SAFE-DR-${String(issueId).padStart(4, '0')}`,
          巡检区域: '应急演练',
          巡检项目: `${drillNo} 演练整改（存量补录）`,
          发现问题: String(drill['发现问题'] ?? '').trim() || '存量演练问题',
          隐患等级: level,
          整改期限: deadline,
          巡检人员: ROLE_LABELS.organizer,
          巡检状态: SAFETY_PENDING,
          整改措施: measure,
          整改结论: String(drill['整改结论'] ?? ''),
          整改日期: date,
          问题来源: '应急演练',
          来源演练编号: drillNo,
          来源演练ID: drillId,
        },
      ]
      draft.ops[String(drillId)] = {
        drillId,
        drillNo,
        date,
        deadline,
        level,
        measure,
        roster,
        safetyIssueId: issueId,
      }
      const index = draft.entries[DRILL_KEY].findIndex((row) => Number(row.id) === drillId)
      if (index >= 0) {
        draft.entries[DRILL_KEY][index] = {
          ...draft.entries[DRILL_KEY][index],
          整改日期: date,
          整改期限: deadline,
          隐患等级: level,
          参演班组名单: roster,
          演练进度: DRILL_RECTIFIED,
        }
      }
      draft.migration.drillCursor = (draft.entries[DRILL_KEY] ?? []).length
    })
    onProgress?.(1, pendingLegacy.length)
  }
}

// allRows() 只抛行集合，迁移需要游标与日志，故在本层直读状态。
function allRowsState() {
  return stateSnapshot()
}
