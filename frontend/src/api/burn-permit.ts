import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 用火审批领域服务：沿既有「页面 → local-service → local-store」调用链扩展，
// 页面只做渲染，排队、去重、并发结论、台账联动全部收敛在这里。

export const BURN_KEY = 'burnpermit'
export const LEDGER_KEY = 'fireledger'

export const STATUS_DRAFT = '待申请'
export const STATUS_PENDING = '待审批'
export const STATUS_QUEUED = '排队中'
export const STATUS_APPROVED = '已批准'
export const STATUS_REJECTED = '已驳回'
export const STATUS_VOID = '已作废'
export const STATUS_LEGACY = '历史单据'

// 参与排队的活跃状态；已出结论的窗口让位给后续单据。
const ACTIVE_STATUSES = [STATUS_PENDING, STATUS_QUEUED]
// 同一单位重复申请时，这些已占窗口的活跃状态算「窗口已被更早的单占用」。
const OCCUPYING_STATUSES = ACTIVE_STATUSES
// 已落定论、结论不可变的状态：同单位任何重叠新申请都必须让位。
const FINALIZED_STATUSES = [STATUS_APPROVED]

export const RISK_LEVELS = ['高', '中', '低'] as const
const RISK_RANK: Record<string, number> = { 高: 3, 中: 2, 低: 1 }

export type TimeWindow = { start: number; end: number }
export type PendingView = {
  row: EntryRow
  queuePosition: number
  blockedBy: string
  risk: string
  windowStart: number
  windowEnd: number
  appliedAt: number
}
export type LocateResult = {
  ok: boolean
  message: string
  row?: EntryRow
  queue?: PendingView[]
}

// 计划时段允许：单日（2026-10-05）或起止两段（2026-10-05 08:00~18:00、
// 2026-10-05 至 2026-10-07）。解析不了、起止倒置就是非法时段，不能进入队列。
const DATE_TOKEN =
  /\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}:\d{2}(?::\d{2})?/g

export function parseWindow(text: string): TimeWindow | null {
  const raw = String(text ?? '').trim()
  if (!raw) {
    return null
  }
  // 除了日期时间 token，只允许常见分隔符和空白；出现别的字（如「下礼拜」）即非法。
  const withoutTokens = raw.replace(DATE_TOKEN, '')
  if (withoutTokens.replace(/[~～,，;；:：\-—–\s至到]+/g, '') !== '') {
    return null
  }
  const tokens = raw.match(DATE_TOKEN) ?? []
  if (tokens.length === 0 || tokens.length > 2) {
    return null
  }

  const toTime = (value: string): number | null => {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (dateOnly) {
      return Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    }
    const withTime = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value)
    if (withTime) {
      return Date.UTC(
        Number(withTime[1]),
        Number(withTime[2]) - 1,
        Number(withTime[3]),
        Number(withTime[4]),
        Number(withTime[5]),
        Number(withTime[6] ?? 0),
      )
    }
    return null
  }
  const DAY = 24 * 3600 * 1000
  const isClock = (value: string) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(value)
  const clockOnDate = (dateToken: string, clock: string): number | null =>
    toTime(`${dateToken.slice(0, 10)} ${clock}`)

  if (tokens.length === 1) {
    // 单日整天；只给一个时刻没有结束，算非法时段。
    const start = toTime(tokens[0])
    if (start === null || tokens[0].includes(':')) {
      return null
    }
    return { start, end: start + DAY }
  }

  const [firstRaw, secondRaw] = tokens
  const first = String(firstRaw ?? '')
  const second = String(secondRaw ?? '')
  if (isClock(first)) {
    return null
  }
  // 结束端只给钟点（如 08:00~18:00）：与开始端同一天。
  if (isClock(second)) {
    if (!first.includes(':')) {
      return null
    }
    const start = toTime(first)
    const end = clockOnDate(first, second)
    if (start === null || end === null || end <= start) {
      return null
    }
    return { start, end }
  }
  const start = toTime(first)
  const end = toTime(second)
  if (start === null || end === null || end <= start) {
    return null
  }
  // 两端都只给到日期：结束日期按整天计入（5 日至 7 日 → 5 日 00:00 ~ 8 日 00:00）。
  if (!first.includes(':') && !second.includes(':')) {
    return { start, end: end + DAY }
  }
  return { start, end }
}

