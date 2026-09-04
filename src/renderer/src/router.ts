import { createRouter, createWebHashHistory } from 'vue-router'
import ActivityView from './views/ActivityView.vue'
import OverviewView from './views/OverviewView.vue'
import PolicyView from './views/PolicyView.vue'
import RulesView from './views/RulesView.vue'
import ConfigView from './views/ConfigView.vue'
import ProviderSettingsView from './views/ProviderSettingsView.vue'
import MoreView from './views/MoreView.vue'
import LogsView from './views/LogsView.vue'
import ConnectionsView from './views/ConnectionsView.vue'
import DeviceListView from './views/DeviceListView.vue'
import AppearanceView from './views/AppearanceView.vue'
import GeneralView from './views/GeneralView.vue'
import DnsView from './views/DnsView.vue'
import AboutView from './views/AboutView.vue'
import OverridesView from './views/OverridesView.vue'
import ResourcesView from './views/ResourcesView.vue'
import NetworkSettingsView from './views/NetworkSettingsView.vue'
import DnsSnifferView from './views/DnsSnifferView.vue'
import KernelSettingsView from './views/KernelSettingsView.vue'
import { isRcSupportedRoute } from '@shared/release-scope'
import { consumeNavigationBypass, hasUnsavedChanges, requestNavigation } from './composables/use-unsaved-changes'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/activity' },
    { path: '/activity', component: ActivityView },
    { path: '/overview', component: OverviewView },
    { path: '/processes', redirect: '/connections' },
    { path: '/devices', component: DeviceListView },
    { path: '/policies', component: PolicyView },
    { path: '/rules', component: RulesView },
    { path: '/profiles', component: ConfigView },
    { path: '/config', redirect: '/profiles' },
    { path: '/overrides', component: OverridesView },
    { path: '/resources', component: ResourcesView },
    { path: '/providers', component: ProviderSettingsView },
    { path: '/more', component: MoreView },
    { path: '/logs', component: LogsView },
    { path: '/connections', component: ConnectionsView },
    { path: '/appearance', component: AppearanceView },
    { path: '/general', component: GeneralView },
    { path: '/dns', component: DnsView },
    { path: '/dns-sniffer', component: DnsSnifferView },
    { path: '/network', component: NetworkSettingsView },
    { path: '/kernel-settings', component: KernelSettingsView },
    { path: '/about', component: AboutView },
    // Unsupported Surge-like pages are absent from the route table. A stale
    // bookmark cannot reopen a misleading, non-functional control surface.
    { path: '/:pathMatch(.*)*', redirect: (to) => isRcSupportedRoute(to.path) ? to.path : '/activity' }
  ]
})

router.beforeEach((to) => {
  if (!hasUnsavedChanges.value || consumeNavigationBypass(to.fullPath)) return true
  requestNavigation(to.fullPath)
  return false
})
