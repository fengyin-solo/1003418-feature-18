/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | null
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 乐观锁版本：动作处理完后的单据版本，供审批端校验是否仍为最新结论。 */
  version?: number
  /** 并发提交时结论已被另一审批端抢先写入，本端属于过期提交。 */
  conflict?: boolean
  /** 因排队约束（计划时段重叠）暂不能给出结论。 */
  blocked?: boolean
}

// 用火审批单的专用类型：沿既有 EntryRow 存储，业务字段见 modules.ts 的 fields。

export type PermitStatus = '待申请' | '待审批' | '已批准' | '已驳回' | '已执行'

export type PermitRisk = '高' | '中' | '低'

export type PermitFilters = {
  申请单位?: string
  用火类型?: string
  计划时段起?: string
  计划时段止?: string
  status?: string
}

export type PermitViewRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | null | unknown[] | Record<string, unknown>
  风险等级: PermitRisk
  appliedStamp: number
  appliedAtText: string
  windowStart: number | null
  windowEnd: number | null
  /** 待审批队列中的全局名次，从 1 开始；非待审批单据为 null。 */
  queueRank: number | null
  queueTotal: number
  /** 挡在本单之前的单据（时段重叠且排队更靠前，或已批准/已执行的占用窗口）。 */
  blockers: { id: number; code: string; unit: string; status: string }[]
  canApprove: boolean
  version: number
}

export type PermitPageResult = {
  items: PermitViewRow[]
  total: number
}

export type PermitDraft = {
  申请单位: string
  用火类型: string
  用火地点: string
  计划时段起: string
  计划时段止: string
  安全措施: string
}

export type PermitActionOptions = {
  terminal: string
  expectedVersion?: number
  安全措施?: string
}

export type BurnLedgerRow = EntryRow & {
  台账编号: string
  审批编号: string
  申请单位: string
  用火类型: string
  用火地点: string
  计划时段: string
  风险等级: PermitRisk
  审批结论: '已批准' | '已驳回'
  审批人: string
  审批端: string
  结论时间: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
