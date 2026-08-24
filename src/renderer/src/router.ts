import { createRouter, createWebHashHistory } from 'vue-router'
import ActivityView from './views/ActivityView.vue'
import OverviewView from './views/OverviewView.vue'
import PlaceholderView from './views/PlaceholderView.vue'

const placeholder = (title: string) => ({ component: PlaceholderView, props: { title } })

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/activity' },
    { path: '/activity', component: ActivityView },
    { path: '/overview', component: OverviewView },
    { path: '/processes', ...placeholder('进程') },
    { path: '/devices', ...placeholder('设备') },
    { path: '/policies', ...placeholder('策略') },
    { path: '/rules', ...placeholder('规则') },
    { path: '/capture', ...placeholder('捕获') },
    { path: '/decrypt', ...placeholder('解密') },
    { path: '/rewrite', ...placeholder('重写') },
    { path: '/more', ...placeholder('更多') }
  ]
})
