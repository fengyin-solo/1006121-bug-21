<template>
  <section class="page" data-module="drill">
    <header class="page-head">
      <div>
        <h2>应急演练管理</h2>
        <p class="page-desc">登记整改一次落到底：整改措施、演练进度、参演班组名单与安全巡检整改问题清单写进同一份，写不全整笔退回。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记应急演练</button>
        <button class="btn" type="button" @click="exportRows">导出应急演练清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待策划演练</span>
        <strong class="stat-value">{{ drillStat.pendingPlan }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已完成演练</span>
        <strong class="stat-value">{{ drillStat.completed }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待整改问题（与巡检清单同源）</span>
        <strong class="stat-value">{{ drillStat.pendingRectify }}</strong>
      </article>
      <article v-if="drillStat.queue" class="stat-card">
        <span class="stat-label">待续办整改（中断断点）</span>
        <strong class="stat-value">{{ drillStat.queue }}</strong>
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
            <template v-for="action in availableActions" :key="action">
              <button
                v-if="actionAllowed(action, row)"
                class="link"
                type="button"
                :disabled="submitting"
                @click="runAction(action, row)"
              >
                {{ actionLabel(action, row) }}
              </button>
            </template>
            <span v-if="!hasAnyAction(row)" class="muted-text">无可用动作（{{ roleHint }}）</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无应急演练数据，可先登记应急演练</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条应急演练记录；整改期限统一按「整改日期 + 7 个自然日」，以巡检整改清单那份为准</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="formOpen" class="modal-mask" @click.self="closeForm">
      <form class="modal-card" @submit.prevent="confirmRectification">
        <h3>登记整改 · {{ formRow?.['演练编号'] }}</h3>
        <p class="page-desc">
          整改日期取头一次提交（{{ formDateText }}），重复提交不会改日期；
          整改措施、参演班组名单、整改结论写全才落库。
        </p>
        <label class="form-item">
          <span>整改措施 *</span>
          <textarea v-model="form.measures" rows="3" placeholder="填写针对发现问题的整改措施"></textarea>
        </label>
        <label class="form-item">
          <span>参演班组名单 *</span>
          <textarea v-model="form.crewList" rows="2" placeholder="如：掘进一班、机电班（多个班组用顿号分隔）"></textarea>
        </label>
        <label class="form-item">
          <span>整改结论 *</span>
          <textarea v-model="form.conclusion" rows="2" placeholder="该结论将同步写入安全巡检整改问题清单"></textarea>
        </label>
        <label class="form-item">
          <span>整改日期</span>
          <input :value="formDateText" type="text" disabled />
        </label>
        <p class="form-hint">预计整改期限：{{ formDeadlineText }}（整改日期 + 7 个自然日，巡检清单同源）</p>
        <div class="modal-actions">
          <button class="btn" type="button" :disabled="submitting" @click="closeForm">取消</button>
          <button class="btn primary" type="submit" :disabled="submitting">
            {{ submitting ? '提交中…' : '提交整改（一次落到底）' }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, reactive, ref } from 'vue'

import {
  canRunAction,
  changeDrillSubject,
  downloadEntries,
  drainRectificationQueue,
  drillStats,
  listEntries,
  moduleMeta,
  queuedRectification,
  runAction as applyAction,
  submitRectification,
} from '@/api/local-service'
import type { EntryRow, RectificationPayload } from '@/data/types'
import { todayText } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const roleHint = computed(() => store.operator)

const meta = moduleMeta('drill')
// 「演练状态」字段在登记整改后由状态列同源带出，这里展示整改闭环所需的全部同写字段。
const columns = ["演练编号", "演练科目", "演练日期", "参与班组", "演练时长", "发现问题", "整改措施", "整改结论", "整改日期", "整改期限", "整改单号"]
const availableActions = ["提交方案", "确认完成", "登记整改", "修改科目"]
const statuses = ["待策划", "已策划", "已完成", "已整改"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const submitting = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = ["演练编号", "演练科目", "演练日期"]
const drillStat = ref({ pendingPlan: 0, completed: 0, pendingRectify: 0, queue: 0, queuedIds: [] as number[] })
// 队列里挂着断点的演练 id：只有这些已整改行才给「续办整改」入口。
const queuedIds = computed(() => new Set(drillStat.value.queuedIds))

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 整改登记表单
const formOpen = ref(false)
const formRow = ref<EntryRow | null>(null)
const form = reactive<RectificationPayload>({ measures: '', crewList: '', conclusion: '' })
const formDateText = ref('')
const formDeadlineText = computed(() => {
  const [y, m, d] = formDateText.value.split('-').map(Number)
  if (!y || !m || !d) {
    return ''
  }
  const base = new Date(y, m - 1, d)
  base.setDate(base.getDate() + 7)
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`
})

// 已整改的记录里若队列残留同一条（中断未走完），按钮提示续办。
function actionLabel(action: string, row: EntryRow): string {
  if (action === '登记整改' && String(row.status) === '已整改') {
    return '续办整改'
  }
  return action
}

function actionAllowed(action: string, row: EntryRow): boolean {
  if (!canRunAction(meta.key, action, store.role)) {
    return false
  }
  const status = String(row.status)
  if (action === '提交方案') {
    return status === '待策划'
  }
  if (action === '确认完成') {
    return status === '已策划'
  }
  if (action === '登记整改') {
    // 已完成可登记；已整改但队列里还挂着这一条（写了一半）可续办，其余已整改不再出现按钮。
    if (status === '已完成') {
      return true
    }
    if (status === '已整改') {
      return queuedIds.value.has(Number(row.id))
    }
    return false
  }
  if (action === '修改科目') {
    // 已完成整改的演练科目锁定，不许再改。
    return status !== '已整改'
  }
  return true
}

function hasAnyAction(row: EntryRow): boolean {
  return availableActions.some((action) => actionAllowed(action, row))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '应急演练登记入口尚未接入审批流'
}

function openRectification(row: EntryRow) {
  formRow.value = row
  // 续办时预填队列里那版（断掉时已填、尚未落库）；首次登记以演练记录为底。
  const draft = queuedRectification(Number(row.id))
  form.measures = draft?.measures ?? String(row.整改措施 ?? '')
  form.crewList = draft?.crewList ?? String(row.参与班组 ?? '')
  form.conclusion = draft?.conclusion ?? String(row.整改结论 ?? '')
  // 整改日期始终认头一次：已填过（含队列断点）就显示那份，否则取今天。
  formDateText.value = String(row.整改日期 ?? '') || todayText()
  formOpen.value = true
}

function closeForm() {
  if (submitting.value) {
    return
  }
  formOpen.value = false
  formRow.value = null
}

function confirmRectification() {
  if (!formRow.value) {
    return
  }
  submitting.value = true
  errorMessage.value = ''
  try {
    const result = submitRectification(Number(formRow.value.id), { ...form }, store.role)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    errorMessage.value = ''
    formOpen.value = false
    formRow.value = null
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '登记整改失败，请重试'
  } finally {
    submitting.value = false
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '登记整改') {
    openRectification(row)
    return
  }
  if (action === '修改科目') {
    const subject = window.prompt('修改演练科目（已整改的演练锁定不可改）：', String(row.演练科目 ?? ''))
    if (subject === null) {
      return
    }
    const result = changeDrillSubject(Number(row.id), subject, store.role)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    reload()
    return
  }
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
    // 进入/返回时先续办断掉的整改，再读落库那份，刷新后看到的就是同一份。
    drainRectificationQueue()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    drillStat.value = drillStats()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '应急演练列表读取失败，请重试'
  }
}

onMounted(reload)
onActivated(reload)
</script>

<style scoped>
.muted-text { color: var(--muted); font-size: 12px; }
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  width: 520px;
  max-width: calc(100vw - 32px);
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  box-shadow: 0 12px 40px rgba(15, 23, 42, 0.25);
}
.modal-card h3 { margin: 0 0 8px; font-size: 16px; }
.form-item { display: block; margin-bottom: 10px; }
.form-item span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.form-item textarea,
.form-item input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
}
.form-item input:disabled { background: #f1f5f9; color: var(--muted); }
.form-hint { font-size: 12px; color: var(--muted); margin: 4px 0 10px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.link:disabled { color: #94a3b8; cursor: not-allowed; }
</style>
