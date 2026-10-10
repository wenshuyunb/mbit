<#
.SYNOPSIS
    Run an external command reliably inside this restricted sandbox and capture its output to files.

.DESCRIPTION
    In this environment pwsh cannot capture a child process stdout/stderr through a pipe
    (symptom: no output, no exit code). This runner uses Start-Process with file redirection
    and then reads the log files back, so the real exit code and full output are available.

    NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 decodes .ps1 files as
    ANSI/GBK unless a UTF-8 BOM is present, so non-ASCII characters here would corrupt parsing.

    Usage:
        & scripts\run.ps1 -Exe node -Args "node_modules/jest/bin/jest.js","--ci" -WorkDir backend
        & scripts\run.ps1 -Exe node -Args "node_modules/typescript/bin/tsc","--noEmit" -WorkDir backend -LogName typecheck

    Output:
        <WorkDir>\.runlogs\<LogName>.out.log and <LogName>.err.log
        Console prints the exit code plus the tail of both logs.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Exe,
    [string[]] $Args = @(),
    [string] $WorkDir = '.',
    [string] $LogName = 'run',
    [int] $TailLines = 250
)

$ErrorActionPreference = 'Continue'

$work = (Resolve-Path -LiteralPath $WorkDir).Path
$logDir = Join-Path $work '.runlogs'
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

$outLog = Join-Path $logDir "$LogName.out.log"
$errLog = Join-Path $logDir "$LogName.err.log"
Remove-Item -LiteralPath $outLog -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $errLog -Force -ErrorAction SilentlyContinue

$started = Get-Date
$exitCode = $null
$spawnError = $null

try {
    # Do NOT use -Wait here: under this sandbox the -Wait parameter fails with
    # "Access is denied" even though the process runs fine, which loses ExitCode.
    $proc = Start-Process -FilePath $Exe -ArgumentList $Args -WorkingDirectory $work -RedirectStandardOutput $outLog -RedirectStandardError $errLog -NoNewWindow -PassThru -ErrorAction Stop
    $proc.WaitForExit()
    $exitCode = $proc.ExitCode
}
catch {
    $spawnError = $_.Exception.Message
}

$elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)

Write-Output "=== run.ps1 ==="
Write-Output "exe       : $Exe"
Write-Output "args      : $($Args -join ' ')"
Write-Output "workdir   : $work"
Write-Output "elapsed   : ${elapsed}s"
if ($null -eq $exitCode) { Write-Output "exitCode  : <none>" } else { Write-Output "exitCode  : $exitCode" }
if ($spawnError) { Write-Output "spawnNote : $spawnError" }

foreach ($pair in @(@('STDOUT', $outLog), @('STDERR', $errLog))) {
    $label = $pair[0]
    $path = $pair[1]
    if (Test-Path -LiteralPath $path) {
        $size = (Get-Item -LiteralPath $path).Length
        # Read as UTF-8 explicitly: Node and modern tools emit UTF-8, while
        # Windows PowerShell 5.1 would otherwise decode as ANSI and mangle CJK output.
        $lines = @(Get-Content -LiteralPath $path -Encoding UTF8 -ErrorAction SilentlyContinue)
        Write-Output "--- $label ($size bytes, $($lines.Count) lines) -> $path ---"
        if ($lines.Count -gt $TailLines) {
            Write-Output "(showing last $TailLines lines)"
            $lines | Select-Object -Last $TailLines | ForEach-Object { Write-Output $_ }
        }
        else {
            $lines | ForEach-Object { Write-Output $_ }
        }
    }
    else {
        Write-Output "--- $label (no file) ---"
    }
}
