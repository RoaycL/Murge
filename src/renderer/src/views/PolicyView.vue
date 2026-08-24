<script setup lang="ts">
const nodes = [['Shadowsocks','Hong Kong 01','42 ms'],['Hysteria 2','Tokyo 01','67 ms'],['VLESS','Singapore 01','81 ms'],['Trojan','Los Angeles 01','153 ms'],['Hysteria 2','Seoul 01','75 ms'],['VLESS','Frankfurt 01','238 ms']]
</script>
<template><div class="page-shell policy-view"><h1>策略</h1><div class="mode-selector"><button>直接连接</button><button>全局代理</button><button class="selected">规则判定</button></div><div class="section-caption"><span>代理</span><button>测试全部</button></div><div class="node-grid"><button v-for="node in nodes" :key="node[1]"><small>{{ node[0] }}</small><strong>{{ node[1] }}</strong><span>{{ node[2] }}</span></button><button class="add-node">＋</button></div></div></template>
