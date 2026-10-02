<template>
  <section class="page" data-module="burnpermit">
    <header class="page-head">
      <div>
        <h2>焚烧审批管理</h2>
        <p class="page-desc">
          用火审批单按申请单位、用火类型、计划时段做待审筛选与定位；计划时段重叠时按申请时间、风险等级排队，
          同一单位只保留最早窗口，批准后自动登记用火台账。
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

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div class="tab-bar">
      <button
        type="button"
        class="tab"
        :class="{ active: activeTab === 'pending' }"
        @click="activeTab = 'pending'"
      >
        待审筛选台
      </button>
      <button
        type="button"
        class="tab"
        :class="{ active: activeTab === 'all' }"
        @click="activeTab = 'all'"
      >
        全部审批单
      </button>
    </div>

    <div v-show="activeTab === 'pending'" class="pending-desk">
      <form class="filter-bar" @submit.prevent="searchPending">
        <label class="filter-item">
          <span>申请单位</span>
          <input v-model="pendingFilters.unit" placeholder="按申请单位检索" />
        </label>
        <label class="filter-item">
          <span>用火类型</span>
          <input v-model="pendingFilters.fireType" placeholder="按用火类型检索" />
        </label>
        <label class="filter-item">
          <span>计划时段</span>
          <input v-model="pendingFilters.rangeText" placeholder="2026-10-05 或 2026-10-05~2026-10-10" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetPendingFilters">重置条件</button>
        <label class="filter-item locate-item">
          <span>单据定位</span>
          <span class="locate-row">
            <input v-model="locateKeyword" placeholder="输入审批编号，如 BURN-0002" />
            <button class="btn" type="button" @click="locateRow">定位</button>
          </span>
        </label>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th>队列序</th>
            <th>审批编号</th>
            <th>申请单位</th>
            <th>用火类型</th>
            <th>风险等级</th>
            <th>计划时段</th>
            <th>申请时间</th>
            <th>待审状态</th>
            <th>前方阻塞单</th>
            <th>审批操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="view in pendingRows"
            :key="String(view.row.id)"
            :data-pending-id="view.row.id"
            :class="{ highlight: highlightId === Number(view.row.id) }"
          >
            <td>{{ view.queuePosition }}</td>
            <td>{{ view.row['审批编号'] }}</td>
            <td>{{ view.row['申请单位'] }}</td>
            <td>{{ view.row['用火类型'] }}</td>
            <td>{{ view.risk }}</td>
            <td>{{ view.row['计划时段'] }}</td>
            <td>{{ formatTime(view.row['申请时间']) }}</td>
            <td>{{ view.row.status }}</td>
            <td>{{ view.blockedBy || '—' }}</td>
            <td class="row-actions">
              <template v-if="view.row.status === '待审批'">
                <button class="link" type="button" @click="runAction('批准申请', view.row)">批准申请</button>
                <button class="link" type="button" @click="runAction('驳回答复', view.row)">驳回答复</button>
              </template>
              <span v-else class="muted-text">排队等待中</span>
            </td>
          </tr>
          <tr v-if="!pendingRows.length">
            <td colspan="10" class="empty-state">筛选条件下暂无待审批或排队中的用火审批单</td>
          </tr>
        </tbody>
      </table>
      <p class="queue-rule">
        排队规则：计划时段重叠的用火申请串行排队（不分单位，同一时段只放一个用火），先按申请时间先后、再按风险等级（高＞中＞低）排序，队首出结论后下一张自动递补；时段不重叠的申请互不阻塞。同一申请单位的重叠重复申请在提交时即只保留最早窗口，后单不予入队。
      </p>
    </div>

    <div v-show="activeTab === 'all'" class="all-permits">
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
          <tr
            v-for="row in rows"
            :key="String(row.id)"
            :data-row-id="row.id"
            :class="{ highlight: highlightId === Number(row.id), legacy: isLegacyRow(row) }"
          >
            <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
            <td>
              {{ row.status }}
              <span v-if="isLegacyRow(row)" class="legacy-tag" title="新排队流程上线前已提交，仍按原结论保留">历史</span>
            </td>
            <td class="row-actions">
              <template v-for="action in rowActions(row)" :key="action">
                <button class="link" type="button" @click="runAction(action, row)">{{ action }}</button>
              </template>
              <span v-if="!rowActions(row).length" class="muted-text">
                {{ isLegacyRow(row) ? '原结论保留' : '—' }}
              </span>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 2" class="empty-state">暂无焚烧审批数据，可先登记用火审批单</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="creating" class="modal-mask" @click.self="creating = false">
      <form class="modal-card" @submit.prevent="submitCreate">
        <h3>登记用火审批单</h3>
        <label class="form-item">
          <span>申请单位 *</span>
          <input v-model="draftForm['申请单位']" placeholder="如：青山林场" />
        </label>
        <label class="form-item">
          <span>用火类型 *</span>
          <select v-model="draftForm['用火类型']">
            <option v-for="type in fireTypes" :key="type" :value="type">{{ type }}</option>
          </select>
        </label>
        <label class="form-item">
          <span>用火地点 *</span>
          <input v-model="draftForm['用火地点']" placeholder="如：三道沟 3 号林班" />
        </label>
        <label class="form-item">
          <span>计划时段 *</span>
          <input v-model="draftForm['计划时段']" placeholder="2026-10-05 或 2026-10-05 08:00~11:00" />
        </label>
        <label class="form-item">
          <span>风险等级</span>
          <select v-model="draftForm['风险等级']">
            <option v-for="level in riskLevels" :key="level" :value="level">{{ level }}</option>
          </select>
        </label>
        <label class="form-item">
          <span>安全措施</span>
          <textarea v-model="draftForm['安全措施']" rows="2" placeholder="现场看护、灭火机具、隔离带等"></textarea>
        </label>
        <p v-if="createError" class="error-text">{{ createError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="creating = false">取消</button>
          <button class="btn primary" type="submit">登记并保存草稿</button>
        </div>
      </form>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条焚烧审批记录 · 用火台账 {{ ledgerTotal }} 条</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  locatePermit,
  parseWindow as parseWindowText,
  queryPending,
  registerBurnPermit,
  RISK_LEVELS,
  type PendingView,
} from '@/api/burn-permit'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('burnpermit')
const session = useSessionStore()

const columns = ['审批编号', '申请单位', '用火类型', '用火地点', '计划时段', '风险等级', '安全措施', '申请时间', '审批人']
const statuses = ['待申请', '待审批', '排队中', '已批准', '已驳回', '已作废']
const fireTypes = ['计划烧除', '烧荒烧杂', '焚烧疫木', '其他用火']
const riskLevels = [...RISK_LEVELS]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const ledgerTotal = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['申请单位', '用火类型', '计划时段']
const activeTab = ref<'pending' | 'all'>('pending')

const pendingRows = ref<PendingView[]>([])
const pendingFilters = ref({ unit: '', fireType: '', rangeText: '' })
const locateKeyword = ref('')
const highlightId = ref<number | null>(null)

const creating = ref(false)
const createError = ref('')
const emptyDraft = () => ({
  申请单位: '',
  用火类型: fireTypes[0],
  用火地点: '',
  计划时段: '',
  风险等级: '中',
  安全措施: '',
})
const draftForm = ref<Record<string, string>>(emptyDraft())

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待审批申请', value: rows.value.filter((row) => String(row.status) === '待审批').length },
  { label: '排队中申请', value: rows.value.filter((row) => String(row.status) === '排队中').length },
  { label: '已批准用火', value: rows.value.filter((row) => String(row.status) === '已批准').length },
  { label: '驳回/作废', value: rows.value.filter((row) => ['已驳回', '已作废'].includes(String(row.status))).length },
])

