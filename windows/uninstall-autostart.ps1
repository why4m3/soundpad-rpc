# Убирает soundpad-rpc из автозагрузки (ярлык и/или задачу планировщика) и останавливает его.
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'soundpad-rpc'
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) "$name.lnk"
if (Test-Path $lnk) { Remove-Item $lnk; Write-Host "Удалён ярлык $lnk" }
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Host "Удалена задача планировщика '$name'"
}
& (Join-Path $here 'stop.ps1')
