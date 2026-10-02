<template>
  <section class="page" data-module="fireledger">
    <header class="page-head">
      <div>
        <h2>用火台账</h2>
        <p class="page-desc">
          用火审批单在焚烧审批端形成批准或驳回结论后，台账自动追加一条；台账侧不做改写，
          保证两个入口数据一致、历史结论可追溯。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新台账</button>
        <button class="btn" type="button" @click="exportRows">导出台账清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>申请单位</span>
        <input v-model="unitFilter" placeholder="按申请单位检索" />
      </label>
      <label class="filter-item">
        <span>审批结论</span>
        <select v-model="conclusionFilter">
          <option value="">全部结论</option>
          <option value="已批准">已批准</option>
          <option value="已驳回">已驳回</option>
        </select>
      </label>
      <button class="btn primary" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)">
          <td>{{ row.台账编号 }}</td>
          <td>{{ row.审批编号 }}</td>
          <td>{{ row.申请单位 }}</td>
          <td>{{ row.用火类型 }}</td>
          <td>{{ row.用火地点 }}</td>
          <td>{{ row.计划时段 }}</td>
          <td>
            <span :class="['risk-tag', `risk-${row.风险等级}`]">{{ row.风险等级 }}风险</span>
          </td>
          <td :class="row.审批结论 === '已批准' ? 'conclusion-ok' : 'conclusion-no'">
            {{ row.审批结论 }}
          </td>
          <td>{{ row.审批人 }}</td>
          <td>{{ row.审批端 }}</td>
          <td>{{ row.结论时间 }}</td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length" class="empty-state">暂无用火台账记录，审批结论形成后会自动登记到这里</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 条台账记录（随焚烧审批结论自动追加，不可手工改写）</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listBurnLedger, moduleMeta } from '@/api/local-service'
import type { BurnLedgerRow } from '@/data/types'

const meta = moduleMeta('fireledger')
const columns = [
  '台账编号',
  '审批编号',
  '申请单位',
  '用火类型',
  '用火地点',
  '计划时段',
  '风险等级',
  '审批结论',
  '审批人',
  '审批端',
  '结论时间',
]

const rows = ref<BurnLedgerRow[]>([])
const unitFilter = ref('')
const conclusionFilter = ref('')

const filteredRows = computed(() =>
  rows.value.filter((row) => {
    const unit = unitFilter.value.trim()
    if (unit && !String(row.申请单位).includes(unit)) {
      return false
    }
    if (conclusionFilter.value && row.审批结论 !== conclusionFilter.value) {
      return false
    }
    return true
  }),
)

const stats = computed(() => [
  { label: '台账总量', value: rows.value.length },
  { label: '已批准用火', value: rows.value.filter((row) => row.审批结论 === '已批准').length },
  { label: '已驳回用火', value: rows.value.filter((row) => row.审批结论 === '已驳回').length },
])

function resetFilters() {
  unitFilter.value = ''
  conclusionFilter.value = ''
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  rows.value = listBurnLedger()
}

onMounted(reload)
</script>

<style scoped>
.risk-tag {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
}
.risk-高 { background: #fee4e2; color: #b42318; }
.risk-中 { background: #fef3c7; color: #92400e; }
.risk-低 { background: #dcfce7; color: #166534; }
.conclusion-ok { color: #166534; font-weight: 600; }
.conclusion-no { color: #b42318; font-weight: 600; }
</style>
