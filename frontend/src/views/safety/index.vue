<template>
  <section class="page" data-module="safety">
    <header class="page-head">
      <div>
        <h2>安全巡检管理</h2>
        <p class="page-desc">演练整改结论落到本清单同一份记录：派发整改只有安全员能执行，越权派发一律拒绝；演练侧待闭环数与本页同数。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检记录</button>
        <button class="btn" type="button" @click="exportRows">导出安全巡检清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">当前身份：{{ roleLabel(store.role) }}</span>
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
          <td v-for="column in columns" :key="column">{{ displayValue(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button
              v-if="row.status === '待整改' && store.isSafety"
              class="link"
              type="button"
              @click="addConclusion(row)"
            >
              补整改结论
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无安全巡检数据，可先登记巡检记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡检记录 · 其中来源应急演练、待闭环 {{ drillPendingClose }} 条（与应急演练页同一份同一数）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}<button v-if="loadFailed" class="link" style="margin-left: 8px" type="button" @click="reload">重试取数</button></span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  readWithRetry,
  runAction as applyAction,
} from '@/api/local-service'
import {
  canSafetyAction,
  closeLinkedIssue,
  migrateLegacyRectifications,
  pendingCloseCount,
  submitIssueConclusion,
} from '@/api/rectification'
import { roleLabel, useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('safety')
const store = useSessionStore()
const columns = ["巡检编号", "巡检区域", "巡检项目", "发现问题", "隐患等级", "整改期限", "整改措施", "整改结论", "问题来源", "来源演练编号", "巡检人员"]
const actions = ["提交巡检", "派发整改", "确认闭环"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const drillPendingClose = ref(0)
const errorMessage = ref('')
const loadFailed = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = ["巡检编号", "巡检区域", "巡检项目"]

const stats = computed(() => [
  { label: '待巡检区域', value: rows.value.filter((row) => row.status === '待巡检').length },
  { label: '待整改隐患', value: rows.value.filter((row) => row.status === '待整改').length },
  { label: '待闭环演练问题', value: drillPendingClose.value },
])
const statusSummary = computed(() =>
  (['待巡检', '已巡检', '待整改', '已闭环'] as string[]).map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function displayValue(row: EntryRow, column: string): string {
  const value = row[column]
  if (value === undefined || value === '') {
    return column === '问题来源' ? '常规巡检' : '—'
  }
  return String(value)
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
  const denied = canSafetyAction(action, store.role)
  if (denied) {
    errorMessage.value = denied.message
    return
  }
  // 演练派生问题的闭环走同一事务口，普通巡检问题走通用状态机——写的都是清单里同一条。
  if (action === '确认闭环' && row['问题来源'] === '应急演练') {
    const result = closeLinkedIssue(Number(row['来源演练ID']), store.role)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    reload()
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function addConclusion(row: EntryRow) {
  errorMessage.value = ''
  const value = window.prompt('登记整改结论（同步回同一份演练记录）', String(row['整改结论'] ?? ''))
  if (value === null) {
    return
  }
  const result = submitIssueConclusion(Number(row.id), value, store.role)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

async function reload() {
  errorMessage.value = ''
  loadFailed.value = false
  try {
    await readWithRetry(() => migrateLegacyRectifications())
    const payload = await readWithRetry(() => listEntries(meta.key, filters.value))
    rows.value = payload.items
    total.value = payload.total
    drillPendingClose.value = await readWithRetry(() => pendingCloseCount())
  } catch (error) {
    loadFailed.value = true
    errorMessage.value = error instanceof Error ? error.message : '安全巡检列表读取失败'
  }
}

onMounted(reload)
</script>