export function overlaps(a: TimeWindow, b: TimeWindow): boolean {
  return a.start < b.end && b.start < a.end
}

export function isLegacy(row: EntryRow): boolean {
  return row.__flow !== 'v2'
}

function riskOf(row: EntryRow): number {
  return RISK_RANK[String(row['风险等级'] ?? '')] ?? 0
}

function bump(row: EntryRow): EntryRow {
  const version = Number(row['数据版本'] ?? 0)
  return { ...row, 数据版本: Number.isFinite(version) ? version + 1 : 1 }
}

// 排队规则（自选设计）：全局只有一条用火时间线——计划时段重叠的申请（不分单位）串行排队，
// 先按申请时间先后、再按风险等级高者优先，最后按单据 id 兜底；各重叠链队首为「待审批」，
// 其余为「排队中」，队首出结论后下一张自动递补。同一单位重叠的重复申请约束更强，
// 在提交环节就只保留最早窗口，后单连排队资格都没有（见 submitBurnPermit）。
function recomputeQueue(rows: EntryRow[]): EntryRow[] {
  const actives = rows
    .filter((row) => !isLegacy(row) && ACTIVE_STATUSES.includes(String(row.status)))
    .map((row) => ({
      row,
      window: parseWindow(String(row['计划时段'] ?? '')) as TimeWindow | null,
    }))

  const sorted = [...actives].sort((a, b) => {
    const at = Number(a.row['申请时间'] ?? 0)
    const bt = Number(b.row['申请时间'] ?? 0)
    if (at !== bt) {
      return at - bt
    }
    const riskDiff = riskOf(b.row) - riskOf(a.row)
    if (riskDiff !== 0) {
      return riskDiff
    }
    return Number(a.row.id) - Number(b.row.id)
  })

  // 贪心：按顺序落位，与任何已在队首（待审批）且窗口重叠的单冲突，则继续排队。
  const heads: { row: EntryRow; window: TimeWindow | null }[] = []
  const nextStatus = new Map<number, string>()
  for (const item of sorted) {
    const blocked =
      item.window !== null &&
      heads.some((head) => head.window !== null && overlaps(head.window!, item.window!))
    if (blocked) {
      nextStatus.set(Number(item.row.id), STATUS_QUEUED)
    } else {
      nextStatus.set(Number(item.row.id), STATUS_PENDING)
      heads.push(item)
    }
  }

  return rows.map((row) => {
    const target = nextStatus.get(Number(row.id))
    if (!target || String(row.status) === target) {
      return row
    }
    return bump({ ...row, status: target, pending: target === STATUS_PENDING })
  })
}

function loadBurn(): EntryRow[] {
  return listRows(BURN_KEY)
}

