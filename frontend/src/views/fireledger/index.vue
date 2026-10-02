<template>
  <section class="page" data-module="fireledger">
    <header class="page-head">
      <div>
        <h2>用火台账</h2>
        <p class="page-desc">
          焚烧审批的另一个入口：用火审批单批准后自动落入台账，驳回不登记；按申请单位、用火类型、计划时段查询。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出台账清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">台账总条数</span>
        <strong class="stat-value">{{ total }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">本月新增</span>
        <strong class="stat-value">{{ monthCount }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>申请单位</span>
        <input v-model="filters['申请单位']" placeholder="按申请单位检索" />
      </label>
      <label class="filter-item">
        <span>用火类型</span>
        <input v-model="filters['用火类型']" placeholder="按用火类型检索" />
      </label>
      <label class="filter-item">
        <span>计划时段</span>
        <input v-model="filters['计划时段']" placeholder="按计划时段关键字检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 1" class="empty-state">
            台账暂无记录，待「焚烧审批」里的用火申请被批准后会自动登记到这里
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条用火台账记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('fireledger')
const columns = ['台账编号', '审批编号', '申请单位', '用火类型', '用火地点', '计划时段', '风险等级', '审批人', '批准时间', '登记时间']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const monthCount = computed(() => {
  const now = new Date()
  return rows.value.filter((row) => {
    const time = new Date(Number(row['登记时间'] ?? 0))
    return (
      Number.isFinite(time.getTime()) &&
      time.getFullYear() === now.getFullYear() &&
      time.getMonth() === now.getMonth()
    )
  }).length
})

function formatCell(row: EntryRow, column: string): string | number | boolean {
  if (column === '批准时间' || column === '登记时间') {
    const ts = Number(row[column])
    if (!Number.isFinite(ts) || !ts) {
      return '—'
    }
    return new Date(ts).toLocaleString('zh-CN', { hour12: false })
  }
  const value = row[column]
  return value === undefined || value === '' ? '—' : value
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  try {
    // 台账按登记时间倒序展示，最新批准的用火在最上面。
    const payload = listEntries(meta.key, filters.value)
    const sorted = [...payload.items].sort(
      (a, b) => Number(b['登记时间'] ?? 0) - Number(a['登记时间'] ?? 0),
    )
    rows.value = sorted
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '用火台账读取失败'
  }
}

onMounted(reload)
</script>
