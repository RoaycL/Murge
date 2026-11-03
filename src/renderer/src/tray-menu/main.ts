/**
 * Entry of the frosted tray popup (`tray-menu.html`). A deliberately tiny
 * page: no router, no stores, no desktop bridge — it only renders the menu
 * snapshot the shell pushes and reports what the user picked.
 */
import { createApp } from 'vue'
import TrayMenuApp from './TrayMenuApp.vue'

createApp(TrayMenuApp).mount('#tray-menu')
