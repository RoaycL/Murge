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
import ConfigView from './views/ConfigView.vue'
import ProviderSettingsView from './views/ProviderSettingsView.vue'
import MoreView from './views/MoreView.vue'
import LogsView from './views/LogsView.vue'
import ConnectionsView from './views/ConnectionsView.vue'
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
    { path: '/config', component: ConfigView },
    { path: '/providers', component: ProviderSettingsView },
    { path: '/more', component: MoreView },
    { path: '/logs', component: LogsView },
    { path: '/connections', component: ConnectionsView },
    { path: '/panel', ...placeholder('面板') }
  ]
})
