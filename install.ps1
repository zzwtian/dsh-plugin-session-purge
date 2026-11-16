#!/usr/bin/env pwsh
<#
.SYNOPSIS
  把本目录以本地链接方式装进 DSH profile（Windows 原生入口）。

.DESCRIPTION
  跑一遍冒烟测试，然后执行 `dsh plugin --profile <name> add "link:<本目录>"`。

  注意：desktop profile 由 Electron 桌面应用独占管理，CLI 会被拒绝
  （error: profile "desktop" is managed exclusively by the Electron
  application）。这种环境请改用应用内插件管理器，见 README「1. 装上」。

.PARAMETER ProfileName
  目标 profile，默认 desktop。

.PARAMETER Resources
  应用 resources 目录，覆盖自动探测。等价于环境变量 DSH_RESOURCES。

.PARAMETER DshCli
  dsh CLI 本体路径（可执行文件或 lib/bin.js），覆盖自动探测。等价于 DSH_CLI。

.EXAMPLE
  .\install.ps1

.EXAMPLE
  .\install.ps1 -ProfileName web

.EXAMPLE
  $env:DSH_RESOURCES = 'D:\deepseek\resources'; .\install.ps1
#>
param(
  [Parameter(Position = 0)][string]$ProfileName = 'desktop',
  [string]$Resources,
  [string]$DshCli
)

$ErrorActionPreference = 'Stop'

$PluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $PluginDir) { $PluginDir = (Get-Location).Path }

# --------------------------------------------------------------- 1. 找 dsh CLI
function Find-Dsh {
  if ($DshCli) { return $DshCli }
  if ($env:DSH_CLI) { return $env:DSH_CLI }

  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  # desktop-runtime 布局：<resources>/app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
  # macOS 布局：       <resources>/runtime/cli/bin/dsh(.exe)
  $relBin = 'app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
  $relCli = 'runtime\cli\bin\dsh.exe'

  $roots = @()
  if ($Resources) { $roots += $Resources }
  if ($env:DSH_RESOURCES) { $roots += $env:DSH_RESOURCES }
  $roots += @(
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources')
    (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness\resources')
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources')
  )

  foreach ($root in $roots) {
    if (-not $root) { continue }
    foreach ($rel in @($relBin, $relCli)) {
      $p = Join-Path $root $rel
      if (Test-Path -LiteralPath $p) { return $p }
    }
  }
  return $null
}

$DshPath = Find-Dsh
if (-not $DshPath) {
  Write-Host '找不到 dsh CLI。三种办法：' -ForegroundColor Red
  Write-Host '  1) .\install.ps1 -Resources "D:\deepseek\resources"'
  Write-Host '  2) .\install.ps1 -DshCli "C:\path\to\bin.js"'
  Write-Host '  3) 把 dsh 放到 PATH 上'
  exit 1
}

# --------------------------------------------------------------- 2. 找 node
$Node = $null
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { $Node = $nodeCmd.Source }

$isJs = $DshPath -like '*.js'
if ($isJs -and -not $Node) {
  Write-Host "dsh CLI 是 $DshPath，需要用 node 跑，但没找到 node。" -ForegroundColor Red
  exit 1
}

Write-Host "==> dsh CLI: $DshPath"

function Invoke-Dsh {
  param([string[]]$DshArgs)
  if ($isJs) { & $Node $DshPath @DshArgs } else { & $DshPath @DshArgs }
  return $LASTEXITCODE
}

# --------------------------------------------------------------- 3. 冒烟测试
Write-Host '==> 冒烟测试（先确认代码没坏）'
if ($Node) {
  Push-Location -LiteralPath $PluginDir
  try { & $Node 'test/purge.test.mjs' } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) {
    Write-Host '冒烟测试失败，已中止安装。' -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host '    没找到 node，跳过测试'
}

# --------------------------------------------------------------- 4. 安装
$link = $PluginDir.Replace('\', '/')
Write-Host ''
Write-Host "==> 安装 $link 到 profile '$ProfileName'"

$code = Invoke-Dsh @('plugin', '--profile', $ProfileName, 'add', "link:$link")
if ($code -ne 0) {
  Write-Host ''
  Write-Host "安装失败。若上面提到 profile `"$ProfileName`" is managed exclusively by the" -ForegroundColor Red
  Write-Host 'Electron application，说明该 profile 归桌面应用独占管理，CLI 改不动它。' -ForegroundColor Red
  Write-Host '改用应用内的插件管理器（Settings → 插件，或 agent 侧的 plugin_manager 工具），'
  Write-Host '执行 install_bundle，target 填：'
  Write-Host ''
  Write-Host "  link:$link"
  exit 1
}

Write-Host ''
Write-Host '==> 完成。重启 DSH 后生效（客户端半只在启动时组合）。'
Write-Host '    验证：随便挑一个会话右键 → 菜单最下方应出现「彻底删除…」'
Write-Host "    卸载： $DshPath plugin --profile $ProfileName remove dsh-plugin-session-purge"
Write-Host '           （desktop 这类 Electron 独占的 profile 用插件管理器移除 bundle）'
