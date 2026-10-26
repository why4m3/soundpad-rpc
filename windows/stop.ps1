# Останавливает запущенный в фоне soundpad-rpc (pid берётся из soundpad-rpc.pid).
$dir = Join-Path $env:LOCALAPPDATA 'soundpad-rpc'
$pidFile = Join-Path $dir 'soundpad-rpc.pid'
$stopped = $false
if (Test-Path $pidFile) {
  $procId = [int](Get-Content $pidFile -Raw)
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -in @('node', 'soundpad-rpc')) {
    Stop-Process -Id $procId -Force
    $stopped = $true
    Write-Host "soundpad-rpc остановлен (pid $procId)"
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}
# Discord сам убирает активность, когда процесс закрывается.
$state = Join-Path $dir 'state.json'
if (Test-Path $state) {
  '{"active": false, "status": "CLOSED", "title": "", "ends_at": null, "pid": 0, "updated_at": 0}' | Set-Content -Path $state -Encoding UTF8
}
if (-not $stopped) { Write-Host 'soundpad-rpc не был запущен' }
