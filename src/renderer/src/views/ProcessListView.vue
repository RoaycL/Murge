<script setup lang="ts">
const items = [
  ['AI', 'Chat Client', '23 KB/s', '2.63 GB'], ['SYS', 'System Services', '0 B/s', '2.46 GB'],
  ['>_', 'curl', '0 B/s', '828.6 MB'], ['N', 'node', '0 B/s', '440.0 MB'],
  ['C', 'Code Editor', '0 B/s', '406.0 MB'], ['B', 'Browser', '778 B/s', '121.6 MB'],
  ['M', 'Mail', '0 B/s', '103.1 MB']
]
</script>
<template><div class="page-shell list-detail-page"><header class="page-toolbar"><h1>进程</h1><select><option>按流量排序</option><option>按名称排序</option></select></header><div class="list-detail-grid"><div class="entity-list"><button v-for="item in items" :key="item[1]" class="entity-row"><i>{{ item[0] }}</i><span>{{ item[1] }}</span><strong>{{ item[2] }}<small>总计 {{ item[3] }}</small></strong></button></div><div class="empty-detail" /></div><footer class="inline-setting"><button class="switch" /><strong>计费网络模式</strong><p>启动后所有进程将默认禁止使用网络，适用于按流量计费的网络。</p></footer></div></template>
