# Добавляет soundpad-rpc в автозагрузку Windows (ярлык в папке "Автозагрузка",
# запуск через wscript без окна консоли) и сразу запускает его.
#   powershell -ExecutionPolicy Bypass -File windows\install-autostart.ps1
#   ... -Task   вместо ярлыка создать задачу планировщика "при входе в систему"
param([switch]$Task, [switch]$NoStart)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here 'start-hidden.vbs'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'

# Релизная сборка (soundpad-rpc.exe рядом) Node.js не требует.
$exe = Join-Path (Split-Path -Parent $here) 'soundpad-rpc.exe'
if (Test-Path $exe) {
  Write-Host "Программа: $exe"
} else {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node.js не найден в PATH. Установите Node.js 20+ с https://nodejs.org или скачайте готовую сборку из Releases' }
  $ver = (& $node.Source --version)
  if ([int]($ver.TrimStart('v').Split('.')[0]) -lt 20) { Write-Warning "Node ${ver}: рекомендуется 20+" }
  Set-Content -Path (Join-Path $here 'node-path.txt') -Value $node.Source -Encoding ASCII
  Write-Host "Node: $($node.Source) ($ver)"
}

$name = 'soundpad-rpc'
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) "$name.lnk"

if ($Task) {
  if (Test-Path $lnk) { Remove-Item $lnk }
  $action = New-ScheduledTaskAction -Execute $wscript -Argument "`"$vbs`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Discord Rich Presence for Soundpad' -Force | Out-Null
  Write-Host "Создана задача планировщика '$name' (при входе в систему)."
} else {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = $wscript
  $sc.Arguments = "`"$vbs`""
  $sc.WorkingDirectory = Split-Path -Parent $here
  $sc.Description = 'Discord Rich Presence for Soundpad'
  $sc.Save()
  Write-Host "Ярлык автозагрузки: $lnk"
}

if (-not $NoStart) {
  Start-Process -FilePath $wscript -ArgumentList "`"$vbs`""
  Write-Host 'soundpad-rpc запущен в фоне. Лог: soundpad-rpc.log в папке программы.'
}
