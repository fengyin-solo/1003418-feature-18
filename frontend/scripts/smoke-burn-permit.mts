// 用火审批领域规则冒烟测试：node 内跑，用内存版 localStorage 打桩。
// 运行：node --experimental-vm-modules 不需要，esbuild 打包后直接 node 执行。

const storage: Record<string, string> = {}
const listeners: ((event: { key: string | null }) => void)[] = []

;(globalThis as any).window = {
  localStorage: {
    getItem: (key: string) => (key in storage ? storage[key] : null),
    setItem: (key: string, value: string) => {
      storage[key] = value
    },
    removeItem: (key: string) => {
      delete storage[key]
    },
  },
  addEventListener: (_type: string, fn: (event: { key: string | null }) => void) => {
    listeners.push(fn)
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const {
  registerBurnPermit,
  submitBurnPermit,
  concludeBurnPermit,
  queryPending,
  locatePermit,
  parseWindow,
  BURN_KEY,
  LEDGER_KEY,
} = await import('../src/api/burn-permit.ts')
const { listRows, saveRows } = await import('../src/data/local-store.ts')
const { resetModule } = await import('../src/api/local-service.ts')

// 从干净状态开始（无 burnpermit / fireledger 种子）。
resetModule(BURN_KEY)
resetModule(LEDGER_KEY)

let failures = 0
function check(label: string, condition: boolean, extra = '') {
  if (condition) {
    console.log(`  ✅ ${label}`)
  } else {
    failures += 1
    console.error(`  ❌ ${label} ${extra}`)
  }
}

const DAY = 24 * 3600 * 1000
const dayOffset = (offset: number, hour = 0) => {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return new Date(d.getTime() + offset * DAY + hour * 3600 * 1000)
}
const dayText = (offset: number) => dayOffset(offset).toISOString().slice(0, 10)

console.log('1) 计划时段解析与非法时段拦截')
check('单日合法', parseWindow(dayText(5)) !== null)
check('日期+钟点段合法', parseWindow(`${dayText(5)} 08:00~11:00`) !== null)
check('跨天日期段合法', parseWindow(`${dayText(5)} 至 ${dayText(7)}`) !== null)
check('乱码非法', parseWindow('下礼拜一早') === null)
check('单个钟点非法', parseWindow('08:00') === null)
check('起止倒置非法', parseWindow(`${dayText(7)}~${dayText(5)}`) === null)

console.log('2) 登记非法时段拒绝入系统')
const bad = registerBurnPermit({ 申请单位: '甲林场', 计划时段: '瞎写的时段', 用火类型: '计划烧除' })
check('非法时段登记失败', !bad.ok, bad.message)

console.log('3) 提交两张同单位重叠单据：最早窗口保留，后单排队/拒绝')
const a = registerBurnPermit({
  申请单位: '甲林场',
  用火类型: '计划烧除',
  用火地点: '一号沟',
  计划时段: dayText(10),
  风险等级: '中',
})
check('登记 A 成功', a.ok, JSON.stringify(a))
const subA = submitBurnPermit(a.id!)
check('A 提交后进入待审批', subA.ok, subA.message)

const b = registerBurnPermit({
  申请单位: '甲林场',
  用火类型: '烧荒烧杂',
  用火地点: '二号沟',
  计划时段: `${dayText(10)} 08:00~10:00`,
  风险等级: '高',
})
const subB = submitBurnPermit(b.id!)
// B 是同单位更晚（同一天但起更晚）的重叠窗口：不允许入队。
check('同单位重叠后单被拒绝', !subB.ok && /更早窗口/.test(subB.message), subB.message)

console.log('4) 全局时段互斥排队：不同单位重叠也要排队，队首可审、队中不可审；不重叠窗口并行可审')
const c = registerBurnPermit({
  申请单位: '乙林场',
  用火类型: '计划烧除',
  用火地点: '三号沟',
  计划时段: dayText(12),
  风险等级: '高',
})
submitBurnPermit(c.id!)
await new Promise((resolve) => setTimeout(resolve, 5))
const d = registerBurnPermit({
  申请单位: '丙林场',
  用火类型: '焚烧疫木',
  用火地点: '四号沟',
  计划时段: dayText(10),
  风险等级: '高',
})
submitBurnPermit(d.id!)
let pending = queryPending({})
let byId = new Map(pending.map((view) => [Number(view.row.id), view]))
check('待审队列含 A/C/D 三张', pending.length === 3, `实际 ${pending.length}`)
check('A 在 day10 队首且待审批', String(byId.get(a.id!)?.row.status) === '待审批')
check('C 窗口不重叠，并行待审批', String(byId.get(c.id!)?.row.status) === '待审批')
check('D 与 A 全局时段重叠，排队中', String(byId.get(d.id!)?.row.status) === '排队中')
check('D 的前方阻塞单为 A', byId.get(d.id!)?.blockedBy === String(listRows(BURN_KEY).find((r) => Number(r.id) === a.id)!['审批编号']))
const concludeD = concludeBurnPermit(d.id!, '批准申请')
check('排队中单据不能先给结论', !concludeD.ok, concludeD.message)

console.log('5) 同单位更早的新单挤掉后单（只保留最早窗口）')
// E 是甲林场更早且与 A 重叠的窗口（跨越 day9 中午到 day10 中午）。
const e = registerBurnPermit({
  申请单位: '甲林场',
  用火类型: '计划烧除',
  用火地点: '五号沟',
  计划时段: `${dayText(9)} 12:00~${dayText(10)} 12:00`,
  风险等级: '低',
})
const subE = submitBurnPermit(e.id!)
check('更早窗口提交成功', subE.ok, subE.message)
const rowsAfter = listRows(BURN_KEY)
const aRow = rowsAfter.find((row) => Number(row.id) === a.id)!
check('原 A 单被作废', String(aRow.status) === '已作废', `实际 ${aRow.status}`)
// A 出队后，申请时间更早的 D 接 day10 队首，晚申请的 E 排在 D 后面。
const after5 = new Map(queryPending({}).map((view) => [Number(view.row.id), view]))
check('D 递补为 day10 队首（待审批）', String(after5.get(d.id!)?.row.status) === '待审批')
const dPermitNo = String(listRows(BURN_KEY).find((r) => Number(r.id) === d.id)!['审批编号'])
check('E 与 D 重叠，排队中且阻塞单为 D', String(after5.get(e.id!)?.row.status) === '排队中' && after5.get(e.id!)?.blockedBy === dPermitNo)

console.log('6) 两个审批端并发提交：先到留结论，后到版本不匹配被拒')
const cRowBefore = listRows(BURN_KEY).find((row) => Number(row.id) === c.id)!
const version = Number(cRowBefore['数据版本'])
const firstApprove = concludeBurnPermit(c.id!, '批准申请', { expectedVersion: version, approver: '审批员甲' })
check('审批端甲批准成功', firstApprove.ok, firstApprove.message)
const secondApprove = concludeBurnPermit(c.id!, '批准申请', { expectedVersion: version, approver: '审批员乙' })
check('审批端乙用旧版本批准被拒', !secondApprove.ok && /另一个审批端/.test(secondApprove.message), secondApprove.message)
const rejectAfter = concludeBurnPermit(c.id!, '驳回答复', { expectedVersion: version + 1 })
check('已出结论的单不能再改结论', !rejectAfter.ok, rejectAfter.message)

console.log('7) 批准后另一个入口（用火台账）多一条；驳回不多；队首出结论后下一张递补')
let ledgerAfterApprove = listRows(LEDGER_KEY)
check('台账新增 1 条且幂等于审批编号', ledgerAfterApprove.length === 1 && String(ledgerAfterApprove[0]['审批编号']) === String(cRowBefore['审批编号']))
// 再次走批准路径（模拟重试）不产生第二条 —— 已出结论的单直接被拦。
const retry = concludeBurnPermit(c.id!, '批准申请', { expectedVersion: version + 1 })
check('重复批准被拦', !retry.ok)
check('台账仍是 1 条（幂等）', listRows(LEDGER_KEY).length === 1)
// day10 队首 D 驳回（驳回不进台账）后，排队的 E 自动递补为待审批。
const dRowBefore = listRows(BURN_KEY).find((row) => Number(row.id) === d.id)!
const rejectD = concludeBurnPermit(d.id!, '驳回答复', { expectedVersion: Number(dRowBefore['数据版本']) })
check('队首 D 可驳回', rejectD.ok, rejectD.message)
const eRowAfter = listRows(BURN_KEY).find((row) => Number(row.id) === e.id)!
check('E 自动递补为待审批', String(eRowAfter.status) === '待审批', `实际 ${eRowAfter.status}`)
const rejectE = concludeBurnPermit(e.id!, '驳回答复', { expectedVersion: Number(eRowAfter['数据版本']) })
check('递补后可驳回 E', rejectE.ok, rejectE.message)
check('两次驳回均不产生台账', listRows(LEDGER_KEY).length === 1)
// 与同单位已批准窗口重叠的新申请必须让位；相邻不重叠窗口可以入队。
const j = registerBurnPermit({
  申请单位: '乙林场',
  用火类型: '烧荒烧杂',
  用火地点: '九号沟',
  计划时段: `${dayText(12)} 06:00~08:00`,
})
const subJ = submitBurnPermit(j.id!)
check('与已批准窗口重叠的新申请被拒', !subJ.ok && /生效用火单/.test(subJ.message), subJ.message)
const k = registerBurnPermit({
  申请单位: '乙林场',
  用火类型: '烧荒烧杂',
  用火地点: '十号沟',
  计划时段: dayText(13),
})
const subK = submitBurnPermit(k.id!)
check('与已批准窗口相邻不重叠的新申请可入队', subK.ok, subK.message)

console.log('8) 待审筛选台：按申请单位 / 用火类型 / 计划时段筛选')
const h = registerBurnPermit({
  申请单位: '丁林场',
  用火类型: '计划烧除',
  用火地点: '七号沟',
  计划时段: dayText(30),
})
submitBurnPermit(h.id!)
await new Promise((resolve) => setTimeout(resolve, 5))
const i = registerBurnPermit({
  申请单位: '戊林场',
  用火类型: '焚烧疫木',
  用火地点: '八号沟',
  计划时段: dayText(30),
})
submitBurnPermit(i.id!)
check('按申请单位过滤', queryPending({ unit: '丁林场' }).every((view) => String(view.row['申请单位']).includes('丁林场')) && queryPending({ unit: '丁林场' }).length === 1)
check('按用火类型过滤', queryPending({ fireType: '计划烧除' }).some((view) => Number(view.row.id) === h.id))
check('按无关日期过滤为空', queryPending({ rangeText: dayText(40) }).length === 0)
check('按重叠日期过滤命中重叠链两张', queryPending({ rangeText: dayText(30) }).length === 2)
check('非法筛选时段返回空', queryPending({ rangeText: '瞎写' }).length === 0)

console.log('9) 定位')
const permitNo = String(cRowBefore['审批编号'])
const located = locatePermit(permitNo)
check('按审批编号定位成功', located.ok && Number(located.row?.id) === c.id, located.message)
check('不存在编号定位失败', !locatePermit('BURN-9999').ok)

console.log('10) 历史单据（无 __flow 标记）保持原结论、不参与排队')
// 手工塞一张「历史」已批准单。
const histRows = [...listRows(BURN_KEY), {
  id: 999,
  status: '已批准',
  pending: false,
  abnormal: false,
  审批编号: 'BURN-9999',
  申请单位: '老林场',
  用火类型: '烧荒',
  用火地点: '老地方',
  计划时段: '2020-01-01',
}]
saveRows(BURN_KEY, histRows)
const hist = listRows(BURN_KEY).find((row) => Number(row.id) === 999)!
check('历史单无 __flow 标记', hist.__flow !== 'v2')
const histConclude = concludeBurnPermit(999, '驳回答复')
check('历史单不能再审', !histConclude.ok && /历史/.test(histConclude.message), histConclude.message)
check('历史单不出现在待审队列', queryPending({}).every((view) => Number(view.row.id) !== 999))
// 历史单不阻塞同单位新申请（窗口也早已过期之外，这里验证不参与重叠占位：用未来且不同单位不直观，
// 直接验证同单位未来窗口不受历史单影响——历史单位是老林场）。
const f = registerBurnPermit({
  申请单位: '老林场',
  用火类型: '计划烧除',
  用火地点: '新地块',
  计划时段: dayText(20),
})
const subF = submitBurnPermit(f.id!)
check('同单位历史单不参与去重占位', subF.ok, subF.message)

console.log('11) 过期时段不能进入队列')
const g = registerBurnPermit({
  申请单位: '己林场',
  用火类型: '计划烧除',
  用火地点: '旧地块',
  计划时段: dayText(-2),
})
const subG = submitBurnPermit(g.id!)
check('过去时段提交被拒', !subG.ok && /过期|非法/.test(subG.message), subG.message)

if (failures > 0) {
  console.error(`\n${failures} 项检查失败`)
  process.exit(1)
} else {
  console.log('\n全部检查通过')
}
