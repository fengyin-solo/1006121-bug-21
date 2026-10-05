<template>
  <section class="page" data-module="drill">
    <header class="page-head">
      <div>
        <h2>应急演练管理</h2>
        <p class="page-desc">登记整改一次落到底：整改措施、演练进度、参演班组名单与安全巡检整改问题同一份落库；重复提交只认第一次。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记应急演练</button>
        <button class="btn" type="button" @click="exportRows">导出应急演练清单</button>
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
          <td v-for="column in columns" :key="column">
            <template v-if="column === '演练科目' && row.status !== '已整改' && store.isOrganizer">
              <button class="link" type="button" @click="changeSubject(row)" :title="'点击修改演练科目'">{{ displayValue(row, column) }}</button>
            </template>
            <template v-else>{{ displayValue(row, column) }}</template>
            <span v-if="column === '演练科目' && row.status === '已整改'" class="lock-tag" title="已完成整改，科目锁定">🔒</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-for="action in availableActions(row)" :key="action">
              <button class="link" type="button" @click="runAction(action, row)">{{ action }}</button>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无应急演练数据，可先登记应急演练</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条应急演练记录 · 两侧待闭环演练问题 {{ pendingClose }} 条（与安全巡检清单同源同数）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}<button v-if="loadFailed" class="link retry-link" type="button" @click="reload">重试取数</button></span>
    </footer>

    <!-- 登记整改 / 整改回看：同一份落库数据，一个表单写、一个只读看 -->
    <div v-if="dialogOpen" class="modal-mask" @click.self="closeDialog">
      <div class="modal-card">
        <h3 class="modal-title">
          {{ dialogReadonly ? `整改回看 · ${dialogDrillNo}` : `登记整改 · ${dialogDrillNo}` }}
        </h3>
        <p class="modal-sub">
          {{ dialogRow ? `演练科目：${dialogRow['演练科目']} ｜ 演练日期：${dialogRow['演练日期']}` : '' }}
          <span v-if="dialogReadonly" class="lock-tag">已完成整改，科目与结论已锁定</span>
        </p>

        <div class="form-grid">
          <label class="form-item form-item-wide">
            <span>整改措施 <em>*</em></span>
            <textarea v-model="form.measure" rows="3" :readonly="dialogReadonly" placeholder="写清措施、责任人与完成标准"></textarea>
          </label>
          <label class="form-item">
            <span>隐患等级 <em>*</em></span>
            <select v-model="form.level" :disabled="dialogReadonly" @change="syncDeadline">
              <option v-for="level in levels" :key="level" :value="level">{{ level }}</option>
            </select>
          </label>
          <label class="form-item">
            <span>整改日期 <em>*</em></span>
            <input v-model="form.date" type="date" :readonly="dialogReadonly" @change="syncDeadline" />
          </label>
          <label class="form-item">
            <span>整改期限（统一口径）</span>
            <input :value="form.deadline" type="date" readonly />
            <small class="form-hint">登记日起算：重大1天 / 较大3天 / 一般7天</small>
          </label>
          <label class="form-item">
            <span>整改结论</span>
            <input v-model="form.conclusion" type="text" :readonly="dialogReadonly" placeholder="可留空，闭环前可在巡检侧补充" />
          </label>
          <label class="form-item form-item-wide">
            <span>参演班组名单 <em>*</em></span>
            <div v-if="!dialogReadonly" class="roster-pick">
              <label v-for="crew in crewOptions" :key="crew" class="roster-chip">
                <input type="checkbox" :checked="rosterChecked(crew)" @change="toggleCrew(crew)" />
                {{ crew }}
              </label>
            </div>
            <textarea v-model="form.roster" rows="2" :readonly="dialogReadonly" placeholder="参演班组，多个班组以顿号/逗号分隔"></textarea>
          </label>
        </div>

        <p class="form-note">提交后整改措施、演练进度（已整改）、参演班组名单与安全巡检整改问题清单同一笔事务落库；写不全整笔退回，重复点两回只认第一次。</p>

        <div class="modal-foot">
          <button class="btn" type="button" @click="closeDialog">{{ dialogReadonly ? '关闭' : '取消' }}</button>
          <button v-if="!dialogReadonly" class="btn primary" type="button" :disabled="submitting" @click="submitForm">
            {{ submitting ? '正在整笔落库…' : '提交整改（一笔落到底）' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, readWithRetry, runAction as applyAction } from '@/api/local-service'
import {
  calcDeadline,
  closeLinkedIssue,
  getRectificationDraft,
  hazardLevels,
  migrateLegacyRectifications,
  pendingCloseCount,
  registerRectification,
  todayText,
  updateDrillSubject,
} from '@/api/rectification'
import { listRows } from '@/data/local-store'
import { roleLabel, useSessionStore } from '@/stores/session'
import type { EntryRow, HazardLevel } from '@/data/types'

const store = useSessionStore()
const levels = hazardLevels()

const columns = ["演练编号", "演练科目", "演练日期", "参演班组名单", "演练时长", "发现问题", "整改措施", "整改结论", "隐患等级", "整改日期", "整改期限"]
const filterFields = ["演练编号", "演练科目", "演练日期"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const pendingClose = ref(0)
const errorMessage = ref('')
const loadFailed = ref(false)
const filters = ref<Record<string, string>>({})

const stats = computed(() => [
  { label: '待策划演练', value: rows.value.filter((row) => row.status === '待策划').length },
  { label: '已完成待整改', value: rows.value.filter((row) => row.status === '已完成').length },
  { label: '待闭环演练问题', value: pendingClose.value },
])
const statusSummary = computed(() =>
  (['待策划', '已策划', '已完成', '已整改'] as string[]).map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const crewOptions = computed(() =>
  listRows('crew')
    .filter((row) => String(row.status) === '在场')
    .map((row) => String(row['班组名称'] ?? ''))
    .filter(Boolean),
)

function displayValue(row: EntryRow, column: string): string {
  if (column === '参演班组名单') {
    return String(row['参演班组名单'] ?? row['参与班组'] ?? '—')
  }
  if (column === '整改结论' && row.status !== '已整改') {
    return '—'
  }
  const value = row[column]
  return value === undefined || value === '' ? '—' : String(value)
}

function availableActions(row: EntryRow): string[] {
  const status = String(row.status)
  const base = new Set<string>()
  if (status === '待策划') base.add('提交方案')
  if (status === '已策划') base.add('确认完成')
  if (status === '已完成') base.add('登记整改')
  if (status === '已整改') {
    base.add('查看整改')
    const linked = drillSourceIssue(row)
    if (linked && String(linked.status) !== '已闭环') base.add('催办闭环')
  }
  return [...base]
}

function drillSourceIssue(row: EntryRow): EntryRow | undefined {
  return listRows('safety').find((item) => Number(item['来源演练ID']) === Number(row.id))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('drill')
}

function openCreate() {
  errorMessage.value = '应急演练登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '登记整改') {
    openRectification(row, false)
    return
  }
  if (action === '查看整改') {
    openRectification(row, true)
    return
  }
  if (action === '催办闭环') {
    const result = closeLinkedIssue(Number(row.id), store.role)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    reload()
    return
  }
  // 通用状态流转（提交方案/确认完成）仍走统一状态机，登记整改已从这里拆出。
  const result = applyAction('drill', Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

// —— 登记整改弹窗 ——
const dialogOpen = ref(false)
const dialogReadonly = ref(false)
const submitting = ref(false)
const dialogDrillId = ref(0)
const dialogDrillNo = ref('')
const dialogRow = ref<EntryRow | null>(null)

const form = reactive({
  measure: '',
  level: '一般隐患' as HazardLevel,
  roster: '',
  conclusion: '',
  date: todayText(),
  deadline: '',
})

function syncDeadline() {
  try {
    form.deadline = form.date ? calcDeadline(form.date, form.level) : ''
  } catch (error) {
    form.deadline = ''
  }
}

function openRectification(row: EntryRow, readonly: boolean) {
  errorMessage.value = ''
  if (!readonly && store.role !== 'organizer') {
    errorMessage.value = `已拦在「权限校验」环：当前身份是${roleLabel(store.role)}，只有组织人能登记整改`
    return
  }
  const draft = getRectificationDraft(Number(row.id))
  if (!draft) {
    errorMessage.value = '已拦在「取数校验」环：取不到这条演练的落库数据，请重试'
    return
  }
  dialogDrillId.value = Number(row.id)
  dialogDrillNo.value = String(row['演练编号'] ?? '')
  dialogRow.value = row
  dialogReadonly.value = readonly
  form.measure = draft.measure
  form.level = draft.level
  form.roster = draft.roster
  form.conclusion = draft.conclusion
  form.date = draft.op?.date ?? todayText()
  syncDeadline()
  // 已落库的那一份期限优先，避免与算法结果不一致时看错。
  if (readonly && draft.deadline) {
    form.deadline = draft.deadline
  }
  dialogOpen.value = true
}

function closeDialog() {
  if (submitting.value) {
    return
  }
  dialogOpen.value = false
}

const ROSTER_SPLIT = /[、,，\s]+/

function rosterChecked(crew: string): boolean {
  return form.roster
    .split(ROSTER_SPLIT)
    .map((item) => item.trim())
    .includes(crew)
}

function toggleCrew(crew: string) {
  const selected = new Set(
    form.roster
      .split(ROSTER_SPLIT)
      .map((item) => item.trim())
      .filter(Boolean),
  )
  if (selected.has(crew)) {
    selected.delete(crew)
  } else {
    selected.add(crew)
  }
  form.roster = [...selected].join('、')
}

function submitForm() {
  errorMessage.value = ''
  submitting.value = true
  try {
    const result = registerRectification(
      {
        drillId: dialogDrillId.value,
        measure: form.measure,
        level: form.level,
        roster: form.roster,
        conclusion: form.conclusion,
        date: form.date,
      },
      store.role,
    )
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    dialogOpen.value = false
    reload()
  } catch (error) {
    // 入库失败：事务已整笔退回，明确告诉用户没落半条。
    errorMessage.value = error instanceof Error ? error.message : '入库失败，已整笔退回'
  } finally {
    submitting.value = false
  }
}

// 科目修改入口走服务层锁定校验（已整改一律拦下）。
function changeSubject(row: EntryRow) {
  if (store.role !== 'organizer') {
    errorMessage.value = `已拦在「权限校验」环：当前身份是${roleLabel(store.role)}，只有组织人能修改演练科目`
    return
  }
  if (String(row.status) === '已整改') {
    errorMessage.value = '已拦在「锁定校验」环：演练已完成整改，演练科目已锁定，不许再改'
    return
  }
  const value = window.prompt('修改演练科目', String(row['演练科目'] ?? ''))
  if (value === null) {
    return
  }
  const result = updateDrillSubject(Number(row.id), value, store.role)
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
    // 先把存量「已整改」演练按演练日期补录到巡检清单；一条一事务，中断下次从断点继续。
    await readWithRetry(() => migrateLegacyRectifications())
    const payload = await readWithRetry(() => listEntries('drill', filters.value))
    rows.value = payload.items
    total.value = payload.total
    pendingClose.value = await readWithRetry(() => pendingCloseCount())
  } catch (error) {
    // 取不到数据就重试，绝不拿 seed 上一版顶回来。
    loadFailed.value = true
    errorMessage.value = error instanceof Error ? error.message : '应急演练列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.retry-link {
  margin-left: 8px;
}
.lock-tag {
  display: inline-block;
  margin-left: 6px;
  font-size: 12px;
  color: #b42318;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal-card {
  width: 720px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 60px);
  overflow: auto;
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.25);
}
.modal-title { margin: 0; font-size: 16px; }
.modal-sub { margin: 6px 0 12px; font-size: 13px; color: var(--muted); }
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.form-item { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.form-item-wide { grid-column: 1 / -1; }
.form-item em { color: #b42318; font-style: normal; }
.form-item input,
.form-item textarea,
.form-item select {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
}
.form-item input[readonly],
.form-item textarea[readonly] {
  background: #f1f5f9;
  color: #334155;
}
.form-hint { color: var(--muted); }
.roster-pick { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
.roster-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.form-note {
  margin: 12px 0 0;
  padding: 8px 10px;
  background: #eef2ff;
  border-radius: 6px;
  font-size: 12px;
  color: #3730a3;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
</style>
