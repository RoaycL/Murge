import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

if (!process.env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is required')
const source = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
// Only the test executable enables DevTools/CDP. Keep every source window
// property (including the titlebar) intact; release artifacts use no override.
const override = { app: { windows: source.app.windows.map((window) => ({ ...window, devtools: true })) } }
await mkdir(process.env.RUNNER_TEMP, { recursive: true })
await writeFile(resolve(process.env.RUNNER_TEMP, 'tauri-gui-config.json'), JSON.stringify(override, null, 2) + '\n')
