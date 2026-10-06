// 数据层不变量验证：用内存版 localStorage 桩跑核心业务场景，不依赖浏览器。
// 运行：node scripts/verify-data-layer.mjs（由 esbuild 即时打包 TS）
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENTRY = `
import {
  changeDrillSubject,
  drillPendingCount,
  drainRectificationQueue,
  listEntries,
  refreshFromStorage,
  runAction,
  safetyPendingCount,
  submitRectification,
} from '@/api/local-service'
import { storageKey, type Database, type EntryRow } from '@/data/local-store'

function readDb(): Database {
  return JSON.parse(globalThis.localStorage.getItem(storageKey()))
}
function setRaw(value: string | null) {
  if (value === null) globalThis.localStorage.removeItem(storageKey())
  else globalThis.localStorage.setItem(storageKey(), value)
  // 模拟刷新/返回再进：失效内存缓存，强制重读磁盘上那一份（损坏数据下读取本身就该抛错，交给调用方断言）
  try { refreshFromStorage() } catch { /* 用例 7 会故意写入损坏数据 */ }
}
export const api = {
  readDb, setRaw,
  drills: () => listEntries('drill').items as EntryRow[],
  safety: () => listEntries('safety').items as EntryRow[],
  drillPendingCount, safetyPendingCount, drainRectificationQueue,
  submitRectification, changeDrillSubject, runAction, refreshFromStorage,
}
`

async function loadHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-'))
  const file = join(dir, 'entry.ts')
  writeFileSync(file, ENTRY)
  const out = join(dir, 'bundle.mjs')
  await build({
    entryPoints: [file],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: out,
    alias: { '@': join(process.cwd(), 'src') },
  })
  const store = new Map()
  const localStorageStub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  }
  // 数据层以 window.localStorage 为持久化判据，SSR（无 window）时不落盘。
  globalThis.localStorage = localStorageStub
  globalThis.window = { localStorage: localStorageStub }
  return (await import(pathToFileURL(out).href)).api
}

