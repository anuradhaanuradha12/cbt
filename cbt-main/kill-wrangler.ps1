$pat = 'wrang' + 'ler'
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like ('*' + $pat + '*') } | ForEach-Object {
  Write-Host ('killing node pid ' + $_.ProcessId)
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}