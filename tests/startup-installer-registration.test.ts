import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('startup task registration script', () => {
  it('binds both the task and trigger to the interactive user without elevating the GUI', async () => {
    const script = await readFile(path.join(root, 'resources/startup/register-task.ps1'), 'utf8')
    expect(script).toContain('$trigger.UserId = $sid')
    expect(script).toContain('$definition.Principal.UserId = $sid')
    expect(script).toContain('$definition.Principal.LogonType = 3')
    expect(script).toContain('$definition.Principal.RunLevel = 0')
    expect(script).toContain('$definition.Settings.Priority = 3')
    expect(script).toContain("$definition.Settings.ExecutionTimeLimit = 'PT0S'")
    expect(script).toContain('D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;$sid)')
    expect(script).toContain('$PreviouslyEnabled -eq \'1\'')
    expect(script).toContain('$folder.RegisterTaskDefinition')
    expect(script).toContain('while ($null -ne $taskError.InnerException)')
    expect(script).toContain('$taskError.HResult -notin @(-2147024894, -2147216625)')
  })
})
