<template>
  <section class="page" data-module="burnpermit">
    <header class="page-head">
      <div>
        <h2>焚烧审批管理</h2>
        <p class="page-desc">
          用火审批单待审筛选台：按申请单位、用火类型、计划时段筛选待审批单并支持定位；
          计划时段重叠按「申请时间早者优先、同时刻高风险优先」排队，两个审批端并发提交仅一个结论生效。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记用火审批单</button>
        <button class="btn" type="button" @click="exportRows">导出焚烧审批清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="terminal-bar">
      <span class="terminal-label">当前审批端（模拟两个审批端并发提交）：</span>
      <label v-for="terminal in terminals" :key="terminal" class="terminal-option">
        <input v-model="activeTerminal" type="radio" name="terminal" :value="terminal" />
        {{ terminal }}
      </label>
      <button class="btn ghost" type="button" @click="syncAll">同步本端最新版本</button>
      <span class="terminal-hint">乐观锁：本端持旧版本提交时会被判冲突，只有先提交的结论落库。</span>
    </div>

    <form class="filter-bar permit-filter" @submit.prevent="reload">
      <label class="filter-item">
        <span>单据范围</span>
        <select v-model="filters.status">
          <option value="待审">仅待审批</option>
          <option value="全部">全部状态</option>
        </select>
      </label>
      <label class="filter-item">
        <span>申请单位</span>
        <input v-model="filters.申请单位" list="permit-units" placeholder="按申请单位检索" />
        <datalist id="permit-units">
          <option v-for="unit in unitOptions" :key="unit" :value="unit" />
        </datalist>
      </label>
      <label class="filter-item">
        <span>用火类型</span>
        <select v-model="filters.用火类型">
          <option value="">全部类型</option>
          <option v-for="type in fireTypes" :key="type" :value="type">{{ type }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>计划时段起（重叠命中）</span>
        <input v-model="filters.计划时段起" type="datetime-local" />
      </label>
      <label class="filter-item">
        <span>计划时段止（重叠命中）</span>
        <input v-model="filters.计划时段止" type="datetime-local" />
      </label>
      <button class="btn primary" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      <label class="filter-item locate-box">
        <span>按审批编号定位</span>
        <span class="locate-input">
          <input v-model="locateCode" placeholder="如 BURN-0006" @keyup.enter.prevent="locateRow" />
          <button class="btn" type="button" @click="locateRow">定位</button>
        </span>
      </label>
    </form>

    <table class="data-table permit-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>审批状态</th>
          <th>排队情况</th>
          <th>版本/审批端</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          :ref="(el) => bindRowEl(row.id, el as HTMLElement | null)"
          :class="{ 'locate-flash': flashId === row.id, 'row-blocked': !row.canApprove && row.status === '待审批' }"
        >
          <td>{{ row.审批编号 }}</td>
          <td>{{ row.申请单位 }}</td>
          <td>
            {{ row.用火类型 }}
            <span :class="['risk-tag', `risk-${row.风险等级}`]">{{ row.风险等级 }}风险</span>
          </td>
          <td>{{ row.用火地点 }}</td>
          <td>{{ row.计划时段 }}</td>
          <td class="cell-muted">{{ row.安全措施 }}</td>
          <td>{{ row.appliedAtText }}</td>
          <td>
            <span :class="{ 'status-done': row.status !== '待审批' && row.status !== '待申请' }">{{ row.status }}</span>
          </td>
          <td>
            <template v-if="row.status === '待审批'">
              <div>
                队列第 <strong>{{ row.queueRank }}</strong> / {{ row.queueTotal }} 位
              </div>
              <div v-if="row.blockers.length" class="block-hint">
                前方 {{ row.blockers.length }} 单窗口重叠未决
                <div v-for="item in row.blockers.slice(0, 2)" :key="item.id" class="block-item">
                  · {{ item.code }}（{{ item.unit }}·{{ item.status }}）
                </div>
              </div>
              <div v-else class="ok-hint">队首窗口无冲突，可批准</div>
            </template>
            <span v-else class="cell-muted">—</span>
          </td>
          <td>
            <div>版本 v{{ row.version }}</div>
            <div class="cell-muted">{{ row.审批端 || '未审批' }}{{ row.审批人 ? `·${row.审批人}` : '' }}</div>
            <button class="link" type="button" @click="syncRow(row)">同步</button>
          </td>
          <td class="row-actions">
            <template v-if="row.status === '待申请'">
              <button class="link" type="button" @click="runPermit('提交申请', row)">提交申请</button>
            </template>
            <template v-else-if="row.status === '待审批'">
              <button
                class="link"
                :class="{ 'link-disabled': !row.canApprove }"
                type="button"
                :title="row.canApprove ? '' : '窗口重叠，需排队到队首才能批准'"
                @click="runPermit('批准申请', row)"
              >
                批准申请
              </button>
              <button class="link link-reject" type="button" @click="runPermit('驳回答复', row)">驳回答复</button>
            </template>
            <span v-else class="cell-muted">历史单据按原结论保留</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">没有符合筛选条件的用火审批单</td>
        </tr>
      </tbody>
    </table>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <footer class="page-foot">
      <span>共 {{ total }} 条用火审批记录（排队规则：申请时间早者优先，申请时间相同高风险优先）</span>
      <span v-if="errorMessage" :class="['error-text', { 'conflict-text': hasConflict }]">{{ errorMessage }}</span>
    </footer>

    <div v-if="showCreate" class="modal-mask" @click.self="closeCreate">
      <form class="modal-card" @submit.prevent="submitCreate">
        <h3>登记用火审批单</h3>
        <label class="modal-field">
          <span>申请单位 *</span>
          <input v-model="draft.申请单位" required placeholder="如：青山林场" />
        </label>
        <label class="modal-field">
          <span>用火类型 *</span>
          <select v-model="draft.用火类型" required>
            <option value="" disabled>请选用火类型</option>
            <option v-for="type in fireTypes" :key="type" :value="type">{{ type }}</option>
          </select>
        </label>
        <label class="modal-field">
          <span>用火地点 *</span>
          <input v-model="draft.用火地点" required placeholder="如：青山工区三号坡" />
        </label>
        <label class="modal-field">
          <span>计划开始 *</span>
          <input v-model="draft.计划时段起" type="datetime-local" required />
        </label>
        <label class="modal-field">
          <span>计划结束 *</span>
          <input v-model="draft.计划时段止" type="datetime-local" required />
        </label>
        <label class="modal-field">
          <span>安全措施</span>
          <textarea v-model="draft.安全措施" rows="3" placeholder="隔离带、扑火器具、监烧人员等"></textarea>
        </label>
        <p class="risk-preview">风险等级将按用火类型自动判定：{{ draft.用火类型 ? riskPreview : '—' }}</p>
        <p v-if="createError" class="error-text">{{ createError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="submit">保存草稿</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  APPROVAL_TERMINALS,
  burnPermitStats,
  downloadEntries,
  FIRE_TYPES,
  listBurnPermits,
  locateBurnPermit,
  moduleMeta,
  registerBurnPermit,
  runAction as applyAction,
} from '@/api/local-service'
import type { PermitFilters, PermitViewRow } from '@/data/types'

const meta = moduleMeta('burnpermit')
const columns = ['审批编号', '申请单位', '用火类型', '用火地点', '计划时段', '安全措施', '申请时间']
const terminals = APPROVAL_TERMINALS
const fireTypes = FIRE_TYPES

const rows = ref<PermitViewRow[]>([])
const total = ref(0)
const stats = ref<{ label: string; value: number }[]>([])
const errorMessage = ref('')
const hasConflict = ref(false)
const activeTerminal = ref<string>(terminals[0])
const locateCode = ref('')
const flashId = ref<number | null>(null)

const filters = reactive<PermitFilters>({
  status: '待审',
  申请单位: '',
  用火类型: '',
  计划时段起: '',
  计划时段止: '',
})

// 每个审批端各自缓存单据版本快照：并发演示时不自动覆盖，需手动「同步」。
const terminalSnapshots = reactive<Record<string, Record<number, number>>>(
  Object.fromEntries(terminals.map((terminal) => [terminal, {}])),
)

const statusSummary = computed(() => {
  const all = listBurnPermits({ status: '全部' }).items
  return ['待申请', '待审批', '已批准', '已驳回', '已执行'].map((status) => ({
    status,
    count: all.filter((row) => row.status === status).length,
  }))
})

const unitOptions = computed(() => {
  const units = new Set<string>()
  for (const row of listBurnPermits({ status: '全部' }).items) {
    if (row.申请单位) units.add(String(row.申请单位))
  }
  return [...units]
})

const rowEls = new Map<number, HTMLElement>()

function bindRowEl(id: number, el: HTMLElement | null) {
  if (el) {
    rowEls.set(id, el)
  } else {
    rowEls.delete(id)
  }
}

function expectedVersion(row: PermitViewRow): number | undefined {
  const snapshot = terminalSnapshots[activeTerminal.value]
  return snapshot[row.id] ?? row.version
}

function rememberVersion(row: PermitViewRow) {
  terminalSnapshots[activeTerminal.value][row.id] = row.version
}

function syncRow(row: PermitViewRow) {
  const fresh = locateBurnPermit(row.id)
  if (!fresh) {
    return
  }
  terminalSnapshots[activeTerminal.value][row.id] = fresh.version
  errorMessage.value = `已同步：${fresh.审批编号} 当前版本 v${fresh.version}${fresh.审批端 ? `，结论由${fresh.审批端}写入` : ''}`
  hasConflict.value = false
  reload()
}

function syncAll() {
  const snapshot = terminalSnapshots[activeTerminal.value]
  for (const row of listBurnPermits({ status: '全部' }).items) {
    snapshot[row.id] = row.version
  }
  errorMessage.value = `${activeTerminal.value}已同步全部单据最新版本`
  hasConflict.value = false
  reload()
}

function runPermit(action: string, row: PermitViewRow) {
  errorMessage.value = ''
  hasConflict.value = false
  const result = applyAction(meta.key, Number(row.id), action, {
    terminal: activeTerminal.value,
    expectedVersion: expectedVersion(row),
  })
  if (!result.ok) {
    errorMessage.value = result.message
    hasConflict.value = Boolean(result.conflict)
    return
  }
  if (result.version) {
    terminalSnapshots[activeTerminal.value][row.id] = result.version
  }
  errorMessage.value = result.message
  reload()
}

function resetFilters() {
  filters.status = '待审'
  filters.申请单位 = ''
  filters.用火类型 = ''
  filters.计划时段起 = ''
  filters.计划时段止 = ''
  reload()
}

function locateRow() {
  errorMessage.value = ''
  hasConflict.value = false
  const code = locateCode.value.trim().toUpperCase()
  if (!code) {
    return
  }
  let target = listBurnPermits({ status: '全部' }).items.find((row) => String(row.审批编号).toUpperCase() === code)
  if (!target) {
    errorMessage.value = `未找到审批编号 ${code} 的用火审批单`
    return
  }
  // 定位支持跨筛选：不在当前筛选台时清掉筛选条件、切到「全部状态」再聚焦。
  const present = listBurnPermits({ ...filters }).items.some((row) => row.id === target.id)
  if (!present) {
    filters.status = target.status === '待审批' ? '待审' : '全部'
    filters.申请单位 = ''
    filters.用火类型 = ''
    filters.计划时段起 = ''
    filters.计划时段止 = ''
  }
  reload()
  requestAnimationFrame(() => {
    const el = rowEls.get(target!.id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      flashId.value = target!.id
      window.setTimeout(() => {
        if (flashId.value === target!.id) flashId.value = null
      }, 2400)
    }
  })
}

function exportRows() {
  downloadEntries(meta.key)
}

const showCreate = ref(false)
const createError = ref('')
const emptyDraft = () => ({
  申请单位: '',
  用火类型: '',
  用火地点: '',
  计划时段起: '',
  计划时段止: '',
  安全措施: '',
})
const draft = ref(emptyDraft())

const riskPreview = computed(() => {
  const type = draft.value.用火类型
  if (!type) return '—'
  const map: Record<string, string> = {
    炼山造林: '高风险',
    烧荒整地: '高风险',
    计划烧除: '中风险',
    焚烧隔离带: '中风险',
    野外用火: '低风险',
  }
  return map[type] ?? '中风险'
})

function openCreate() {
  draft.value = emptyDraft()
  createError.value = ''
  showCreate.value = true
}

function closeCreate() {
  showCreate.value = false
}

function submitCreate() {
  createError.value = ''
  const result = registerBurnPermit({ ...draft.value })
  if (!result.ok) {
    createError.value = result.message
    return
  }
  showCreate.value = false
  filters.status = '全部'
  errorMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  const payload = listBurnPermits({ ...filters })
  rows.value = payload.items
  total.value = payload.total
  stats.value = burnPermitStats()
  // 首次加载时把当前真实版本灌进两个审批端的快照，便于随后模拟并发。
  for (const row of payload.items) {
    for (const terminal of terminals) {
      if (terminalSnapshots[terminal][row.id] === undefined) {
        terminalSnapshots[terminal][row.id] = row.version
      }
    }
  }
}

onMounted(reload)
</script>

<style scoped>
.permit-filter { align-items: flex-end; }
.terminal-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 13px;
}
.terminal-label { font-weight: 600; }
.terminal-option { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.terminal-hint { color: var(--muted); font-size: 12px; }
.locate-box { margin-left: auto; }
.locate-input { display: inline-flex; gap: 6px; }
.permit-table td { vertical-align: top; }
.cell-muted { color: var(--muted); font-size: 12px; }
.risk-tag {
  display: inline-block;
  margin-left: 6px;
  border-radius: 999px;
  padding: 0 8px;
  font-size: 11px;
  line-height: 18px;
}
.risk-高 { background: #fee4e2; color: #b42318; }
.risk-中 { background: #fef3c7; color: #92400e; }
.risk-低 { background: #dcfce7; color: #166534; }
.block-hint { color: #b45309; font-size: 12px; margin-top: 2px; }
.block-item { color: var(--muted); font-size: 11px; }
.ok-hint { color: #166534; font-size: 12px; margin-top: 2px; }
.status-done { font-weight: 600; }
.row-blocked { background: #fffbeb; }
.link-disabled { color: #b45309; }
.link-reject { color: #b42318; }
.conflict-text { font-weight: 600; }
.locate-flash { animation: flash-row 2.4s ease-out; }
@keyframes flash-row {
  0%, 30% { background: #dbeafe; outline: 2px solid var(--brand); }
  100% { background: transparent; }
}
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
  width: 460px;
  max-width: calc(100vw - 32px);
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.modal-card h3 { margin: 0 0 4px; }
.modal-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.modal-field span { color: var(--muted); font-size: 12px; }
.modal-field input, .modal-field select, .modal-field textarea {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
}
.risk-preview { font-size: 12px; color: var(--muted); margin: 0; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
</style>