function nextSerial(rows: EntryRow[], field: string, prefix: string): string {
  let max = 0
  for (const row of rows) {
    const match = /(\d+)$/.exec(String(row[field] ?? ''))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

function sameUnitOverlap(
  rows: EntryRow[],
  unit: string,
  window: TimeWindow,
  selfId: number | undefined,
  statuses: string[],
): EntryRow | null {
  for (const row of rows) {
    if (Number(row.id) === selfId || isLegacy(row)) {
      continue
    }
    if (String(row['申请单位'] ?? '') !== unit) {
      continue
    }
    if (!statuses.includes(String(row.status))) {
      continue
    }
    const other = parseWindow(String(row['计划时段'] ?? ''))
    if (other && overlaps(other, window)) {
      return row
    }
  }
  return null
}

// 登记用火审批单：只落草稿；非法时段在这里就拦下，避免脏数据进入后续队列。
export function registerBurnPermit(input: Record<string, string>): ActionResult & { id?: number } {
  const unit = String(input['申请单位'] ?? '').trim()
  const windowText = String(input['计划时段'] ?? '').trim()
  if (!unit) {
    return { ok: false, message: '申请单位不能为空' }
  }
  if (!parseWindow(windowText)) {
    return { ok: false, message: '计划时段非法：请填写日期（2026-10-05）或起止时段（2026-10-05 08:00~18:00）' }
  }
  const rows = loadBurn()
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const now = Date.now()
  const draft: EntryRow = {
    id,
    status: STATUS_DRAFT,
    pending: false,
    abnormal: false,
    __flow: 'v2',
    审批编号: nextSerial(rows, '审批编号', 'BURN-'),
    申请单位: unit,
    用火类型: String(input['用火类型'] ?? '').trim(),
    用火地点: String(input['用火地点'] ?? '').trim(),
    计划时段: windowText,
    风险等级: RISK_LEVELS.includes(String(input['风险等级']) as (typeof RISK_LEVELS)[number])
      ? String(input['风险等级'])
      : '中',
    安全措施: String(input['安全措施'] ?? '').trim(),
    申请时间: now,
    数据版本: 1,
  }
  saveRows(BURN_KEY, [...rows, draft])
  return { ok: true, message: `用火审批单 ${draft['审批编号']} 已登记，提交后进入待审批队列`, id }
}

// 提交申请：非法时段 / 过期时段拒绝入队；同一单位重复申请只保留最早窗口，
// 后到的单不抢占，更早的新单则把既有重叠单挤掉（已作废）。
export function submitBurnPermit(id: number): ActionResult {
  const rows = loadBurn()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的用火审批单` }
  }
  const target = rows[index]
  if (isLegacy(target)) {
    return { ok: false, message: '该单为新流程上线前提交的历史单据，仍按原结论保留，不再进入排队' }
  }
  if (String(target.status) !== STATUS_DRAFT) {
    return { ok: false, message: `单据当前为「${target.status}」，只有草稿可以提交申请` }
  }
  const window = parseWindow(String(target['计划时段'] ?? ''))
  if (!window) {
    return { ok: false, message: '计划时段非法，不能进入队列，请先修改计划时段' }
  }
  if (window.start <= Date.now()) {
    return { ok: false, message: '计划时段已过期，不能进入队列' }
  }

  const unit = String(target['申请单位'] ?? '')
  // 已有定论（如已批准）的同单位重叠窗口不可变，任何新申请都让位。
  const finalized = sameUnitOverlap(rows, unit, window, id, FINALIZED_STATUSES)
  if (finalized) {
    return {
      ok: false,
      message: `同一单位在重叠计划时段已有生效用火单 ${finalized['审批编号']}（已批准），本单不能再申请`,
    }
  }
  const occupied = sameUnitOverlap(rows, unit, window, id, OCCUPYING_STATUSES)
  if (occupied) {
    // 只保留最早窗口：新单窗口不早于已占窗口 → 新单拒绝。
    if (window.start >= parseWindow(String(occupied['计划时段'] ?? ''))!.start) {
      return {
        ok: false,
        message: `同一单位在重叠计划时段已保留更早窗口 ${occupied['审批编号']}，本单不予入队`,
      }
    }
  }

  let next = rows.map((row) => {
    if (Number(row.id) === id) {
      const submitted = bump({
        ...target,
        status: STATUS_PENDING,
        pending: true,
        申请时间: Number(target['申请时间'] ?? Date.now()) || Date.now(),
      })
      return submitted
    }
    // 新单窗口更早：同单位重叠的既有活跃单让位作废，仍保留记录可追溯。
    if (
      !isLegacy(row) &&
      ACTIVE_STATUSES.includes(String(row.status)) &&
      String(row['申请单位'] ?? '') === unit
    ) {
      const other = parseWindow(String(row['计划时段'] ?? ''))
      if (other && overlaps(other, window)) {
        return bump({
          ...row,
          status: STATUS_VOID,
          pending: false,
          abnormal: true,
          作废原因: `同一单位更早窗口 ${target['审批编号']} 已提交，重叠窗口只保留最早一单`,
        })
      }
    }
    return row
  })
  next = recomputeQueue(next)
  saveRows(BURN_KEY, next)
  const saved = next.find((row) => Number(row.id) === id)
  const queued = String(saved?.status) === STATUS_QUEUED
  return {
    ok: true,
    message: queued
      ? `申请已提交，计划时段与队首单据重叠，按申请时间/风险等级排队中`
      : '申请已提交，进入待审批',
  }
}

// 两个审批端并发提交：靠数据版本做乐观并发控制，先到的写结论，后到的版本不匹配被拒，
// 保证一张单只留下一个结论；台账写入按审批编号幂等，结论只可能落一条。
export function concludeBurnPermit(
  id: number,
  action: '批准申请' | '驳回答复',
  options: { expectedVersion?: number; approver?: string } = {},
): ActionResult {
  const rows = loadBurn()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的用火审批单` }
  }
  const target = rows[index]
  if (isLegacy(target)) {
    return { ok: false, message: '历史单据已按原结论归档保留，不能再次审批' }
  }
  // 版本检查先于结论检查：另一端先落了结论并 bump 版本时，这里直接判定为并发冲突，
  // 而不是让后到的一端误以为自己只是「重复操作」。
  const version = Number(target['数据版本'] ?? NaN)
  if (options.expectedVersion !== undefined && Number.isFinite(version)) {
    if (Number(options.expectedVersion) !== version) {
      return {
        ok: false,
        message: `单据已被另一个审批端处理（版本 ${version}），请刷新后以最新结论为准`,
      }
    }
  }
  const concluded = [STATUS_APPROVED, STATUS_REJECTED].includes(String(target.status))
  if (concluded) {
    return { ok: false, message: `该单据已留下「${target.status}」结论，不能重复审批` }
  }
  if (String(target.status) === STATUS_QUEUED) {
    const ahead = blockingAhead(rows, target)
    const label = ahead ? `，前方有 ${ahead} 张重叠单据待结论` : ''
    return { ok: false, message: `该单据正在排队${label}，轮到它之前不能给出结论` }
  }
  if (String(target.status) !== STATUS_PENDING) {
    return { ok: false, message: `单据当前为「${target.status}」，暂不能${action}` }
  }

  const now = Date.now()
  const approved = action === '批准申请'
  const concludedRow = bump({
    ...target,
    status: approved ? STATUS_APPROVED : STATUS_REJECTED,
    pending: false,
    abnormal: !approved,
    审批人: options.approver ? String(options.approver) : String(target['审批人'] ?? '值班管理员'),
    结论时间: now,
  })

  let next = rows.map((row) => (Number(row.id) === id ? concludedRow : row))
  if (approved) {
    appendLedger(concludedRow, now)
  }
  next = recomputeQueue(next)
  saveRows(BURN_KEY, next)
  return {
    ok: true,
    message: approved
      ? `已批准，用火台账已同步新增 ${concludedRow['审批编号']}`
      : '已驳回，排队窗口已释放',
  }
}

