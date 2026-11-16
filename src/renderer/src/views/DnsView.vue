<script setup lang="ts">
import { t } from '@shared/i18n'
import { storeToRefs } from 'pinia'
import { useDnsStore } from '../stores/dns'
import AppSelect from '../components/AppSelect.vue'

const store = useDnsStore()
const { name, type, result, busy, message, error } = storeToRefs(store)
const types = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'HTTPS'] as const
const TYPE_OPTIONS = types.map((value) => ({ value, label: value }))
</script>

<template>
  <div class="page-shell dns-view">
    <h1>DNS</h1>
    <section><h2>{{ t('dnsTools.title') }}</h2><div class="surface-card dns-query-card">
      <form @submit.prevent="store.query">
        <input v-model="name" required maxlength="253" spellcheck="false" :aria-label="t('dnsTools.domain')" placeholder="example.com" />
        <AppSelect v-model="type" :options="TYPE_OPTIONS" :label="t('dnsTools.recordType')" />
        <button type="submit" :disabled="busy">{{ t('dnsTools.query') }}</button>
      </form>
      <p v-if="error" class="inline-error">{{ error }}</p><p v-else-if="message" class="setting-help">{{ message }}</p>
      <div v-if="result" class="dns-result" aria-live="polite">
        <p>{{ t('dnsTools.result', [result.Status, result.Answer?.length ?? 0]) }}</p>
        <div v-for="record in result.Answer ?? []" :key="`${record.name}-${record.type}-${record.data}`" class="dns-record">
          <strong>{{ record.name }}</strong><code>{{ record.data }}</code><small>TTL {{ record.TTL }}s · TYPE {{ record.type }}</small>
        </div>
        <p v-if="!(result.Answer?.length)" class="settings-empty">{{ t('dnsTools.noAnswer') }}</p>
      </div>
    </div></section>
    <section><h2>{{ t('dnsTools.cache') }}</h2><div class="surface-card preference-list">
      <button type="button" :disabled="busy" @click="store.flush('dns')"><span><strong>{{ t('dnsTools.flushDns') }}</strong><small>{{ t('dnsTools.flushDnsHint') }}</small></span><b>{{ t('dnsTools.flush') }}</b></button>
      <button type="button" :disabled="busy" @click="store.flush('fakeip')"><span><strong>{{ t('dnsTools.flushFakeIp') }}</strong><small>{{ t('dnsTools.flushFakeIpHint') }}</small></span><b>{{ t('dnsTools.flush') }}</b></button>
    </div></section>
  </div>
</template>
