# Renders the dashboard preview to PNG files with headless Edge/Chrome.
# Usage: powershell -File tools\preview\shot.ps1 -Tabs pipeline,quality -Theme dark -Out C:\temp\shots [-Scenario busy-project] [-Width 1400 -Height 1000]
param(
  [string[]]$Tabs = @('pipeline'),
  [string]$Theme = 'dark',
  [string]$Scenario = 'busy-project',
  [string]$Out = "$env:TEMP\rp-shots",
  [int]$Width = 1400,
  [int]$Height = 1000
)
$browser = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Neither Edge nor Chrome was found.' }
New-Item -ItemType Directory -Force $Out | Out-Null
$page = (Resolve-Path (Join-Path $PSScriptRoot 'preview.html')).Path -replace '\\', '/'
foreach ($tab in ($Tabs -split ",")) {
  $file = Join-Path $Out "$tab-$Theme.png"
  $url = "file:///$page#tab=$tab&theme=$Theme&scenario=$Scenario"
  & $browser --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size="$Width,$Height" --virtual-time-budget=4000 --screenshot="$file" $url 2>$null | Out-Null
  Write-Output $file
}
