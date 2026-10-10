<#
.SYNOPSIS
    Verify both frontend applications: unit tests, type checks and production builds.

.DESCRIPTION
    Runs every frontend verification step in one pass and prints a single consolidated report.

    Why a single script: under this sandbox each external command needs its own process
    spawn permission, and the esbuild service (used by vite/vitest) requires spawning a
    grandchild process. Batching all frontend verification into one invocation keeps the
    required elevation to a single approval.

    Success is determined from machine readable artefacts rather than exit codes, because
    this environment cannot reliably read child ExitCode values:
      - vitest : --reporter=json --outputFile=<file>, then parse numFailedTests
      - vue-tsc: absence of "error TS" in the captured output
      - vite   : absence of "error" lines plus presence of expected build artefacts

    NOTE: ASCII only. Windows PowerShell 5.1 decodes .ps1 files as ANSI unless a UTF-8 BOM
    is present, so non-ASCII characters here would corrupt parsing.

    Usage:
        & scripts\verify-frontend.ps1
        & scripts\verify-frontend.ps1 -Only miniapp
#>
[CmdletBinding()]
param(
    [ValidateSet('all', 'miniapp', 'admin')][string] $Only = 'all',
    [int] $TailLines = 30
)

$ErrorActionPreference = 'Continue'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$logRoot = Join-Path $repoRoot '.runlogs\verify'
if (-not (Test-Path -LiteralPath $logRoot)) {
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
}

$pnpm = 'C:\Program Files\nodejs\pnpm.cmd'
if (-not (Test-Path -LiteralPath $pnpm)) { $pnpm = 'pnpm.cmd' }

# Each step: id, working dir (relative), executable, arguments, kind
$steps = @(
    @{
        Id   = 'miniapp:typecheck'
        Dir  = 'frontend\miniapp'
        Exe  = $pnpm
        Args = @('exec', 'vue-tsc', '--noEmit', '-p', 'tsconfig.json')
        Kind = 'tsc'
        App  = 'miniapp'
    },
    @{
        Id   = 'miniapp:test'
        Dir  = 'frontend\miniapp'
        Exe  = $pnpm
        Args = @('exec', 'vitest', 'run', '--pool=threads', '--reporter=json', '--outputFile=../../.runlogs/verify/miniapp-vitest.json')
        Kind = 'vitest'
        App  = 'miniapp'
        Json = '.runlogs\verify\miniapp-vitest.json'
    },
    @{
        Id   = 'miniapp:build'
        Dir  = 'frontend\miniapp'
        Exe  = $pnpm
        Args = @('exec', 'uni', 'build', '-p', 'mp-weixin')
        Kind = 'build'
        App  = 'miniapp'
        Artefacts = @('dist\build\mp-weixin\app.json', 'dist\build\mp-weixin\project.config.json')
    },
    @{
        Id   = 'admin:typecheck'
        Dir  = 'frontend\admin'
        Exe  = $pnpm
        Args = @('exec', 'vue-tsc', '--noEmit', '-p', 'tsconfig.json')
        Kind = 'tsc'
        App  = 'admin'
    },
    @{
        Id   = 'admin:test'
        Dir  = 'frontend\admin'
        Exe  = $pnpm
        Args = @('exec', 'vitest', 'run', '--pool=threads', '--reporter=json', '--outputFile=../../.runlogs/verify/admin-vitest.json')
        Kind = 'vitest'
        App  = 'admin'
        Json = '.runlogs\verify\admin-vitest.json'
    },
    @{
        Id   = 'admin:build'
        Dir  = 'frontend\admin'
        Exe  = $pnpm
        Args = @('exec', 'vite', 'build')
        Kind = 'build'
        App  = 'admin'
        Artefacts = @('dist\index.html')
    }
)

if ($Only -ne 'all') {
    $steps = $steps | Where-Object { $_.App -eq $Only }
}

$results = @()

