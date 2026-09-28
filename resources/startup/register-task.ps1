param(
  [Parameter(Mandatory = $true)][string]$TaskName,
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [ValidateSet('0', '1')][string]$PreviouslyEnabled = '0'
)

$ErrorActionPreference = 'Stop'

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator permission is required to register the startup task.'
  }
  if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw "Installed executable does not exist: $ExecutablePath"
  }

  $sid = $identity.User.Value
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  $folder = $service.GetFolder('\')

  $existing = $null
  try {
    $existing = $folder.GetTask("\$TaskName")
  } catch {
    # Task Scheduler may report a missing task as either Win32 file-not-found
    # or SCHED_E_UNKNOWN_OBJECT. PowerShell may wrap the COM error in a method
    # invocation exception, so inspect its innermost HRESULT.
    $taskError = $_.Exception
    while ($null -ne $taskError.InnerException) { $taskError = $taskError.InnerException }
    if ($taskError.HResult -notin @(-2147024894, -2147216625)) { throw }
  }
  if ($null -ne $existing) {
    $existingUser = [string]$existing.Definition.Principal.UserId
    try {
      $existingSid = ([Security.Principal.NTAccount]$existingUser).Translate(
        [Security.Principal.SecurityIdentifier]
      ).Value
    } catch {
      $existingSid = $existingUser
    }
    if ($existingSid -ne $sid) {
      throw "Existing startup task belongs to a different user: $existingUser"
    }
  }
  $enabled = $PreviouslyEnabled -eq '1' -or ($null -ne $existing -and $existing.Enabled)

  $definition = $service.NewTask(0)
  $definition.RegistrationInfo.Description = 'Launch Murge at this user sign-in.'
  $definition.Principal.UserId = $sid
  $definition.Principal.LogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN
  $definition.Principal.RunLevel = 0 # TASK_RUNLEVEL_LUA, never elevate the GUI
  $trigger = $definition.Triggers.Create(9) # TASK_TRIGGER_LOGON
  $trigger.UserId = $sid # Without this, the trigger runs for every user.
  $trigger.Enabled = $true
  $action = $definition.Actions.Create(0) # TASK_ACTION_EXEC
  $action.Path = $ExecutablePath
  $action.Arguments = '--hidden'
  $definition.Settings.Enabled = [bool]$enabled
  $definition.Settings.Priority = 3
  $definition.Settings.ExecutionTimeLimit = 'PT0S'
  $definition.Settings.DisallowStartIfOnBatteries = $false
  $definition.Settings.StopIfGoingOnBatteries = $false
  $definition.Settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW
  $definition.Settings.RunOnlyIfNetworkAvailable = $false

  # The installer is elevated but the later GUI is not. Grant only this same
  # user, SYSTEM and Administrators task-management rights so the GUI can toggle
  # its own least-privilege task without another UAC prompt.
  $sddl = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;$sid)"
  $registered = $folder.RegisterTaskDefinition($TaskName, $definition, 6, $sid, $null, 3, $sddl)
  if ($null -eq $registered -or [bool]$registered.Enabled -ne [bool]$enabled) {
    throw 'The task scheduler did not confirm the requested startup state.'
  }
  Write-Output "Startup task registered; enabled=$enabled; user=$sid"
} catch {
  Write-Error "Startup task registration failed: $($_.Exception.Message)"
  exit 1
}
