<#
  Start local preview servers for manual inspection.

  Usage:
    & .\scripts\start-dev.ps1              # start backend + admin + miniapp H5
    & .\scripts\start-dev.ps1 -Only admin  # start a single target

  What it does:
    1. backend   -> http://127.0.0.1:3000          (NestJS; Swagger at /api/v1/docs)
    2. admin     -> http://127.0.0.1:5174          (Vue3 + Vite; proxies /api to backend)
    3. miniapp   -> http://127.0.0.1:5173          (uni-app H5 preview of the WeChat miniapp)

  Notes:
    - The backend needs PostgreSQL (127.0.0.1:5452) and Redis (127.0.0.1:6379) running,
      otherwise /health/ready reports its dependencies as down.
    - The miniapp H5 preview cannot perform WeChat login (uni.login is unavailable in a
      browser), so it renders as a logged-out guest: layout and navigation are visible,
      authenticated data is not.
    - Logs are written to backend/.runlogs/ (gitignored).

  ASCII-only on purpose: Windows PowerShell 5.1 decodes BOM-less UTF-8 scripts as ANSI,
  and non-ASCII characters have broken scripts in this repo before.
#>

[CmdletBinding()]
param(
  [ValidateSet('all', 'backend', 'admin', 'miniapp')]
  [string]$Only = 'all',

  [switch]$PassThruPids
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repoRoot 'backend\.runlogs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Start-Target {
  param(
    [string]$Name,
    [string]$WorkDir,
    [string]$Command,
    [string]$LogFile
  )

  $outLog = Join-Path $logDir "$LogFile.log"
  $errLog = Join-Path $logDir "$LogFile.err.log"
  Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue

  $proc = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', $Command `
    -WorkingDirectory $WorkDir `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog

  [pscustomobject]@{ Name = $Name; Pid = $proc.Id; Log = $outLog; ErrLog = $errLog }
}

$targets = @()

if ($Only -in @('all', 'backend')) {
  $targets += Start-Target -Name 'backend' -WorkDir (Join-Path $repoRoot 'backend') `
    -Command 'node dist/main.js' -LogFile 'dev-backend'
}

if ($Only -in @('all', 'admin')) {
  $targets += Start-Target -Name 'admin' -WorkDir (Join-Path $repoRoot 'frontend\admin') `
    -Command 'pnpm dev' -LogFile 'dev-admin'
}

if ($Only -in @('all', 'miniapp')) {
  $targets += Start-Target -Name 'miniapp' -WorkDir (Join-Path $repoRoot 'frontend\miniapp') `
    -Command 'pnpm dev:h5' -LogFile 'dev-miniapp'
}

$urls = @{
  backend = 'http://127.0.0.1:3000'
  admin   = 'http://127.0.0.1:5174'
  miniapp = 'http://127.0.0.1:5173'
}

Write-Host ''
Write-Host 'SoulMap AI - local preview' -ForegroundColor Cyan
foreach ($t in $targets) {
  $url = $urls[$t.Name]
  Write-Host ("  {0,-8} pid={1,-7} {2}" -f $t.Name, $t.Pid, $url)
  Write-Host ("           log: {0}" -f $t.Log) -ForegroundColor DarkGray
}
Write-Host ''
Write-Host '  Swagger UI : http://127.0.0.1:3000/api/v1/docs'
Write-Host '  Health     : http://127.0.0.1:3000/health/ready'
Write-Host ''
Write-Host '  Stop: kill ONLY the PIDs listening on 3000 / 5173 / 5174:' -ForegroundColor Yellow
Write-Host '    foreach ($p in 3000,5173,5174) {' -ForegroundColor DarkGray
Write-Host '      Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |' -ForegroundColor DarkGray
Write-Host '        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }' -ForegroundColor DarkGray
Write-Host '    }' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  DO NOT run: Get-Process node | Stop-Process -Force' -ForegroundColor Red
Write-Host '    The dev tooling for this project runs on Node. A blanket kill of every' -ForegroundColor DarkGray
Write-Host '    node process also kills the editor/harness host, which severs the very' -ForegroundColor DarkGray
Write-Host '    session that issued the command (this has actually happened in practice).' -ForegroundColor DarkGray
Write-Host ''

if ($PassThruPids) {
  $targets | ForEach-Object { $_.Pid }
}
