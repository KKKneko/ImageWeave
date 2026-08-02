param(
    [string]$Config = (Join-Path $PSScriptRoot "config.json"),
    [string]$HostOverride = "",
    [int]$PortOverride = 0
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    throw "后端虚拟环境不存在：$venvPython。请先按根 README 安装 Windows 后端依赖。"
}

$arguments = @("-m", "gdl_backend", "--config", $Config)
if ($HostOverride) {
    $arguments += @("--host", $HostOverride)
}
if ($PortOverride -gt 0) {
    $arguments += @("--port", [string]$PortOverride)
}

& $venvPython @arguments
exit $LASTEXITCODE
