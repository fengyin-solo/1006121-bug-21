<template>
  <section class="page" data-module="crew">
    <header class="page-head">
      <div>
        <h2>班组进场管理</h2>
        <p class="page-desc">维护施工班组，围绕班组编号、班组名称、主要工种、班组长做登记、筛选与状态流转；下方演练参与情况与应急演练页取同一份记录。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记施工班组</button>
        <button class="btn" type="button" @click="exportRows">导出班组进场清单</button>
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
      <span class="legend-item">当前身份：{{ roleLabel(store.role) }}（参演班组只读）</span>
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
              <button class="link" type="button" @click="runAction(action, row)">{{ action }}</button>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无班组进场数据，可先登记施工班组</td>
        </tr>
      </tbody>
    </table>

    <h3 class="sub-title">参演班组的演练与整改（与应急演练页同一份）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>班组名称</th>
          <th>演练编号</th>
          <th>演练科目</th>
          <th>演练日期</th>
          <th>整改措施</th>
          <th>整改期限</th>
          <th>整改进度</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in participation" :key="`${item.crew}-${item.drillId}`">
          <td>{{ item.crew }}</td>
          <td>{{ item.drillNo }}</td>
          <td>{{ item.subject }}</td>
          <td>{{ item.date }}</td>
          <td>{{ item.measure || '—' }}</td>
          <td>{{ item.deadline || '—' }}</td>
          <td>{{ item.status }}{{ item.closed ? ' · 巡检已闭环' : (item.status === '已整改' ? ' · 待巡检闭环' : '') }}</td>
        </tr>
        <tr v-if="!participation.length">
          <td colspan="7" class="empty-state">暂无参演记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条班组进场记录</span>
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
import { listRows } from '@/data/local-store'
import { roleLabel, useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('crew')
const store = useSessionStore()
const columns = ["班组编号", "班组名称", "主要工种", "班组长", "进场人数", "安全交底日期", "联系电话", "在场状态"]
const actions = ["办理进场", "办理退场", "登记停工"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const loadFailed = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '在场班组', value: rows.value.filter((row) => row.status === '在场').length },
  { label: '在场人数', value: rows.value.reduce((sum, row) => sum + (Number(row['进场人数']) || 0), 0) },
  { label: '停工班组', value: rows.value.filter((row) => row.status === '已停工').length },
])
const statusSummary = computed(() =>
  (['待进场', '在场', '已退场', '已停工'] as string[]).map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const ROSTER_SPLIT = /[、,，\s]+/
// 参演视图：不落第二份数据，直接把同一份演练记录按班组拆开读。
const participation = computed(() => {
  const closed = new Set(
    listRows('safety')
      .filter((row) => String(row.status) === '已闭环')
      .map((row) => Number(row['来源演练ID'])),
  )
  const view: {
    crew: string
    drillId: number
    drillNo: string
    subject: string
    date: string
    measure: string
    deadline: string
    status: string
    closed: boolean
  }[] = []
  for (const drill of listRows('drill')) {
    const roster = String(drill['参演班组名单'] ?? drill['参与班组'] ?? '')
    for (const crew of roster.split(ROSTER_SPLIT).map((item) => item.trim()).filter(Boolean)) {
      view.push({
        crew,
        drillId: Number(drill.id),
        drillNo: String(drill['演练编号'] ?? ''),
        subject: String(drill['演练科目'] ?? ''),
        date: String(drill['演练日期'] ?? ''),
        measure: String(drill['整改措施'] ?? ''),
        deadline: String(drill['整改期限'] ?? ''),
        status: String(drill.status),
        closed: closed.has(Number(drill.id)),
      })
    }
  }
  return view
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '施工班组登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  // 参演班组身份只读：班组台账动作也不允许越级操作。
  if (store.isCrew) {
    errorMessage.value = `已拦在「权限校验」环：当前身份是参演班组，对班组台账只有查看权`
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
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
    const payload = await readWithRetry(() => listEntries(meta.key, filters.value))
    rows.value = payload.items
    total.value = payload.total
    // participation 是 computed，读同一份存储；触发一下引用确保读取异常能被捕获。
    await readWithRetry(() => participation.value)
  } catch (error) {
    loadFailed.value = true
    errorMessage.value = error instanceof Error ? error.message : '班组进场列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.sub-title { margin: 20px 0 8px; font-size: 15px; }
</style>
