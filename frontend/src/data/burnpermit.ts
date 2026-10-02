import { listRows, saveRows } from './local-store'
import type {
  ActionResult,
  BurnLedgerRow,
  EntryRow,
  PermitActionOptions,
  PermitDraft,
  PermitFilters,
  PermitPageResult,
  PermitRisk,
  PermitStatus,
  PermitViewRow,
} from './types'

// 用火审批单的领域规则：时段解析、风险分级、重叠排队、同单位去重、乐观锁结论、台账回写。
// 仍只经由 local-store 读写、由 local-service 统一调用，不另起调用链。

export const BURN_KEY = 'burnpermit'
export const LEDGER_KEY = 'fireledger'

// 两个审批端：并发提交时以乐观锁保证只有一个结论落库。
export const APPROVAL_TERMINALS = ['防火科审批端', '值班室审批端'] as const

export const FIRE_TYPES = ['计划烧除', '炼山造林', '烧荒整地', '焚烧隔离带', '野外用火'] as const

// 风险等级排队时高风险优先：高=3、中=2、低=1。
const RISK_BY_FIRE_TYPE: Record<string, PermitRisk> = {
  计划烧除: '中',
  炼山造林: '高',
  烧荒整地: '高',
  焚烧隔离带: '中',
  野外用火: '低',
}

export const DRAFT_STATUS: PermitStatus = '待申请'
export const PENDING_STATUS: PermitStatus = '待审批'
export const APPROVED_STATUS: PermitStatus = '已批准'
export const REJECTED_STATUS: PermitStatus = '已驳回'

type Window = { start: number; end: number }

const DAY_MS = 24 * 60 * 60 * 1000

/** 解析计划时段：支持「YYYY-MM-DD」整日与「起 至/~/至/- 止」区间两种写法，返回毫秒区间。 */
export function parseWindow(text: string): Window | null {
  const raw = text.trim()
  if (!raw) {
    return null
  }
  // 纯日期按当日 00:00~次日 00:00 处理，同日单据因此也算重叠。
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const start = Date.parse(`${raw}T00:00:00`)
    if (Number.isNaN(start)) {
      return null
    }
    return { start, end: start + DAY_MS }
  }
  const parts = raw.split(/\s*(?:~|～|至|—|--)\s*|\s+到\s+/).filter(Boolean)
  if (parts.length !== 2) {
    return null
  }
  const start = parseTimeEdge(parts[0])
  const end = parseTimeEdge(parts[1])
  if (start === null || end === null || !(start < end)) {
    return null
  }
  return { start, end }
}

function parseTimeEdge(edge: string): number | null {
  const value = edge.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day = Date.parse(`${value}T00:00:00`)
    return Number.isNaN(day) ? null : day
  }
  const stamp = Date.parse(value.replace(/\//g, '-'))
  return Number.isNaN(stamp) ? null : stamp
}

export function windowsOverlap(a: Window, b: Window): boolean {
  return a.start < b.end && b.start < a.end
}

export function riskOf(fireType: string): PermitRisk {
  return RISK_BY_FIRE_TYPE[fireType] ?? '中'
}

export function riskRank(risk: PermitRisk): number {
  return risk === '高' ? 3 : risk === '中' ? 2 : 1
}

function asText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** 已提交历史单据的申请时间可能没有单独登记，用计划开始前一天兜底，保证旧数据结论不被重排。 */
function appliedStampOf(row: EntryRow): number {
  const explicit = Number(row.申请时间)
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit
  }
  const window = parseWindow(asText(row.计划时段))
  if (window) {
    return window.start - row.id * 1000
  }
  return row.id
}

