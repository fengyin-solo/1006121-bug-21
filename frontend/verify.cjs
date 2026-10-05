/* 端到端校验：localStorage 桩 + 真实业务代码，验证整改登记的各项约束。 */
const assert = require('node:assert')

function createMemoryStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    dump: () => Object.fromEntries(map),
  }
}
globalThis.window = { localStorage: createMemoryStorage() }

async function main() {
  const mod = await import('./dist-test/all.mjs')
  const { registerRectification, getRectificationDraft, pendingCloseCount,
    migrateLegacyRectifications, calcDeadline, closeLinkedIssue, updateDrillSubject,
    submitIssueConclusion, listRows, stateSnapshot, storageKey } = mod

  // 0) 期限统一口径
  assert.equal(calcDeadline('2026-10-05', '重大隐患'), '2026-10-06')
  assert.equal(calcDeadline('2026-10-05', '较大隐患'), '2026-10-08')
  assert.equal(calcDeadline('2026-10-05', '一般隐患'), '2026-10-12')

  // 存量补录：seed 里 DRIL-0005 是历史「已整改」，按演练日期补到巡检清单
  migrateLegacyRectifications()
  let ops = stateSnapshot().ops
  assert.ok(ops['5'], '存量已整改演练应补幂等日志')
  assert.equal(ops['5'].date, '2026-08-25', '按原整改日期补录')
  const legacyIssue = listRows('safety').find((r) => Number(r['来源演练ID']) === 5)
  assert.ok(legacyIssue && legacyIssue.status === '待整改', '存量问题落到巡检清单且待闭环')
  assert.equal(pendingCloseCount(), 1)

  // 越权：参演班组 / 安全员都不能登记整改
  let r = registerRectification({ drillId: 3, measure: 'm', level: '一般隐患', roster: '一班', conclusion: '' }, 'crew')
  assert.equal(r.ok, false); assert.match(r.message, /权限校验/)
  r = registerRectification({ drillId: 3, measure: 'm', level: '一般隐患', roster: '一班', conclusion: '' }, 'safety')
  assert.equal(r.ok, false); assert.match(r.message, /权限校验/)

  // 越级：待策划(1)不能直接登记整改
  r = registerRectification({ drillId: 1, measure: 'm', level: '一般隐患', roster: '一班', conclusion: '' }, 'organizer')
  assert.equal(r.ok, false); assert.match(r.message, /状态流转/)

  // 完整性：措施或班组缺失整笔退回，不留半条
  const beforeCount = listRows('safety').length
  r = registerRectification({ drillId: 3, measure: '', level: '一般隐患', roster: '一班', conclusion: '' }, 'organizer')
  assert.equal(r.ok, false); assert.match(r.message, /完整性校验/)
  assert.equal(listRows('safety').length, beforeCount, '退回后巡检清单条数不变')
  assert.equal(listRows('drill').find((x) => x.id === 3).status, '已完成', '演练状态未被半写')

  // 正常整笔落库
  r = registerRectification({ drillId: 3, measure: '补齐疏散标识并组织二次撤离', level: '较大隐患', roster: '盾构施工一班、综合保障班', conclusion: '', date: '2026-10-05' }, 'organizer')
  assert.equal(r.ok, true, r.message)
  const drill = listRows('drill').find((x) => x.id === 3)
  assert.equal(drill.status, '已整改')
  assert.equal(drill['演练进度'], '已整改')
  assert.equal(drill['整改措施'], '补齐疏散标识并组织二次撤离')
  assert.equal(drill['参演班组名单'], '盾构施工一班、综合保障班')
  assert.equal(drill['整改期限'], '2026-10-08')
  const issue = listRows('safety').find((x) => Number(x['来源演练ID']) === 3)
  assert.ok(issue, '整改问题落到安全巡检清单')
  assert.equal(issue['整改期限'], '2026-10-08', '两侧期限同一算法同一份')
  assert.equal(pendingCloseCount(), 2, '两处待闭环数对得上（5、3）')

  // 幂等：第二遍只认第一次，日期不被覆盖
  r = registerRectification({ drillId: 3, measure: '第二次想覆盖', level: '重大隐患', roster: '别的班组', conclusion: '', date: '2026-10-09' }, 'organizer')
  assert.equal(r.ok, false); assert.match(r.message, /幂等校验|状态流转/)
  const again = listRows('drill').find((x) => x.id === 3)
  assert.equal(again['整改措施'], '补齐疏散标识并组织二次撤离')
  assert.equal(again['整改日期'], '2026-10-05', '整改日期仍按头一条')
  const dupes = listRows('safety').filter((x) => Number(x['来源演练ID']) === 3)
  assert.equal(dupes.length, 1, '点两回只落一条')

  // 已整改演练不许改科目
  r = updateDrillSubject(3, '改掉的科目', 'organizer')
  assert.equal(r.ok, false); assert.match(r.message, /锁定校验/)
  assert.equal(listRows('drill').find((x) => x.id === 3)['演练科目'], '消防火灾疏散应急演练')
  // 未整改可改
  r = updateDrillSubject(1, '新科目', 'organizer')
  assert.equal(r.ok, true)

  // 闭环权限：组织人不能闭环，安全员可以
  r = closeLinkedIssue(3, 'organizer')
  assert.equal(r.ok, false); assert.match(r.message, /权限校验/)
  r = closeLinkedIssue(3, 'safety')
  assert.equal(r.ok, true)
  assert.equal(pendingCloseCount(), 1, '闭环后待闭环只剩存量 5')

  // 结论同源：安全员在巡检侧补结论，演练侧读到同一份
  r = submitIssueConclusion(Number(issue.id), '已复查通过', 'organizer')
  assert.equal(r.ok, false); assert.match(r.message, /权限校验/)
  r = submitIssueConclusion(Number(issue.id), '已复查通过', 'safety')
  assert.equal(r.ok, true)
  assert.equal(listRows('drill').find((x) => x.id === 3)['整改结论'], '已复查通过')
  assert.equal(listRows('safety').find((x) => Number(x.id) === Number(issue.id))['整改结论'], '已复查通过')

  // 回显取自同一份
  const draft = getRectificationDraft(3)
  assert.equal(draft.measure, '补齐疏散标识并组织二次撤离')
  assert.equal(draft.deadline, '2026-10-08')

  // 只有一个存储 key，且整笔是同一份 JSON
  const dumped = window.localStorage.dump()
  const keys = Object.keys(dumped)
  assert.deepEqual(keys, [storageKey()], '两侧只留一份存储')
  const persisted = JSON.parse(dumped[storageKey()])
  assert.ok(persisted.entries.drill && persisted.entries.safety && persisted.ops['3'])

  console.log('全部断言通过 ✔')
}

main().catch((e) => { console.error(e); process.exit(1) })
