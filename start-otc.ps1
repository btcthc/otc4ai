# Starts your OTC Bitcoin peer (own console window) and the local web UI, then opens the browser.
# Usage:  powershell -ExecutionPolicy Bypass -File .\start-otc.ps1 [-Name admin] [-BridgePort 49222] [-UiPort 8787]
#         add -Bot agent\configs\mm-1.json to run a trading bot on this peer instead of the web UI
param([string]$Name = "admin", [int]$BridgePort = 49222, [int]$UiPort = 8787, [string]$Bot = "", [switch]$NoBrowser)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
Set-Location $here

# Intercom needs Node 22/23. Prefer a portable Node 22 next to the project if present.
$portable = Join-Path (Split-Path $here -Parent) ".tools\node22"
if (Test-Path (Join-Path $portable "node.exe")) { $env:PATH = "$portable;$env:PATH" }
$v = (& node -v)
if ($v -notmatch '^v2[23]\.') { Write-Host "Intercom needs Node 22 or 23 (found $v)." -ForegroundColor Red; exit 1 }
if (-not (Test-Path (Join-Path $here "node_modules"))) { npm install }

$ch = Get-Content (Join-Path $here "otc\channel.json") -Raw | ConvertFrom-Json
Set-Content -Path (Join-Path $here "otc\welcome.b64") -Value $ch.welcome -NoNewline -Encoding ascii

# Fresh random bridge token per start; it never leaves this machine.
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''

$peerArgs = @(
  "--peer-store-name", "otc-$Name", "--msb-store-name", "otc-$Name-msb", "--subnet-channel", "otc-bitcoin-$Name",
  "--sc-bridge", "1", "--sc-bridge-port", "$BridgePort", "--sc-bridge-token", $token,
  "--sidechannels", $ch.channel, "--sidechannel-owner", "$($ch.channel):$($ch.owner)",
  "--sidechannel-welcome", "$($ch.channel):@./otc/welcome.b64", "--sidechannel-verify-channels", $ch.channel
) -join ' '
$pathLine = "`$env:PATH='$env:PATH'"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "$pathLine; Set-Location '$here'; `$host.UI.RawUI.WindowTitle='OTC Bitcoin peer ($Name)'; npm start -- $peerArgs"
if ($Bot) {
  # The bot waits a little for the peer's bridge, then trades through it.
  $botLine = "Start-Sleep 20; node agent/run-bot.mjs '$Bot' $token $BridgePort"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "$pathLine; Set-Location '$here'; `$host.UI.RawUI.WindowTitle='OTC Bitcoin bot ($Name)'; $botLine"
  Write-Host "Peer and bot ($Bot) starting." -ForegroundColor Green
  exit 0
}
Start-Process powershell -ArgumentList "-NoExit", "-Command", "$pathLine; Set-Location '$here'; `$host.UI.RawUI.WindowTitle='OTC Bitcoin UI ($Name)'; node scripts/otc-ui.mjs $token $BridgePort $UiPort" -WindowStyle Minimized

Write-Host "Peer and UI starting. Board: http://127.0.0.1:$UiPort" -ForegroundColor Green
if (-not $NoBrowser) { Start-Sleep 4; Start-Process "http://127.0.0.1:$UiPort" }
