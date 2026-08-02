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

python -c "import sys; raise SystemExit(0 if (3, 11) <= sys.version_info[:2] < (3, 15) else 1)"
if ($LASTEXITCODE -ne 0) {
    throw "ImageWeave 支持 Python 3.11–3.14。"
}
if (-not (Test-Path -LiteralPath $venvPython)) {
    python -m venv (Join-Path $root ".venv")
}

# CUDA 锁已包含公共依赖的完整传递闭包；普通安装不自动升级任意最新版。
& $venvPython -m pip uninstall -y opencv-python opencv-contrib-python opencv-contrib-python-headless
if ($LASTEXITCODE -ne 0) {
    throw "清理冲突 OpenCV wheel 失败。"
}
& $venvPython -m pip install --disable-pip-version-check --no-input --require-hashes --only-binary=:all: -r (Join-Path $root "requirements-dedup-cuda.txt")
if ($LASTEXITCODE -ne 0) {
    throw "安装 CUDA 锁定依赖失败。"
}
& $venvPython $scriptPath --prepare-models
if ($LASTEXITCODE -ne 0) {
    throw "准备 SSCD/DINOv2 模型失败。"
}

Write-Host "环境与模型准备完成：$venvPython"
