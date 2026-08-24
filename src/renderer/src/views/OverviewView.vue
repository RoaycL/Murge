<script setup lang="ts">
import { ref } from 'vue'
import SurfaceCard from '../components/SurfaceCard.vue'

const systemProxy = ref(true)
const tun = ref(true)
const allowLan = ref(false)
</script>

<template>
  <div class="page-shell overview-view">
    <h1>概览</h1>
    <section><h2>网络接管</h2><div class="overview-grid">
      <SurfaceCard><div class="setting-head"><div><h3>系统代理</h3><p>大多数应用的流量可以通过将系统代理指向本应用，具有最佳的兼容性和性能。</p></div><button class="switch" :class="{ on: systemProxy }" @click="systemProxy = !systemProxy" /></div><div class="setting-status"><i :class="{ active: systemProxy }" />{{ systemProxy ? '当前被设置为系统代理' : '系统代理未启用' }}</div></SurfaceCard>
      <SurfaceCard><div class="setting-head"><div><h3>TUN 模式</h3><p>接管不遵循系统代理设置的应用流量，需要系统权限和正确安装的服务组件。</p></div><button class="switch" :class="{ on: tun }" @click="tun = !tun" /></div><div class="setting-status"><i :class="{ active: tun }" />{{ tun ? 'TUN 模式已激活' : 'TUN 模式未启用' }}</div></SurfaceCard>
    </div></section>
    <section><h2>局域网设备接管</h2><div class="overview-grid">
      <SurfaceCard><div class="setting-head"><div><h3>HTTP & SOCKS5 代理</h3><p>允许其他设备使用标准 HTTP 和 SOCKS5 代理服务器。</p></div><button class="switch" :class="{ on: allowLan }" @click="allowLan = !allowLan" /></div><div class="setting-status"><i :class="{ active: allowLan }" />{{ allowLan ? '已开放至局域网' : '当前仅监听本机地址' }}</div></SurfaceCard>
    </div></section>
  </div>
</template>
