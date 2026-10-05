/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 登录角色：组织人登记整改，安全员派发/闭环，参演班组只读。 */
export type Role = 'organizer' | 'safety' | 'crew'

/** 隐患等级：决定整改期限的统一取数口径。 */
export type HazardLevel = '一般隐患' | '较大隐患' | '重大隐患'

/** 一次整改登记的幂等凭据：同一演练只认第一次成功落库的这份。 */
export type RectificationOp = {
  drillId: number
  drillNo: string
  date: string
  deadline: string
  level: HazardLevel
  measure: string
  roster: string
  safetyIssueId: number
}

/** v2 持久化结构：业务数据、幂等日志、迁移游标同写同读，保证只有一份。 */
export type PersistedState = {
  version: number
  entries: Record<string, EntryRow[]>
  ops: Record<string, RectificationOp>
  migration: { drillCursor: number; done: boolean }
}
