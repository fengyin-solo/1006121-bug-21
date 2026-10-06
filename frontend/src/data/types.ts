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
  // 每个动作允许的角色；未声明的动作按 local-service 里的默认角色集校验。
  actionRoles?: Record<string, Role[]>
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
  // 越权 / 越级时说明卡在哪一环：permission（角色无此权限）或 transition（状态不能跳）。
  blockedAt?: 'permission' | 'transition' | 'validation'
}

// 平台角色：组织人负责演练登记与整改，安全员负责巡检整改派发与闭环，
// 参演班组只读演练结果，值班管理员可处理演练以外的全局模块。
export type Role = 'admin' | 'organizer' | 'safety' | 'crew'

export type RoleOption = {
  value: Role
  label: string
}

export type RectificationPayload = {
  measures: string
  crewList: string
  conclusion: string
}

export type RectificationResult = ActionResult & {
  rectifiedAt?: string
  deadline?: string
  resumed?: boolean
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
