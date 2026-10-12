param([int]$Port = 3000)

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1

if ($listener) {
  Write-Error "Port $Port is already in use by process $($listener.OwningProcess). Nothing was stopped. Use the running app, stop it with Ctrl+C in its terminal, or start this copy with `$env:PORT set to another available port."
  exit 1
}

npm start
