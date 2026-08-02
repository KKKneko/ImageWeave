param(
    [ValidateSet("cpu", "cuda")]
    [string]$Device = "cuda",
    [string]$ProxyUrl = "",
    [switch]$NoProxy
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPython = Join-Path $root ".venv\Scripts\python.exe"
$scriptPath = Join-Path $root "dedup_core.py"
$deviceName = $Device.ToLowerInvariant()
$lockName = if ($deviceName -eq "cpu") {
    "requirements-dedup-cpu.txt"
} else {
    "requirements-dedup-cuda.txt"
}
$lockPath = Join-Path $root $lockName

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

# CPU/CUDA 锁都包含公共依赖的完整传递闭包；普通安装不自动升级任意最新版。
& $venvPython -m pip uninstall -y opencv-python opencv-contrib-python opencv-contrib-python-headless
if ($LASTEXITCODE -ne 0) {
    throw "清理冲突 OpenCV wheel 失败。"
}

if ($deviceName -eq "cpu") {
    # 从已有 CUDA 环境切换到 CPU 时，先移除 PyTorch 与可能残留的加速运行库。
    $packageProbe = @'
import importlib.metadata as metadata
distributions = {
    dist.metadata["Name"].lower(): (dist.metadata["Name"], dist.version)
    for dist in metadata.distributions()
    if dist.metadata.get("Name")
}
expected = {"torch": "2.11.0+cpu", "torchvision": "0.26.0+cpu"}
for lower, (name, version) in sorted(distributions.items()):
    if lower in expected and version != expected[lower]:
        print(name)
    elif lower.startswith("nvidia-") or lower in {
        "triton", "pytorch-triton", "cuda-bindings", "cuda-pathfinder", "cuda-toolkit",
    }:
        print(name)
'@
    $cudaPackages = @(& $venvPython -c $packageProbe)
    if ($LASTEXITCODE -ne 0) {
        throw "检查已有 CUDA 依赖失败。"
    }
    if ($cudaPackages.Count -gt 0) {
        & $venvPython -m pip uninstall -y $cudaPackages
        if ($LASTEXITCODE -ne 0) {
            throw "清理已有 CUDA 依赖失败。"
        }
    }
}

& $venvPython -m pip install --disable-pip-version-check --no-input --require-hashes --only-binary=:all: -r $lockPath
if ($LASTEXITCODE -ne 0) {
    throw "安装 $deviceName 锁定依赖失败。"
}

if ($deviceName -eq "cpu") {
    $environmentCheck = @'
import importlib.metadata as metadata
import torch
import torchvision
names = {dist.metadata["Name"].lower() for dist in metadata.distributions() if dist.metadata.get("Name")}
forbidden = sorted(
    name for name in names
    if name.startswith("nvidia-")
    or name in {"triton", "pytorch-triton", "cuda-bindings", "cuda-pathfinder", "cuda-toolkit"}
)
if torch.__version__ != "2.11.0+cpu":
    raise SystemExit(f"需要 torch 2.11.0+cpu，实际为 {torch.__version__}")
if torchvision.__version__ != "0.26.0+cpu":
    raise SystemExit(f"需要 torchvision 0.26.0+cpu，实际为 {torchvision.__version__}")
if torch.cuda.is_available():
    raise SystemExit("CPU 环境中 torch.cuda.is_available() 意外为 true")
if forbidden:
    raise SystemExit("CPU 环境残留 CUDA/NVIDIA/Triton 包：" + ", ".join(forbidden))
if "opencv-python-headless" not in names:
    raise SystemExit("CPU 环境缺少 opencv-python-headless")
print(f"CPU 环境校验通过：torch={torch.__version__}, cuda=false")
'@
} else {
    $environmentCheck = @'
import torch
import torchvision
if torch.__version__ != "2.11.0+cu128":
    raise SystemExit(f"需要 torch 2.11.0+cu128，实际为 {torch.__version__}")
if torchvision.__version__ != "0.26.0+cu128":
    raise SystemExit(f"需要 torchvision 0.26.0+cu128，实际为 {torchvision.__version__}")
if not torch.cuda.is_available():
    raise SystemExit("CUDA 依赖已安装，但 PyTorch 未检测到可用 NVIDIA GPU/驱动")
print(f"CUDA 环境校验通过：torch={torch.__version__}, cuda={torch.version.cuda}")
'@
}
& $venvPython -c $environmentCheck
if ($LASTEXITCODE -ne 0) {
    throw "$deviceName 环境校验失败。"
}

& $venvPython $scriptPath --prepare-models --device $deviceName
if ($LASTEXITCODE -ne 0) {
    throw "准备 SSCD/DINOv2 模型失败。"
}

Write-Host "环境与模型准备完成：device=$deviceName, python=$venvPython"
