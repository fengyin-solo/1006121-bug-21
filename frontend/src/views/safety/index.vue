<template>
  <section class="page" data-module="safety">
    <header class="page-head">
      <div>
        <h2>安全巡检管理</h2>
        <p class="page-desc">整改问题清单只此一份：演练登记的整改结论落到这里闭环，演练页与本页的待闭环问题数同源对账。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检记录</button>
        <button class="btn" type="button" @click="exportRows">导出安全巡检清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待巡检区域</span>
        <strong class="stat-value">{{ pendingInspect }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待整改隐患（总）</span>
        <strong class="stat-value">{{ pendingClose }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">其中演练整改待闭环</span>
        <strong class="stat-value">{{ pendingFromDrill }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已闭环隐患</span>
        <strong class="stat-value">{{ closed }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-for="action in actions" :key="action">
              <button
                v-if="actionAllowed(action, row)"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-if="!hasAnyAction(row)" class="muted-text">无可用动作（{{ roleHint }}）</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无安全巡检数据，可先登记巡检记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡检记录；整改期限以本清单为准，演练页同源读取，两侧只留一份</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'

import {
  canRunAction,
  downloadEntries,
  drainRectificationQueue,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const roleHint = computed(() => store.operator)

const meta = moduleMeta('safety')
const columns = ["巡检编号", "巡检区域", "巡检项目", "发现问题", "隐患等级", "整改期限", "巡检人员", "来源类型", "来源单号", "整改措施", "整改结论", "整改日期", "闭环日期"]
const actions = ["提交巡检", "派发整改", "确认闭环"]
const statuses = ["待巡检", "已巡检", "待整改", "已闭环"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["巡检编号", "巡检区域", "巡检项目"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const pendingInspect = computed(() => rows.value.filter((row) => String(row.status) === '待巡检').length)
const pendingClose = computed(() => rows.value.filter((row) => String(row.status) === '待整改').length)
const closed = computed(() => rows.value.filter((row) => String(row.status) === '已闭环').length)
// 演练页的待整改数：只认来源于演练整改、还没闭环的问题，两处数字据此对得上。
const pendingFromDrill = computed(() =>
  rows.value.filter((row) => row.来源类型 === '演练整改' && String(row.status) === '待整改').length,
)

// 仅在相邻状态流转时露出动作；无权限角色（如演练组织人越级派发）直接不显示，
// 强行调用接口仍会被服务层拦下并说明卡在哪一环。
function actionAllowed(action: string, row: EntryRow): boolean {
  if (!canRunAction(meta.key, action, store.role)) {
    return false
  }
  const target = meta.actionTargets[action]
  const currentIndex = statuses.indexOf(String(row.status))
  const targetIndex = statuses.indexOf(target)
  return targetIndex === currentIndex + 1
}

function hasAnyAction(row: EntryRow): boolean {
  return actions.some((action) => actionAllowed(action, row))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '巡检记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, store.role)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 演练整改落库可能发生在别的入口；先续办队列再读同一份，保证两侧数字对得上。
    drainRectificationQueue()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '安全巡检列表读取失败，请重试'
  }
}

onMounted(reload)
onActivated(reload)
</script>

<style scoped>
.muted-text { color: var(--muted); font-size: 12px; }
</style>
