<script setup lang="ts">
import {
  Activity, AppWindow, ArrowDown, ArrowUp, Braces, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Clipboard,
  CloudDownload, Code2, Cpu, Database, Download, Ellipsis, Eye, FileCog, FilePlus2, Globe2, Info, Laptop,
  LayoutDashboard, ListTree, Logs, Network, Palette, PanelRightClose, Pencil, Plus, RefreshCw,
  Route, Search, ServerCog, Settings2, ShieldCheck, SlidersHorizontal, Trash2,
  Upload, Wifi, X
} from 'lucide-vue-next'
import type { Component } from 'vue'
import SubStoreIcon from './SubStoreIcon.vue'

export type AppIconName =
  | 'activity' | 'overview' | 'connections' | 'processes' | 'devices'
  | 'policies' | 'rules' | 'profiles' | 'overrides' | 'resources'
  | 'more' | 'general' | 'network' | 'dns' | 'kernel' | 'appearance'
  | 'logs' | 'about' | 'search' | 'refresh' | 'add-file' | 'clipboard'
  | 'upload' | 'download' | 'delete' | 'close' | 'back' | 'next'
  | 'drawer-close' | 'server' | 'security' | 'code' | 'database' | 'substore' | 'more-horizontal'
  | 'chevron-down' | 'check' | 'edit' | 'add' | 'move-up' | 'move-down' | 'success' | 'error' | 'eye'

defineProps<{ name: AppIconName; size?: number; strokeWidth?: number }>()

const icons: Record<AppIconName, Component> = {
  activity: Activity,
  overview: LayoutDashboard,
  connections: Network,
  processes: AppWindow,
  devices: Laptop,
  policies: Route,
  rules: ListTree,
  profiles: FileCog,
  overrides: Braces,
  resources: CloudDownload,
  more: Settings2,
  general: SlidersHorizontal,
  network: Wifi,
  dns: Globe2,
  kernel: Cpu,
  appearance: Palette,
  logs: Logs,
  about: Info,
  search: Search,
  refresh: RefreshCw,
  'add-file': FilePlus2,
  clipboard: Clipboard,
  upload: Upload,
  download: Download,
  delete: Trash2,
  close: X,
  back: ChevronLeft,
  next: ChevronRight,
  'drawer-close': PanelRightClose,
  server: ServerCog,
  security: ShieldCheck,
  code: Code2,
  database: Database,
  substore: SubStoreIcon,
  'more-horizontal': Ellipsis,
  'chevron-down': ChevronDown,
  check: Check,
  edit: Pencil,
  add: Plus,
  'move-up': ArrowUp,
  'move-down': ArrowDown,
  success: CircleCheck,
  error: CircleAlert,
  eye: Eye
}
</script>

<template>
  <component :is="icons[name]" :size="size ?? 18" :stroke-width="strokeWidth ?? 1.8" aria-hidden="true" />
</template>
