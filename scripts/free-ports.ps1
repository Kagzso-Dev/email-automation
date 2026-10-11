<#
  Safely stop ONLY this project's local dev processes.

  Targets:
    * whatever is LISTENING on TCP 4000 / 5173 / 5174 / 8002
      (API, Vite dev server, Vite's stray fallback port, voice backend)
    * node.exe processes whose command line clearly belongs to this repo's
      dev stack: npm-run-all, `tsx watch src/index.ts|src/worker.ts`, vite

  It does NOT touch MySQL, other Node apps, editors, or MCP helpers.
  Nothing in .env, the database config, or the worker config is changed.

  Usage:
    npm run dev:kill
    # or directly:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/free-ports.ps1
#>

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$ports = 4000, 5173, 5174, 8002

$pids = [System.Collections.Generic.HashSet[int]]::new()

# 1. Owners of the dev listener ports.
foreach ($p in $ports) {
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { [void]$pids.Add([int]$_.OwningProcess) }
}

# 2. This repo's dev node processes, matched by command line.
$rootEsc = [regex]::Escape($projectRoot)
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and
    ($_.CommandLine -match $rootEsc -or $_.CommandLine -match 'email-automation-platform') -and
    ($_.CommandLine -match 'npm-run-all' -or
     $_.CommandLine -match 'tsx.+watch' -or
     $_.CommandLine -match 'vite[\\/]bin[\\/]vite' -or
     $_.CommandLine -match 'src[\\/](index|worker)\.ts')
  } |
  ForEach-Object { [void]$pids.Add([int]$_.ProcessId) }

# 3. The voice backend started by `npm run dev:voice` (uvicorn from its .venv).
Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine -match 'kagzso-voice-backend-english' -and
    $_.CommandLine -match 'uvicorn'
  } |
  ForEach-Object { [void]$pids.Add([int]$_.ProcessId) }

if ($pids.Count -eq 0) {
  Write-Host "No Dispatch dev processes or listeners on $($ports -join ', ') found. Nothing to do."
  return
}

Write-Host "Stopping these processes:" -ForegroundColor Yellow
foreach ($procId in $pids) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
  $cmd = if ($proc) { $proc.CommandLine } else { '(already gone)' }
  Write-Host ("  PID {0,-7} {1}" -f $procId, $cmd)
}

# Kill each whole tree so `tsx watch` can't respawn the child holding the port.
# taskkill writes to stderr for already-gone PIDs; that is expected, not a failure.
foreach ($procId in $pids) {
  try { & taskkill.exe /PID $procId /T /F *>$null } catch { }
}

Start-Sleep -Milliseconds 600

$stillBusy = foreach ($p in $ports) {
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
}
if ($stillBusy) {
  Write-Warning ("Ports still in use: {0}" -f (($stillBusy.LocalPort | Sort-Object -Unique) -join ', '))
  exit 1
}

Write-Host "Freed ports $($ports -join ', '). Safe to run 'npm run dev'." -ForegroundColor Green
