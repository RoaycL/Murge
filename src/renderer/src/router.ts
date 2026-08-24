import { createRouter, createWebHashHistory } from 'vue-router'
import ActivityView from './views/ActivityView.vue'
import OverviewView from './views/OverviewView.vue'
import ProcessListView from './views/ProcessListView.vue'
import DeviceListView from './views/DeviceListView.vue'
import PolicyView from './views/PolicyView.vue'
import RulesView from './views/RulesView.vue'
import CaptureView from './views/CaptureView.vue'
import DecryptView from './views/DecryptView.vue'
import RewriteView from './views/RewriteView.vue'
import MoreView from './views/MoreView.vue'
import PlaceholderView from './views/PlaceholderView.vue'

const placeholder = (title: string) => ({ component: PlaceholderView, props: { title } })

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/activity' },
    { path: '/activity', component: ActivityView },
    { path: '/overview', component: OverviewView },
    { path: '/processes', component: ProcessListView },
    { path: '/devices', component: DeviceListView },
    { path: '/policies', component: PolicyView },
    { path: '/rules', component: RulesView },
    { path: '/capture', component: CaptureView },
    { path: '/decrypt', component: DecryptView },
    { path: '/rewrite', component: RewriteView },
    { path: '/more', component: MoreView },
    { path: '/panel', ...placeholder('面板') }
  ]
})
