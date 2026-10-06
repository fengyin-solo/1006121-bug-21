import { defineStore } from 'pinia'

import type { Role, RoleOption } from '@/data/types'

export const ROLE_OPTIONS: RoleOption[] = [
  { value: 'organizer', label: '演练组织人' },
  { value: 'safety', label: '安全员' },
  { value: 'crew', label: '参演班组' },
  { value: 'admin', label: '值班管理员' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
    // 默认按值班管理员进入，演练整改/巡检派发各环节的越权与越级都由角色拦截。
    role: 'admin' as Role,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: Role) {
      this.role = role
      const found = ROLE_OPTIONS.find((item) => item.value === role)
      if (found) {
        this.operator = found.label
      }
    },
  },
})
