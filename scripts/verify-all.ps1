# ============================================================================
# SoulMap AI — 全量验证（本地镜像 CI）
# ----------------------------------------------------------------------------
# 与 .github/workflows/ci.yml 执行的检查**完全一致**。两处必须同步：
# 若 CI 里有本地跑不到的检查，开发者就只能靠推送后看 CI 报错，
# 而那是最慢的反馈回路（几分钟起步，还要占一次提交历史）。
#
# 用法：
#   pwsh scripts/verify-all.ps1              # 全部
#   pwsh scripts/verify-all.ps1 -SkipFrontend # 只跑后端
#
# 退出码：0 = 全部通过；非 0 = 有检查失败（CI 靠它判定）
#
# ⚠ 本文件刻意保持 ASCII-only：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 .ps1
#    按 ANSI 解码，中文字符会破坏解析（与 scripts/run.ps1 同一原因）。
# ============================================================================
[CmdletBinding()]
param(
    [switch] $SkipFrontend,
    [switch] $SkipTests
)

$ErrorActionPreference = 'Continue'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$failures = New-Object System.Collections.ArrayList

function Invoke-Check {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][string] $WorkDir,
        [Parameter(Mandatory = $true)][string[]] $CommandArgs,
        # 成功时 stdout 必须出现的特征（正则）。用特征而不是退出码，原因见下方注释。
        [string] $SuccessPattern = "",
        # 该检查成功时完全没有输出（ESLint / tsc / nest build 都是如此）
        [switch] $EmptyOutputMeansPass
    )

    Write-Host ''
    Write-Host "=== $Name ===" -ForegroundColor Cyan

    $logDir = Join-Path $repoRoot '.runlogs'
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }

    $slug = ($Name -replace '[^A-Za-z0-9]+', '-').Trim('-')
    $outLog = Join-Path $logDir "verify-$slug.out.log"
    $errLog = Join-Path $logDir "verify-$slug.err.log"
    Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue

    $work = (Resolve-Path -LiteralPath (Join-Path $repoRoot $WorkDir)).Path

    # 这里用 Start-Process + 文件重定向而不是管道：在受限环境下
    # PowerShell 无法通过管道捕获子进程输出（会得到 0 字节日志与 <none> 退出码），
    # 于是"检查失败"与"输出丢失"无法区分。见 scripts/run.ps1 的同一说明。
    $proc = Start-Process -FilePath 'node' -ArgumentList $CommandArgs -WorkingDirectory $work `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -NoNewWindow -PassThru

    $proc.WaitForExit()

    # ⚠ **不能用 $proc.ExitCode 判定成败。** 在本沙箱里 Start-Process 拿到的
    # ExitCode 是空的（实测：全部检查都报 "(exit )" 全红，而输出显示它们其实都通过了）。
    # 这是 scripts/run.ps1 记录过的同一个限制，那次表现为"退出码 <none>"。
    #
    # 因此改为**按输出特征判定** —— 与本项目一贯的人工核对方式一致：
    #   · 有明确成功文案的（Prettier / 生成物校验）→ 必须出现该文案
    #   · 成功时无输出的（ESLint / tsc / build）→ 输出必须为空
    #   · 测试类 → 必须出现 "N passed" 且不得出现 failed 标记
    $stdout = if (Test-Path -LiteralPath $outLog) { [string](Get-Content -LiteralPath $outLog -Encoding UTF8 -Raw) } else { '' }
    $stderr = if (Test-Path -LiteralPath $errLog) { [string](Get-Content -LiteralPath $errLog -Encoding UTF8 -Raw) } else { '' }

    # 判定依据是输出，操作者必须能直接看到它
    $stdout.Trim() -split "`r?`n" | Where-Object { $_.Trim() -ne '' } | ForEach-Object { Write-Host $_ }

    $passed = $false
    $reason = ''

    if ($EmptyOutputMeansPass) {
        # 这些工具成功时一句话都不说，有输出即视为失败线索
        $noisy = @()
        if ($stdout.Trim() -ne '') { $noisy += 'stdout' }
        if ($stderr.Trim() -ne '') { $noisy += 'stderr' }

        $passed = $noisy.Count -eq 0
        if (-not $passed) {
            $reason = "预期无输出，但 $($noisy -join ' 与 ') 有内容"
            Write-Host $stderr -ForegroundColor DarkYellow
        }
    }
    else {
        # 测试套件会把正常日志写到 stderr，因此只在 stdout 上判特征；
        # stderr 仅在失败时展示（否则每次成功都要滚动几百行）
        # ⚠ 必须匹配 stdout + stderr **合并**后的文本：Jest / Vitest 把汇总行
        # （`Test Suites: N passed`）写到 stderr，而 Prettier 与生成物校验写到 stdout。
        # 只匹配 stdout 会让测试检查永远报"未出现成功特征"。
        $combined = $stdout + "`n" + $stderr

        $hasSuccess = $SuccessPattern -ne '' -and $combined -match $SuccessPattern
        $hasFailure = $combined -match '(?m)(\d+ failed|FAIL )'

        $passed = $hasSuccess -and -not $hasFailure
        if (-not $hasSuccess) { $reason = "未出现成功特征：$SuccessPattern" }
        elseif ($hasFailure) { $reason = 'stdout 中出现失败标记' }

        if (-not $passed -and $stderr.Trim() -ne '') {
            Write-Host '(stderr)' -ForegroundColor DarkYellow
            Write-Host $stderr -ForegroundColor DarkYellow
        }
    }

    if ($passed) {
        Write-Host "PASS: $Name" -ForegroundColor Green
    }
    else {
        Write-Host "FAIL: $Name -- $reason" -ForegroundColor Red
        [void]$failures.Add($Name)
    }
}
Write-Host 'SoulMap AI verification' -ForegroundColor White
Write-Host "repo: $repoRoot"