function formatStamp(stamp: number): string {
  const d = new Date(stamp)
  if (Number.isNaN(d.getTime())) {
    return ''
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function versionOf(row: EntryRow): number {
  const version = Number(row.version)
  return Number.isFinite(version) && version > 0 ? version : 1
}

type Enriched = {
  row: EntryRow
  window: Window | null
  stamp: number
  risk: PermitRisk
}

function enrich(rows: EntryRow[]): Enriched[] {
  return rows.map((row) => ({
    row,
    window: parseWindow(asText(row.计划时段)),
    stamp: appliedStampOf(row),
    risk: (asText(row.风险等级) as PermitRisk) || riskOf(asText(row.用火类型)),
  }))
}

/** 排队规则：时段重叠入队，队序先按申请时间早者优先，申请时间相同再按风险等级高者优先。 */
export function pendingQueue(rows: EntryRow[]): Enriched[] {
  return enrich(rows.filter((row) => asText(row.status) === PENDING_STATUS)).sort(
    (a, b) => a.stamp - b.stamp || riskRank(b.risk) - riskRank(a.risk) || a.row.id - b.row.id,
  )
}

function occupying(rows: EntryRow[]): Enriched[] {
  // 已批准/已执行的历史窗口持续占用；被驳回或未提交的不占队。
  return enrich(
    rows.filter((row) => {
      const status = asText(row.status)
      return status === APPROVED_STATUS || status === '已执行'
    }),
  )
}

function toView(item: Enriched, ctx: {
  queue: Enriched[]
  occupied: Enriched[]
  queueIndex: number | null
}): PermitViewRow {
  const { row, window, stamp, risk } = item
  const blockers: PermitViewRow['blockers'] = []
  if (asText(row.status) === PENDING_STATUS) {
    // 已占窗口：历史已批准窗口与新窗口重叠则不能再批。
    for (const other of ctx.occupied) {
      if (window && other.window && windowsOverlap(window, other.window)) {
        blockers.push({
          id: other.row.id,
          code: asText(other.row.审批编号),
          unit: asText(other.row.申请单位),
          status: asText(other.row.status),
        })
      }
    }
    // 队首约束：重叠窗口里排在更前面的待审批单未决之前，本单只能排队。
    if (ctx.queueIndex !== null) {
      for (let i = 0; i < ctx.queueIndex; i += 1) {
        const ahead = ctx.queue[i]
        if (window && ahead.window && windowsOverlap(window, ahead.window)) {
          blockers.push({
            id: ahead.row.id,
            code: asText(ahead.row.审批编号),
            unit: asText(ahead.row.申请单位),
            status: PENDING_STATUS,
          })
        }
      }
    }
  }
  return {
    ...row,
    风险等级: risk,
    appliedStamp: stamp,
    appliedAtText: asText(row.申请时间) ? formatStamp(stamp) : `历史单据·${asText(row.计划时段)}`,
    windowStart: window ? window.start : null,
    windowEnd: window ? window.end : null,
    queueRank: ctx.queueIndex === null ? null : ctx.queueIndex + 1,
    queueTotal: ctx.queue.length,
    blockers,
    canApprove: asText(row.status) === PENDING_STATUS && blockers.length === 0,
    version: versionOf(row),
  }
}

function matchFilter(row: PermitViewRow, window: Window | null, filters: PermitFilters): boolean {
  const unit = (filters.申请单位 ?? '').trim()
  if (unit && !asText(row.申请单位).includes(unit)) {
    return false
  }
  const fireType = (filters.用火类型 ?? '').trim()
  if (fireType && asText(row.用火类型) !== fireType) {
    return false
  }
  if ((filters.status ?? '待审') === '待审' && asText(row.status) !== PENDING_STATUS) {
    return false
  }
  const start = filters.计划时段起 ? parseTimeEdge(filters.计划时段起) : null
  const end = filters.计划时段止 ? parseTimeEdge(filters.计划时段止) : null
  if ((start !== null || end !== null) && !window) {
    return false
  }
  if (window && start !== null && window.end <= start) {
    return false
  }
  if (window && end !== null && window.start >= end) {
    return false
  }
  return true
}

/** 待审筛选台：按申请单位、用火类型、计划时段筛选待审批单；队列按排队顺序返回。 */
export function listPermits(filters: PermitFilters = {}): PermitPageResult {
  const rows = listRows(BURN_KEY)
  const queue = pendingQueue(rows)
  const occupied = occupying(rows)
  const enriched = enrich(rows)
  const queueIndexById = new Map(queue.map((item, index) => [item.row.id, index]))
  const onlyPending = (filters.status ?? '待审') === '待审'

  const views = enriched
    .map((item) => toView(item, { queue, occupied, queueIndex: queueIndexById.get(item.row.id) ?? null }))
    .filter((view) =>
      matchFilter(
        view,
        view.windowStart !== null && view.windowEnd !== null
          ? { start: view.windowStart, end: view.windowEnd }
          : null,
        filters,
      ),
    )

  if (onlyPending) {
    // 待审台严格按队序（申请时间 → 风险等级）。
    views.sort((a, b) => (a.queueRank ?? 0) - (b.queueRank ?? 0))
  } else {
    views.sort((a, b) => a.id - b.id)
  }
  return { items: views, total: views.length }
}

export function getPermit(id: number): PermitViewRow | null {
  const payload = listPermits({ status: '全部' })
  return payload.items.find((row) => row.id === id) ?? null
}

export function permitStats(): { label: string; value: number }[] {
  const rows = listRows(BURN_KEY)
  const count = (status: PermitStatus) =>
    rows.filter((row) => asText(row.status) === status).length
  const queue = pendingQueue(rows)
  const blocked = queue.filter((item) => {
    const view = toView(item, {
      queue,
      occupied: occupying(rows),
      queueIndex: queue.findIndex((candidate) => candidate.row.id === item.row.id),
    })
    return !view.canApprove
  }).length
  return [
    { label: '待审批申请', value: count(PENDING_STATUS) },
    { label: '排队中（窗口重叠）', value: blocked },
    { label: '已批准用火', value: count(APPROVED_STATUS) + count('已执行') },
    { label: '驳回申请', value: count(REJECTED_STATUS) },
  ]
}

function nextCode(rows: EntryRow[]): string {
  let max = 0
  for (const row of rows) {
    const match = /BURN-(\d+)/.exec(asText(row.审批编号))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `BURN-${String(max + 1).padStart(4, '0')}`
}

function validateWindowText(start: string, end: string): string | null {
  if (!start.trim() || !end.trim()) {
    return '计划时段必须填写开始与结束时间'
  }
  const startStamp = parseTimeEdge(start)
  const endStamp = parseTimeEdge(end)
  if (startStamp === null || endStamp === null) {
    return '计划时段格式非法，请使用合法日期时间'
  }
  if (!(startStamp < endStamp)) {
    return '非法时段：开始时间必须早于结束时间，不能进入队列'
  }
  return null
}

/** 登记用火审批单（待申请草稿）；非法时段直接拒绝，不落任何数据。 */
export function createPermit(draft: PermitDraft): ActionResult & { id?: number } {
  const unit = draft.申请单位.trim()
  const fireType = draft.用火类型.trim()
  if (!unit || !fireType || !draft.用火地点.trim()) {
    return { ok: false, message: '申请单位、用火类型、用火地点均为必填' }
  }
  const windowError = validateWindowText(draft.计划时段起, draft.计划时段止)
  if (windowError) {
    return { ok: false, message: windowError }
  }
  const rows = listRows(BURN_KEY)
  const id = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
  const period = `${draft.计划时段起.replace('T', ' ')} 至 ${draft.计划时段止.replace('T', ' ')}`
  const row: EntryRow = {
    id,
    status: DRAFT_STATUS,
    pending: true,
    abnormal: false,
    version: 1,
    审批编号: nextCode(rows),
    申请单位: unit,
    用火类型: fireType,
    用火地点: draft.用火地点.trim(),
    计划时段: period,
    安全措施: draft.安全措施.trim() || '按规范清理隔离带、配备扑火器具与监烧人员',
    风险等级: riskOf(fireType),
    申请时间: '',
    审批人: '',
    审批端: '',
    审批状态: DRAFT_STATUS,
  }
  saveRows(BURN_KEY, [...rows, row])
  return { ok: true, message: `用火审批单 ${asText(row.审批编号)} 已登记，可提交申请`, id }
}

/** 同单位重复申请只留最早窗口：存在更早申请且窗口重叠时，新单拒绝入队。 */
function findSameUnitDuplicate(rows: EntryRow[], self: EntryRow, window: Window): EntryRow | null {
  const unit = asText(self.申请单位)
  let winner: { row: EntryRow; stamp: number } | null = null
  for (const other of rows) {
    if (other.id === self.id || asText(other.申请单位) !== unit) {
      continue
    }
    const status = asText(other.status)
    if (status === REJECTED_STATUS || status === DRAFT_STATUS) {
      continue
    }
    const otherWindow = parseWindow(asText(other.计划时段))
    if (!otherWindow || !windowsOverlap(window, otherWindow)) {
      continue
    }
    const stamp = appliedStampOf(other)
    if (!winner || stamp < winner.stamp) {
      winner = { row: other, stamp }
    }
  }
  return winner?.row ?? null
}

function bumpVersion(row: EntryRow): number {
  return versionOf(row) + 1
}

function appendLedger(permit: EntryRow, status: PermitStatus, options: PermitActionOptions): void {
  const ledger = listRows(LEDGER_KEY)
  const ledgerId = ledger.reduce((max, row) => Math.max(max, row.id), 0) + 1
  let max = 0
  for (const row of ledger) {
    const match = /LEDG-(\d+)/.exec(asText(row.台账编号))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  const stamp = Date.now()
  const row: BurnLedgerRow = {
    id: ledgerId,
    status: '已登记',
    pending: false,
    abnormal: false,
    台账编号: `LEDG-${String(max + 1).padStart(4, '0')}`,
    审批编号: asText(permit.审批编号),
    申请单位: asText(permit.申请单位),
    用火类型: asText(permit.用火类型),
    用火地点: asText(permit.用火地点),
    计划时段: asText(permit.计划时段),
    风险等级: (asText(permit.风险等级) as PermitRisk) || riskOf(asText(permit.用火类型)),
    审批结论: status === APPROVED_STATUS ? '已批准' : '已驳回',
    审批人: options.terminal.includes('值班') ? '值班审批员' : '防火科审批员',
    审批端: options.terminal,
    结论时间: formatStamp(stamp),
  }
  saveRows(LEDGER_KEY, [...ledger, row])
}

/** 审批结论写库：乐观锁比对版本，两个审批端并发提交只有先到的一份结论生效。 */
export function runPermitAction(id: number, action: string, options: PermitActionOptions): ActionResult {
  if (!APPROVAL_TERMINALS.includes(options.terminal as (typeof APPROVAL_TERMINALS)[number])) {
    return { ok: false, message: '未知审批端，无法提交结论' }
  }
  const rows = listRows(BURN_KEY)
  const index = rows.findIndex((row) => row.id === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的用火审批单` }
  }
  const current = rows[index]
  const currentStatus = asText(current.status)

  if (action === '提交申请') {
    if (currentStatus !== DRAFT_STATUS) {
      return { ok: false, message: `单据当前为「${currentStatus}」，无需重复提交` }
    }
    const window = parseWindow(asText(current.计划时段))
    if (!window) {
      return { ok: false, message: '非法时段：计划时段无法解析，不能进入队列' }
    }
    const duplicate = findSameUnitDuplicate(rows, current, window)
    if (duplicate) {
      return {
        ok: false,
        blocked: true,
        message: `本单位窗口 ${asText(duplicate.计划时段)}（${asText(duplicate.审批编号)}）申请更早，重复申请只保留最早窗口，本单不予入队`,
      }
    }
    const updated: EntryRow = {
      ...current,
      status: PENDING_STATUS,
      pending: true,
      version: bumpVersion(current),
      申请时间: Date.now(),
      审批状态: PENDING_STATUS,
    }
    const next = [...rows]
    next[index] = updated
    saveRows(BURN_KEY, next)
    const view = getPermit(id)
    const queueHint = view && !view.canApprove
      ? `，窗口重叠已入队，当前队列第 ${view.queueRank} 位，前方 ${view.blockers.length} 单未决`
      : '，已进入待审批队列队首'
    return { ok: true, message: `申请已提交${queueHint}`, version: updated.version as number }
  }

  if (action !== '批准申请' && action !== '驳回答复') {
    return { ok: false, message: `用火审批单没有登记「${action}」这个动作` }
  }

  // 乐观锁优先：第二端持旧版本提交时直接判冲突（哪怕先到的一端已把单据写成终态），
  // 保证两个审批端并发提交时只落一个结论。
  if (options.expectedVersion !== undefined && options.expectedVersion !== versionOf(current)) {
    return {
      ok: false,
      conflict: true,
      version: versionOf(current),
      message: `并发冲突：${asText(current.审批端) || '另一审批端'}已基于更新版本提交，本端结论未写入，请同步后重试`,
    }
  }

  if (currentStatus !== PENDING_STATUS) {
    return {
      ok: false,
      message: `单据已形成结论「${currentStatus}」，历史单据按原结论保留，不能重复审批`,
    }
  }

  const target: PermitStatus = action === '批准申请' ? APPROVED_STATUS : REJECTED_STATUS
  if (target === APPROVED_STATUS) {
    const view = getPermit(id)
    if (view && !view.canApprove) {
      const names = view.blockers.map((item) => `${item.code}(${item.status})`).join('、')
      return {
        ok: false,
        blocked: true,
        message: `窗口重叠排队中，前方还有 ${view.blockers.length} 单未决：${names}；驳回可直接答复，批准需轮到队首`,
      }
    }
  }

  const stamp = Date.now()
  const approver = options.terminal.includes('值班') ? '值班审批员' : '防火科审批员'
  const updated: EntryRow = {
    ...current,
    status: target,
    pending: false,
    abnormal: target === REJECTED_STATUS,
    version: bumpVersion(current),
    审批人: approver,
    审批端: options.terminal,
    结论时间: stamp,
    审批状态: target,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(BURN_KEY, next)
  // 审批完成后另一个入口（用火台账）自动多一条。
  appendLedger(updated, target, options)
  return {
    ok: true,
    message: `用火审批单 ${asText(updated.审批编号)} 已由${options.terminal}${action === '批准申请' ? '批准' : '驳回'}，用火台账已同步登记`,
    version: updated.version as number,
  }
}

export function listLedger(): BurnLedgerRow[] {
  return listRows(LEDGER_KEY) as BurnLedgerRow[]
}
