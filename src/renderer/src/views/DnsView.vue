<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useDnsStore } from '../stores/dns'

const store = useDnsStore()
const { name, type, result, busy, message, error } = storeToRefs(store)
const types = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'HTTPS'] as const
</script>

<template>
  <div class="page-shell dns-view">
    <h1>DNS</h1>
    <section><h2>解析诊断</h2><div class="surface-card dns-query-card">
      <form @submit.prevent="store.query">
        <input v-model="name" required maxlength="253" spellcheck="false" aria-label="域名" placeholder="example.com" />
        <select v-model="type" aria-label="记录类型"><option v-for="item in types" :key="item" :value="item">{{ item }}</option></select>
        <button type="submit" :disabled="busy">查询</button>
      </form>
      <p v-if="error" class="inline-error">{{ error }}</p><p v-else-if="message" class="setting-help">{{ message }}</p>
      <div v-if="result" class="dns-result" aria-live="polite">
        <p>状态 {{ result.Status }} · {{ result.Answer?.length ?? 0 }} 条回答</p>
        <div v-for="record in result.Answer ?? []" :key="`${record.name}-${record.type}-${record.data}`" class="dns-record">
          <strong>{{ record.name }}</strong><code>{{ record.data }}</code><small>TTL {{ record.TTL }}s · TYPE {{ record.type }}</small>
        </div>
        <p v-if="!(result.Answer?.length)" class="settings-empty">查询成功，但没有回答记录。</p>
      </div>
    </div></section>
    <section><h2>缓存</h2><div class="surface-card preference-list">
      <button type="button" :disabled="busy" @click="store.flush('dns')"><span><strong>清除 DNS 缓存</strong><small>仅清除 mihomo 内核维护的 DNS 缓存。</small></span><b>清除</b></button>
      <button type="button" :disabled="busy" @click="store.flush('fakeip')"><span><strong>清除 Fake-IP 缓存</strong><small>现有映射会失效，后续连接将重新分配。</small></span><b>清除</b></button>
    </div></section>
  </div>
</template>
