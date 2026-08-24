<script setup lang="ts">
import SurfaceCard from '../components/SurfaceCard.vue'
const cards=[['URL 重定向','重定向 HTTP 请求，可使用多种方式重写请求 URL。'],['Header 重写','修改发送到服务器的 HTTP Header 以及响应 Header。'],['Mock','模拟 API 服务器并返回静态响应。'],['Body 重写','使用正则表达式替换 HTTP 请求或响应 Body。']]
</script>
<template><div class="page-shell rewrite-view"><header class="toggle-title"><h1>重写 & 映射</h1><button class="switch on" /></header><div class="rewrite-cards"><SurfaceCard v-for="card in cards" :key="card[0]"><h2>{{ card[0] }}</h2><p>{{ card[1] }}</p><footer><span>0 条规则生效中</span><button>编辑规则…</button></footer></SurfaceCard></div></div></template>
