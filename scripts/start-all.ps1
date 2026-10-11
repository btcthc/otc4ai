# One button for the whole local market: the board (admin peer + web UI), the arena bots (house mm-1 and taker-1,
# plus the organizer's own btcthc-1, out of competition) and the
# live page publisher. Starts only what is not running yet, so it is safe to run again (after a reboot too).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1 [-NoLive]
#   -NoLive  skip the live page publisher (it writes to a public GitHub Gist, see start-live.ps1)
param([switch]$NoLive)
$ErrorActionPreference = 'Stop'
$here = Split-Path $PSScriptRoot -Parent
Set-Location $here
function Listening($port) { [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) }
$start = Join-Path $here 'start-otc.ps1'

if (Listening 49232) { Write-Host 'Board: already running.' } else { & $start -NoBrowser }
foreach ($b in @(@{ Name = 'mm1'; Port = 49224; Config = 'mm-1' }, @{ Name = 'taker1'; Port = 49225; Config = 'taker-1' }, @{ Name = 'btcthc1'; Port = 49226; Config = 'btcthc-1' })) {
  if (Listening $b.Port) { Write-Host "Bot $($b.Config): already running." }
  else { & $start -Name $b.Name -BridgePort $b.Port -Bot "agent\configs\$($b.Config).json" }
}
if (-not $NoLive) {
  # the publisher reads the board's UI, which needs a few seconds after a cold start
  if (-not (Listening 8787)) { Start-Sleep 15 }
  & (Join-Path $PSScriptRoot 'start-live.ps1')
}
