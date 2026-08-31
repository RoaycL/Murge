<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()
const items = [
  ['通用', '基础运行、启动与网络相关设置。', '/general'],
  ['外观', '主题、对比度和动态效果设置。', '/appearance'],
  ['DNS', '查询解析结果并管理 mihomo DNS 缓存。', '/dns'],
  ['日志', '查看、筛选并导出已脱敏的实时日志。', '/logs'],
  ['关于', '版本、支持链接与无敏感信息的诊断包。', '/about']
] as const
</script>
<template><div class="page-shell more-view"><h1>设置</h1><div class="settings-menu"><button v-for="item in items" :key="item[0]" type="button" @click="item[2] && router.push(item[2])"><i /><strong>{{ item[0] }}</strong><span>{{ item[1] }}</span></button></div></div></template>
