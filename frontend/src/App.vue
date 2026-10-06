<template>
  <div class="app-shell">
    <aside class="app-side">
      <h1 class="app-title">盾构隧道掘进施工管理平台</h1>
      <nav class="nav-list">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>
    <main class="app-main">
      <header class="app-head">
        <span class="head-desc">面向盾构机台账、掘进环次、管片拼装、同步注浆、渣土外运、地表沉降监测与轴线纠偏的一体化盾构隧道施工管理平台。</span>
        <span class="head-user">
          当前值班：{{ store.operator }} · {{ store.shiftLabel }}
          <label class="role-switch">
            切换角色
            <select :value="store.role" @change="switchRole(($event.target as HTMLSelectElement).value as Role)">
              <option v-for="option in roleOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
        </span>
      </header>
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'

import { drainRectificationQueue, refreshFromStorage } from '@/api/local-service'
import { storageKey } from '@/data/local-store'
import type { Role } from '@/data/types'
import { ROLE_OPTIONS, useSessionStore } from '@/stores/session'

const store = useSessionStore()
const roleOptions = ROLE_OPTIONS

const navItems = [{ label: "运营概览", path: "/" }, { label: "盾构机台账", path: "/shield" }, { label: "掘进环次", path: "/ring" }, { label: "管片拼装", path: "/segment" }, { label: "同步注浆", path: "/grouting" }, { label: "渣土外运", path: "/muck" }, { label: "地表沉降", path: "/settlement" }, { label: "轴线偏差", path: "/axis" }, { label: "刀具磨损", path: "/cutter" }, { label: "管片生产", path: "/segmentprod" }, { label: "浆液拌制", path: "/mortar" }, { label: "洞内通风", path: "/ventilation" }, { label: "建筑监测", path: "/building" }, { label: "管线探查", path: "/utility" }, { label: "进度节点", path: "/progress" }, { label: "试验检测", path: "/testing" }, { label: "应急演练", path: "/drill" }, { label: "班组进场", path: "/crew" }, { label: "安全巡检", path: "/safety" }]

function switchRole(role: Role) {
  store.setRole(role)
}

// 其他入口（新开标签页/另一个窗口）写入后，本窗口重读磁盘上那一份，两侧只留一份。
function handleStorage(event: StorageEvent) {
  if (event.key === storageKey()) {
    refreshFromStorage()
  }
}

onMounted(() => {
  // 中断时从断掉那一条接着走：进入平台先把未落库的整改逐条补提交。
  drainRectificationQueue()
  window.addEventListener('storage', handleStorage)
})

onUnmounted(() => {
  window.removeEventListener('storage', handleStorage)
})
</script>

<style scoped>
.role-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 12px;
}
.role-switch select {
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid var(--border);
  font-size: 12px;
}
</style>
