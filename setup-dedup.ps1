param(
    [string]$ProxyUrl = "http://127.0.0.1:7890"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPython = Join-Path $root ".venv\Scripts\python.exe"
$scriptPath = Join-Path $root "差分去除_优化版.py"

$env:HTTP_PROXY = $ProxyUrl
$env:HTTPS_PROXY = $ProxyUrl
$env:TORCH_HOME = Join-Path $root ".models\torch"

if (-not (Test-Path -LiteralPath $venvPython)) {
    python -m venv (Join-Path $root ".venv")
}

& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r (Join-Path $root "requirements-dedup.txt")
& $venvPython $scriptPath --prepare-models

Write-Host "环境与模型准备完成：$venvPython"
