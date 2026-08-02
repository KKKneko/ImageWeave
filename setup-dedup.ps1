param(
    [string]$ProxyUrl = "",
    [switch]$NoProxy
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPython = Join-Path $root ".venv\Scripts\python.exe"
$scriptPath = Join-Path $root "dedup_core.py"

if ($NoProxy) {
    Remove-Item Env:HTTP_PROXY, Env:HTTPS_PROXY, Env:http_proxy, Env:https_proxy -ErrorAction SilentlyContinue
} elseif ($ProxyUrl) {
    $env:HTTP_PROXY = $ProxyUrl
    $env:HTTPS_PROXY = $ProxyUrl
    $env:http_proxy = $ProxyUrl
    $env:https_proxy = $ProxyUrl
}
$env:TORCH_HOME = Join-Path $root ".models\torch"

if (-not (Test-Path -LiteralPath $venvPython)) {
    python -m venv (Join-Path $root ".venv")
}

& $venvPython -m pip install --upgrade pip
# 公共依赖与设备 wheel 分开，避免 Linux CPU 安装误用此 CUDA 清单。
& $venvPython -m pip uninstall -y opencv-python opencv-contrib-python opencv-contrib-python-headless
& $venvPython -m pip install -r (Join-Path $root "requirements-dedup-common.txt")
& $venvPython -m pip install -r (Join-Path $root "requirements-dedup-cuda.txt")
& $venvPython $scriptPath --prepare-models

Write-Host "环境与模型准备完成：$venvPython"