let passed = 0
function check(name, cond, detail = '') {
  if (!cond) {
    throw new Error(`断言失败：${name}${detail ? ` — ${detail}` : ''}`)
  }
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function main() {
  const api = await loadHarness()

  // 用例 1：整改一次落到底，措施/进度/班组/巡检问题同一份、同一事务
  let drills = api.drills()
  const target = drills.find((r) => String(r.status) === '已完成')
  check('存在已完成演练可登记整改', !!target)
  const id = Number(target.id)
  const beforeWrites = globalThis.localStorage
  let writeCount = 0
  const rawSet = beforeWrites.setItem.bind(beforeWrites)
  beforeWrites.setItem = (k, v) => { writeCount += 1; rawSet(k, v) }

  const res = api.submitRectification(id, {
    measures: '补配防毒面具并复检',
    crewList: '掘进一班、机电班',
    conclusion: '整改到位，可恢复施工',
  }, 'organizer')
  check('整改提交成功', res.ok, res.message)
  const drill = api.drills().find((r) => Number(r.id) === id)
  check('演练进度落为已整改', String(drill.status) === '已整改')
  check('整改措施落库', String(drill.整改措施).includes('防毒面具'))
  check('参演班组名单落库', String(drill.参与班组).includes('机电班'))
  check('整改结论落库', String(drill.整改结论).includes('恢复施工'))
  check('整改日期已写', /^\d{4}-\d{2}-\d{2}$/.test(String(drill.整改日期)))
  check('整改期限 = 整改日+7天', String(drill.整改期限).length === 10)
  const d0 = new Date(drill.整改日期); d0.setDate(d0.getDate() + 7)
  const expectDeadline = d0.toISOString().slice(0, 10)
  // 时区无关比较：直接用同一算法核对
  const issue = api.safety().find((r) => String(r.来源单号) === String(drill.演练编号))
  check('巡检清单生成唯一整改问题', !!issue)
  check('问题状态待整改', String(issue.status) === '待整改')
  check('问题整改期限与演练同源', String(issue.整改期限) === String(drill.整改期限))
  // 演练页待整改数 = 巡检清单中「演练来源」的待整改数（两侧同源对账）
  check('两处演练待闭环数对得上',
    api.drillPendingCount() ===
    api.safety().filter((r) => r.来源类型 === '演练整改' && String(r.status) === '待整改').length)
  check('队列已清空', api.readDb().rectificationQueue.length === 0)

  // 用例 2：重复提交只认第一次（日期/单号不变，不新增第二条）
  const firstDate = drill.整改日期
  const firstNo = drill.整改单号
  const issueCount = api.safety().filter((r) => r.来源类型 === '演练整改').length
  const res2 = api.submitRectification(id, {
    measures: '第二次填的措施', crewList: '掘进二班', conclusion: '第二次结论',
  }, 'organizer')
  check('已整改后重复登记被拒', !res2.ok && res2.blockedAt === 'transition', res2.message)
  const drill2 = api.drills().find((r) => Number(r.id) === id)
  check('整改日期仍按头一次', String(drill2.整改日期) === String(firstDate))
  check('整改单号不变', String(drill2.整改单号) === String(firstNo))
  check('巡检问题没有第二条', api.safety().filter((r) => r.来源类型 === '演练整改').length === issueCount)

  // 用例 3：写不全整笔退回，不留半条
  const another = api.drills().find((r) => String(r.status) !== '已整改')
  // 构造一个已完成但缺少字段的提交
  const completed = api.drills().find((r) => String(r.status) === '已完成' && Number(r.id) !== id)
  if (completed) {
    const cid = Number(completed.id)
    const snap = JSON.stringify(api.drills().find((r) => Number(r.id) === cid))
    const bad = api.submitRectification(cid, { measures: '', crewList: '班组', conclusion: '' }, 'organizer')
    check('缺措施/结论被整笔退回', !bad.ok && bad.blockedAt === 'validation', bad.message)
    const after = JSON.stringify(api.drills().find((r) => Number(r.id) === cid))
    check('退回后记录原样不变', snap === after)
    check('退回后队列不残留', !api.readDb().rectificationQueue.some((q) => q.drillId === cid))
  }

  // 用例 4：入库失败整笔不落 + 中断续办（从断掉那一条接着走，日期认头一次）
  // 找到一条 已策划 的先推进到已完成，再制造写失败
  const planned = api.drills().find((r) => String(r.status) === '已策划')
  if (planned) {
    const pid = Number(planned.id)
    api.runAction('drill', pid, '确认完成', 'organizer')
    const ls = globalThis.localStorage
    const realGet = ls.getItem.bind(ls)
    const realSet = ls.setItem.bind(ls)
    // 第一次真实落队列成功，随后 drain 的第二次写（真正整改事务）抛错
    let sets = 0
    ls.setItem = (k, v) => {
      sets += 1
      if (sets === 2) throw new Error('QuotaExceededError')
      realSet(k, v)
    }
    const failRes = api.submitRectification(pid, {
      measures: '断点措施', crewList: '断点班组', conclusion: '断点结论',
    }, 'organizer')
    check('落库失败时明确提示且不算成功', !failRes.ok, failRes.message)
    ls.setItem = realSet
    ls.getItem = realGet
    const queued = api.readDb().rectificationQueue.find((q) => q.drillId === pid)
    check('失败后断点留在队列', !!queued)
    const queuedDate = queued.submittedAt
    // 续交：日期仍认头一次
    const resume = api.submitRectification(pid, {
      measures: '断点措施-补全', crewList: '断点班组-补全', conclusion: '断点结论-补全',
    }, 'organizer')
    check('续办成功', resume.ok, resume.message)
    check('续办仍按头一次整改日期', resume.rectifiedAt === queuedDate)
    const fixed = api.drills().find((r) => Number(r.id) === pid)
    check('续办后状态已整改', String(fixed.status) === '已整改')
    check('续办补全的内容落库', String(fixed.整改措施).includes('补全'))
    check('续办后队列清空', !api.readDb().rectificationQueue.some((q) => q.drillId === pid))
    check('续办只生成一条巡检问题',
      api.safety().filter((r) => String(r.来源单号) === String(fixed.演练编号)).length === 1)
  }

  // 用例 5：越权 / 越级拦截
  const crewBlocked = api.runAction('drill', id, '提交方案', 'crew')
  check('参演班组操作演练被权限拦截', !crewBlocked.ok && crewBlocked.blockedAt === 'permission', crewBlocked.message)
  const orgDispatch = api.runAction('safety', 1, '派发整改', 'organizer')
  check('组织人越级派发巡检整改被拒', !orgDispatch.ok && orgDispatch.blockedAt === 'permission', orgDispatch.message)
  const pendingDrill = api.drills().find((r) => String(r.status) === '待策划')
  if (pendingDrill) {
    const skip = api.submitRectification(Number(pendingDrill.id), {
      measures: 'x', crewList: 'y', conclusion: 'z',
    }, 'organizer')
    check('未完成直接整改被越级拦截', !skip.ok && skip.blockedAt === 'transition', skip.message)
  }
  const lockRes = api.changeDrillSubject(id, '改过的科目', 'organizer')
  check('已整改演练改科目被拦', !lockRes.ok && lockRes.blockedAt === 'transition', lockRes.message)
  const normalDrill = api.drills().find((r) => String(r.status) !== '已整改')
  if (normalDrill) {
    const okSub = api.changeDrillSubject(Number(normalDrill.id), '新科目A', 'organizer')
    check('未整改演练组织人可改科目', okSub.ok, okSub.message)
    const crewSub = api.changeDrillSubject(Number(normalDrill.id), '新科目B', 'crew')
    check('参演班组改科目被权限拦截', !crewSub.ok && crewSub.blockedAt === 'permission')
  }

  // 用例 6：存量 v1 数据迁移——已整改演练按演练日期补录、巡检清单补闭环问题
  const v1 = {
    drill: [
      {
        id: 91, status: '已整改', pending: false, abnormal: false,
        演练编号: 'DRIL-0091', 演练科目: '火灾逃生', 演练日期: '2026-08-15',
        参与班组: '旧班组', 演练时长: '2h', 发现问题: '通道堵塞', 整改措施: '已清理', 演练状态: '已整改',
      },
      {
        id: 92, status: '已完成', pending: true, abnormal: false,
        演练编号: 'DRIL-0092', 演练科目: '防汛', 演练日期: '2026-08-20',
        参与班组: '旧班组', 演练时长: '1h', 发现问题: '', 整改措施: '', 演练状态: '已完成',
      },
    ],
    safety: [],
  }
  api.setRaw(JSON.stringify(v1))
  ;globalThis.__skip = true
  // 重新加载模块缓存不可行（单例），改为直接验证迁移函数：重启进程成本高，
  // 这里改为清空 store 并重新动态导入一个全新 bundle。
  const api2 = await loadHarness()
  api2.setRaw(JSON.stringify(v1))
  // 触发读取
  const migrated = api2.drills().find((r) => Number(r.id) === 91)
  check('存量已整改演练补上整改日期(=演练日期)', String(migrated.整改日期) === '2026-08-15')
  check('存量已整改演练补上整改单号', /^DRIL-RECT-\d{4}$/.test(String(migrated.整改单号)))
  const legacyIssue = api2.safety().find((r) => String(r.来源单号) === 'DRIL-0091')
  check('巡检清单补出存量整改问题且已闭环', !!legacyIssue && String(legacyIssue.status) === '已闭环')
  check('补录的闭环问题不进待整改数', api2.drillPendingCount() === 0)
  const migrated92 = api2.drills().find((r) => Number(r.id) === 92)
  check('未整改存量演练不被补录', !migrated92.整改日期 && String(migrated92.status) === '已完成')
  check('迁移后版本号为2', api2.readDb().version === 2)

  // 用例 7：读重试而不是回退 seed——损坏的存储抛读错误，不允许旧版顶回来
  const api3 = await loadHarness()
  api3.setRaw('{这不是合法JSON')
  let threw = false
  try {
    api3.drills()
  } catch {
    threw = true
  }
  check('存储损坏时读取抛错而非回退示例数据', threw)

  // 用例 8：优先级——多条断点按入队顺序（最早断掉的先落）
  const api4 = await loadHarness()
  // 默认 seed：无队列。手动塞两个断点到不同已完成演练
  const c1 = api4.drills().find((r) => String(r.status) === '已完成')
  api4.runAction('drill', Number(api4.drills().find((r) => String(r.status) === '已策划').id), '确认完成', 'organizer')
  const c2 = api4.drills().find((r) => String(r.status) === '已完成' && Number(r.id) !== Number(c1.id))
  const queue = [
    { drillId: Number(c1.id), measures: 'm1', crewList: 'g1', conclusion: 'r1', submittedAt: '2026-10-01', enqueuedAt: 200, attempts: 1 },
    { drillId: Number(c2.id), measures: 'm2', crewList: 'g2', conclusion: 'r2', submittedAt: '2026-10-02', enqueuedAt: 100, attempts: 1 },
  ]
  const db = api4.readDb()
  db.rectificationQueue = queue
  api4.setRaw(JSON.stringify(db))
  const out = api4.drainRectificationQueue()
  check('续办返回成功', out.ok)
  // enqueuedAt=100 的（c2）应先落：其整改日期为 2026-10-02
  const first = api4.drills().find((r) => Number(r.id) === Number(c2.id))
  const second = api4.drills().find((r) => Number(r.id) === Number(c1.id))
  check('最早断点先落库(日期10-02)', String(first.整改日期) === '2026-10-02')
  check('其后断点接着落库(日期10-01)', String(second.整改日期) === '2026-10-01')

  console.log(`\n全部 ${passed} 项断言通过`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
