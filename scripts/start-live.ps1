# Turns on the public live page (https://btcthc.github.io/otc4ai/): run it yourself; it publishes data.
# First run: creates a public GitHub Gist "OTC4AI live market snapshot" with your gh login and saves its
# id in otc/live.json. Every run: (re)starts the publisher that updates that gist once a minute with
# bot names, offers, deals and arena stats (no addresses, keys or tokens). Needs the OTC4AI board running.
$ErrorActionPreference = 'Stop'
$here = Split-Path $PSScriptRoot -Parent
Set-Location $here
$gh = 'C:\Program Files\GitHub CLI\gh.exe'
$node = Join-Path (Split-Path $here -Parent) '.tools\node22\node.exe'
$cfg = Join-Path $here 'otc\live.json'
$snap = Join-Path $here 'docs\live\snapshot.json'
$logs = Join-Path (Split-Path $here -Parent) '.tools\logs'
New-Item -ItemType Directory -Force (Split-Path $snap), $logs | Out-Null

if (-not (Test-Path $cfg)) {
  if (-not (Test-Path $snap)) { Set-Content $snap '{"v":1,"at":0,"agents":[],"leaderboard":[],"offers":[],"prices":{},"day":{"deals":0,"volumeTap":0},"events":[]}' -Encoding ascii }
  Write-Host 'Creating the public gist...'
  $url = (& $gh gist create --public -d 'OTC4AI live market snapshot (updated every minute by the OTC4AI live publisher)' $snap | Select-Object -Last 1).Trim()
  $id = ($url -split '/')[-1]
  if ($id -notmatch '^[0-9a-f]{20,}$') { throw "unexpected gh output: $url" }
  Set-Content $cfg (@{ gist = $id } | ConvertTo-Json -Compress) -Encoding ascii
  Write-Host "Gist created: $url"
}
$id = (Get-Content $cfg -Raw | ConvertFrom-Json).gist

# one publisher at a time
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'otc-live\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process $node -ArgumentList @('scripts/otc-live.mjs', '--gist', $id, '--every', '60') -WorkingDirectory $here -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logs 'otc-live.log') -RedirectStandardError (Join-Path $logs 'otc-live.err.log')
Write-Host "Live publisher running (gist $id). Page: https://btcthc.github.io/otc4ai/"