function isLegacyRow(row: EntryRow): boolean {
  return row.__flow !== 'v2'
}

function formatTime(value: string | number | boolean): string {
  const ts = Number(value)
  if (!Number.isFinite(ts) || !ts) {
    return '—'
  }
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function formatCell(row: EntryRow, column: string): string | number | boolean {
  if (column === '申请时间') {
    return isLegacyRow(row) ? '—（历史单据）' : formatTime(row[column] ?? '')
  }
  const value = row[column]
  return value === undefined || value === '' ? '—' : value
}

function rowActions(row: EntryRow): string[] {
  if (isLegacyRow(row)) {
    return []
  }
  switch (String(row.status)) {
    case '待申请':
      return ['提交申请']
    case '待审批':
      return ['批准申请', '驳回答复']
    default:
      return []
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function resetPendingFilters() {
  pendingFilters.value = { unit: '', fireType: '', rangeText: '' }
  searchPending()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  draftForm.value = emptyDraft()
  createError.value = ''
  creating.value = true
}

function submitCreate() {
  createError.value = ''
  const form = { ...draftForm.value }
  if (!form['用火地点'].trim()) {
    createError.value = '用火地点不能为空'
    return
  }
  const result = registerBurnPermit(form)
  if (!result.ok) {
    createError.value = result.message
    return
  }
  creating.value = false
  errorMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  // 带上读取时的数据版本：另一个审批端先给了结论，版本就对不上，本次提交被拒。
  const expectedVersion = Number(row['数据版本'])
  const result = applyAction(meta.key, Number(row.id), action, {
    expectedVersion: Number.isFinite(expectedVersion) ? expectedVersion : undefined,
    operator: session.operator,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    // 结论可能已被另一端刷新，强制重读后再展示。
    reloadPending()
    reload()
    return
  }
  errorMessage.value = result.message
  reloadPending()
  reload()
}

function searchPending() {
  errorMessage.value = ''
  if (pendingFilters.value.rangeText.trim()) {
    // 非法筛选时段直接提示，避免被误读成「没有待审单」。
    if (!parseWindowText(pendingFilters.value.rangeText)) {
      errorMessage.value = '计划时段筛选格式非法，示例：2026-10-05 或 2026-10-05~2026-10-10'
      pendingRows.value = []
      return
    }
  }
  pendingRows.value = queryPending({ ...pendingFilters.value })
}

function locateRow() {
  errorMessage.value = ''
  const result = locatePermit(locateKeyword.value)
  if (!result.ok || !result.row) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  highlightId.value = Number(result.row.id)
  reload()
  activeTab.value = 'all'
  if (result.queue) {
    pendingRows.value = result.queue
  }
  void nextTick(() => {
    const el = document.querySelector(`[data-row-id="${highlightId.value}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
  window.setTimeout(() => {
    if (highlightId.value === Number(result.row!.id)) {
      highlightId.value = null
    }
  }, 4000)
}

function reloadPending() {
  pendingRows.value = queryPending({ ...pendingFilters.value })
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    ledgerTotal.value = listEntries('fireledger').total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '焚烧审批列表读取失败'
  }
}

// 另一个标签页（另一个审批端）落结论后，本端自动刷新待审队列与版本。
function onStorage(event: StorageEvent) {
  if (event.key?.includes('forest-fire-patrol')) {
    reloadPending()
    reload()
  }
}

onMounted(() => {
  reloadPending()
  reload()
  window.addEventListener('storage', onStorage)
})
onUnmounted(() => {
  window.removeEventListener('storage', onStorage)
})
</script>

<style scoped>
.tab-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.tab {
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 6px 6px 0 0;
  padding: 6px 16px;
  cursor: pointer;
}
.tab.active {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
}
.locate-item {
  margin-left: auto;
}
.locate-row {
  display: flex;
  gap: 6px;
}
.queue-rule {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--muted);
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.legacy-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: #e2e8f0;
  color: #475569;
  font-size: 11px;
}
tr.highlight td {
  background: #fef3c7;
  transition: background 0.4s;
}
tr.legacy {
  color: var(--muted);
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
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.modal-card h3 {
  margin: 0;
}
.form-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.form-item input,
.form-item select,
.form-item textarea {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  color: #1f2937;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