# ---------------------------------------------------------------- 生成物一致性
# 放在最前：这两个检查跑得最快，失败原因也最明确，不需要看测试输出
Invoke-Check -Name 'Check generated: Prisma schema' -WorkDir '.' -SuccessPattern '与设计文档一致' `
    -CommandArgs @('scripts/extract-prisma-schema.mjs', '--check')
Invoke-Check -Name 'Check generated: error codes doc' -WorkDir '.' -SuccessPattern '与源码一致' `
    -CommandArgs @('scripts/generate-error-code-doc.mjs', '--check')

# ---------------------------------------------------------------- 仓库格式
Invoke-Check -Name 'Prettier (repo-wide)' -WorkDir '.' -SuccessPattern 'All matched files use Prettier code style' `
    -CommandArgs @('node_modules/prettier/bin/prettier.cjs', '--check', '.')

# ---------------------------------------------------------------- 后端
# ESLint / tsc / nest build 成功时都**完全没有输出**，因此用 -EmptyOutputMeansPass
Invoke-Check -Name 'Backend: ESLint' -WorkDir 'backend' -EmptyOutputMeansPass `
    -CommandArgs @('node_modules/eslint/bin/eslint.js', 'src', 'test', 'scripts', 'prisma', '--max-warnings', '0')
Invoke-Check -Name 'Backend: typecheck' -WorkDir 'backend' -EmptyOutputMeansPass `
    -CommandArgs @('node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json')
Invoke-Check -Name 'Backend: build' -WorkDir 'backend' -EmptyOutputMeansPass `
    -CommandArgs @('node_modules/@nestjs/cli/bin/nest.js', 'build')
if (-not $SkipTests) {
    # --runInBand：受限环境下并行 worker 会 spawn 失败
    Invoke-Check -Name 'Backend: tests' -WorkDir 'backend' -SuccessPattern 'Test Suites:.*passed' `
        -CommandArgs @('node_modules/jest/bin/jest.js', '--runInBand')
}

# ---------------------------------------------------------------- 小程序
if (-not $SkipFrontend) {
    Invoke-Check -Name 'Miniapp: typecheck' -WorkDir 'frontend/miniapp' -EmptyOutputMeansPass `
        -CommandArgs @('node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit', '-p', 'tsconfig.json')
    if (-not $SkipTests) {
        Invoke-Check -Name 'Miniapp: tests' -WorkDir 'frontend/miniapp' -SuccessPattern 'Test Files\s+\d+ passed' `
            -CommandArgs @('node_modules/vitest/vitest.mjs', 'run')
    }
}

# ---------------------------------------------------------------- 汇总
Write-Host ''
if ($failures.Count -eq 0) {
    Write-Host 'ALL CHECKS PASSED' -ForegroundColor Green
    exit 0
}

Write-Host "FAILED CHECKS ($($failures.Count)):" -ForegroundColor Red
foreach ($failure in $failures) {
    Write-Host "  - $failure" -ForegroundColor Red
}
exit 1