function blockingAhead(rows: EntryRow[], target: EntryRow): number {
  const window = parseWindow(String(target['计划时段'] ?? ''))
  if (!window) {
    return 0
  }
  return rows.filter((row) => {
    if (Number(row.id) === Number(target.id) || isLegacy(row)) {
      return false
    }
    if (String(row.status) !== STATUS_PENDING) {
      return false
    }
    const other = parseWindow(String(row['计划时段'] ?? ''))
    return other !== null && overlaps(other, window)
  }).length
}

// 台账联动：批准即向「用火台账」入口落一条；按审批编号幂等，重复触发不会多出记录。
function appendLedger(permit: EntryRow, approvedAt: number): void {
  const ledger = listRows(LEDGER_KEY)
  const permitNo = String(permit['审批编号'] ?? '')
  if (ledger.some((row) => String(row['审批编号'] ?? '') === permitNo)) {
    return
  }
  const id = ledger.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const entry: EntryRow = {
    id,
    status: '已登记',
    pending: false,
    abnormal: false,
    台账编号: nextSerial(ledger, '台账编号', 'LEDGER-'),
    审批编号: permitNo,
    申请单位: String(permit['申请单位'] ?? ''),
    用火类型: String(permit['用火类型'] ?? ''),
    用火地点: String(permit['用火地点'] ?? ''),
    计划时段: String(permit['计划时段'] ?? ''),
    风险等级: String(permit['风险等级'] ?? ''),
    安全措施: String(permit['安全措施'] ?? ''),
    审批人: String(permit['审批人'] ?? ''),
    批准时间: approvedAt,
    登记时间: Date.now(),
  }
  saveRows(LEDGER_KEY, [...ledger, entry])
}