foreach ($step in $steps) {
    $workDir = Join-Path $repoRoot $step.Dir
    if (-not (Test-Path -LiteralPath $workDir)) {
        $results += [pscustomobject]@{
            Step = $step.Id; Result = 'SKIP'; Detail = "working dir missing: $workDir"
        }
        continue
    }

    $safeName = $step.Id -replace ':', '-'
    $outLog = Join-Path $logRoot "$safeName.out.log"
    $errLog = Join-Path $logRoot "$safeName.err.log"
    Remove-Item -LiteralPath $outLog, $errLog, (Join-Path $logRoot "$safeName.done") -Force -ErrorAction SilentlyContinue

    # Clean previous vitest json so a stale file cannot be mistaken for a fresh result
    if ($step.Json) {
        Remove-Item -LiteralPath (Join-Path $repoRoot $step.Json) -Force -ErrorAction SilentlyContinue
    }

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $spawnNote = ''

    try {
        $proc = Start-Process -FilePath $step.Exe -ArgumentList $step.Args -WorkingDirectory $workDir `
            -RedirectStandardOutput $outLog -RedirectStandardError $errLog -NoNewWindow -PassThru -ErrorAction Stop
        $proc.WaitForExit()
    }
    catch {
        $spawnNote = $_.Exception.Message
    }
    $stopwatch.Stop()

    $stdout = if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog -Encoding UTF8 -Raw } else { '' }
    $stderr = if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -Encoding UTF8 -Raw } else { '' }
    $combined = "$stdout`n$stderr"

    $result = 'UNKNOWN'
    $detail = ''

    switch ($step.Kind) {
        'tsc' {
            $tsErrors = @([regex]::Matches($combined, 'error TS\d+'))
            if ($tsErrors.Count -eq 0) {
                $result = 'PASS'; $detail = 'no type errors'
            }
            else {
                $result = 'FAIL'; $detail = "$($tsErrors.Count) type error(s)"
            }
        }

        'vitest' {
            $jsonPath = Join-Path $repoRoot $step.Json
            if (Test-Path -LiteralPath $jsonPath) {
                try {
                    $summary = (Get-Content -LiteralPath $jsonPath -Encoding UTF8 -Raw | ConvertFrom-Json)
                    $failed = [int]$summary.numFailedTests
                    $passed = [int]$summary.numPassedTests
                    $total = [int]$summary.numTotalTests
                    $suites = [int]$summary.numTotalTestSuites

                    if ($failed -eq 0 -and $total -gt 0) {
                        $result = 'PASS'; $detail = "$passed/$total tests passed in $suites suites"
                    }
                    elseif ($total -eq 0) {
                        $result = 'FAIL'; $detail = 'no tests were collected'
                    }
                    else {
                        $result = 'FAIL'; $detail = "$failed of $total tests failed"
                    }
                }
                catch {
                    $result = 'FAIL'; $detail = "cannot parse vitest json: $($_.Exception.Message)"
                }
            }
            else {
                $result = 'FAIL'; $detail = 'vitest produced no json report'
            }
        }

        'build' {
            $missing = @()
            foreach ($artefact in $step.Artefacts) {
                if (-not (Test-Path -LiteralPath (Join-Path $workDir $artefact))) { $missing += $artefact }
            }

            $hasError = $combined -match '(?m)^\s*(error|Error:|ERROR)\b' -or $combined -match 'EPERM|ERR_'

            if ($missing.Count -eq 0 -and -not $hasError) {
                $result = 'PASS'; $detail = "artefacts ok: $($step.Artefacts -join ', ')"
            }
            elseif ($missing.Count -gt 0) {
                $result = 'FAIL'; $detail = "missing artefacts: $($missing -join ', ')"
            }
            else {
                $result = 'FAIL'; $detail = 'build output contains errors'
            }
        }
    }

    $results += [pscustomobject]@{
        Step   = $step.Id
        Result = $result
        Detail = $detail
        Line   = "log: $outLog"
    }

    Write-Output ("=" * 100)
    Write-Output "[$result] $($step.Id)  ({0:N1}s)  {1}" -f $stopwatch.Elapsed.TotalSeconds, $detail
    if ($spawnNote) { Write-Output "  spawnNote: $spawnNote" }
    Write-Output "  cmd: $($step.Exe) $($step.Args -join ' ')"
    Write-Output "  dir: $workDir"

    $lines = @($combined -split "`r?`n" | Where-Object { $_ -ne '' })
    if ($lines.Count -gt 0) {
        Write-Output "  --- output (last $TailLines lines) ---"
        $lines | Select-Object -Last $TailLines | ForEach-Object { Write-Output "  $_" }
    }
}

Write-Output ("=" * 100)
Write-Output 'SUMMARY'
$results | Format-Table -AutoSize | Out-String -Width 200 | Write-Output

$failed = @($results | Where-Object { $_.Result -ne 'PASS' -and $_.Result -ne 'SKIP' })
if ($failed.Count -eq 0) {
    Write-Output "ALL CHECKS PASSED ($($results.Count) steps)"
}
else {
    Write-Output "FAILED STEPS: $($failed.Count)"
    $failed | ForEach-Object { Write-Output "  - $($_.Step): $($_.Detail)" }
}
