import { defineStore } from 'pinia'
import { ROLE_LABELS } from '@/api/rectification'
import type { Role } from '@/data/types'

const ROLE_STORAGE_KEY = 'shield-tunnel-construction:role'

function initialRole(): Role {
  if (typeof window !== 'undefined' && window.localStorage) {
    const saved = window.localStorage.getItem(ROLE_STORAGE_KEY)
    if (saved === 'organizer' || saved === 'safety' || saved === 'crew') {
      return saved
    }
  }
  return 'organizer'
}

export const ROLE_OPTIONS: Role[] = ['organizer', 'safety', 'crew']

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role]
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
    role: initialRole() as Role,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    isOrganizer: (state) => state.role === 'organizer',
    isSafety: (state) => state.role === 'safety',
    isCrew: (state) => state.role === 'crew',
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: Role) {
      this.role = role
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(ROLE_STORAGE_KEY, role)
      }
    },
  },
})