// 待审筛选台：只看待审批/排队中的活跃单，按全局队顺序展示。
export function buildPendingQueue(): PendingView[] {
  const rows = loadBurn().filter(
    (row) => !isLegacy(row) && ACTIVE_STATUSES.includes(String(row.status)),
  )
  const sorted = [...rows].sort((a, b) => {
    const at = Number(a['申请时间'] ?? 0)
    const bt = Number(b['申请时间'] ?? 0)
    if (at !== bt) {
      return at - bt
    }
    const riskDiff = riskOf(b) - riskOf(a)
    if (riskDiff !== 0) {
      return riskDiff
    }
    return Number(a.id) - Number(b.id)
  })

  const placed: { row: EntryRow; window: TimeWindow | null }[] = []
  const views: PendingView[] = []
  for (const row of sorted) {
    const window = parseWindow(String(row['计划时段'] ?? ''))
    const blocker =
      window === null
        ? null
        : placed.find((item) => item.window !== null && overlaps(item.window!, window))
    views.push({
      row,
      queuePosition: views.length + 1,
      blockedBy: blocker ? String(blocker.row['审批编号'] ?? blocker.row.id) : '',
      risk: String(row['风险等级'] ?? '中'),
      windowStart: window?.start ?? 0,
      windowEnd: window?.end ?? 0,
      appliedAt: Number(row['申请时间'] ?? 0),
    })
    if (!blocker) {
      placed.push({ row, window })
    }
  }
  return views
}

export type PendingFilters = {
  unit?: string
  fireType?: string
  rangeText?: string
}

// 待审筛选台查询：申请单位/用火类型包含匹配；计划时段与筛选区间重叠即命中，
// 只给日期时按整天过滤。
export function queryPending(filters: PendingFilters): PendingView[] {
  const unit = filters.unit?.trim()
  const fireType = filters.fireType?.trim()
  const range = filters.rangeText ? parseWindow(filters.rangeText) : null
  if (filters.rangeText && !range) {
    return []
  }
  return buildPendingQueue().filter((view) => {
    if (unit && !String(view.row['申请单位'] ?? '').includes(unit)) {
      return false
    }
    if (fireType && !String(view.row['用火类型'] ?? '').includes(fireType)) {
      return false
    }
    if (range) {
      const window = { start: view.windowStart, end: view.windowEnd }
      if (!overlaps(window, range)) {
        return false
      }
    }
    return true
  })
}

// 定位：按审批编号（也兼容申请单位关键字）在当前数据里定位一张单，
// 返回其所在队列上下文，页面据此滚动并高亮。
export function locatePermit(keyword: string): LocateResult {
  const key = keyword.trim()
  if (!key) {
    return { ok: false, message: '请输入要定位的审批编号' }
  }
  const rows = loadBurn()
  const row = rows.find((item) => String(item['审批编号'] ?? '').includes(key))
  if (!row) {
    return { ok: false, message: `没有找到审批编号包含「${key}」的用火审批单` }
  }
  if (isLegacy(row)) {
    return { ok: true, message: `已定位到历史单据 ${row['审批编号']}（按原结论保留，不参与排队）`, row }
  }
  const queue = buildPendingQueue()
  const inQueue = queue.some((view) => Number(view.row.id) === Number(row.id))
  return {
    ok: true,
    message: inQueue
      ? `已定位到待审批队列中的 ${row['审批编号']}`
      : `已定位到 ${row['审批编号']}，当前状态「${row.status}」`,
    row,
    queue,
  }
}
