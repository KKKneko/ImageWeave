#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
backend_dir="$root_dir/gallery-dl-backend"
backend_venv="$backend_dir/.venv"
dedup_venv="$root_dir/.venv"
model_dir="$root_dir/.models"
device="cpu"
python_cmd="${PYTHON:-python3}"
proxy_mode="environment"
proxy_url=""
skip_models=0
skip_mihomo=0
skip_submodule=0
skip_backend_deps=0
skip_dedup_deps=0

usage() {
    cat <<'EOF'
用法：./scripts/setup-linux.sh [选项]

  --device cpu|cuda       去重设备，Linux 无 GPU 部署使用 cpu（默认）
  --python PATH           创建两个 venv 所用的 Python（默认 python3 或 $PYTHON）
  --proxy URL             本次 git/pip/Mihomo/模型下载使用的 HTTP(S) 代理
  --no-proxy              明确关闭本次安装的全部代理环境变量
  --skip-models           跳过 SSCD/DINOv2 下载与校验
  --skip-mihomo           跳过 Mihomo 安装
  --skip-submodule        跳过 git submodule 初始化
  --skip-backend-deps     跳过后端依赖安装（venv 仍会检查/创建）
  --skip-dedup-deps       跳过去重依赖安装（venv 仍会检查/创建）
  -h, --help              显示帮助
EOF
}

fail_missing() {
    local name="$1"
    printf '错误：缺少系统依赖：%s\n' "$name" >&2
    printf 'Debian/Ubuntu：sudo apt install python3 python3-venv git curl ca-certificates gzip coreutils\n' >&2
    printf 'Arch Linux：sudo pacman -S python git curl ca-certificates gzip coreutils\n' >&2
    printf '安装器不会自动运行 sudo。\n' >&2
    exit 1
}

proxy_description() {
    case "$proxy_mode" in
        explicit) printf '显式 --proxy（地址已隐藏）' ;;
        disabled) printf '已明确关闭' ;;
        environment)
            if [[ -n "${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}" ]]; then
                printf '继承环境变量（地址已隐藏）'
            else
                printf '环境未设置，直连'
            fi
            ;;
    esac
}

stage_failed() {
    local stage="$1"
    printf '\n错误：%s 阶段失败。\n' "$stage" >&2
    printf '安装下载代理：%s\n' "$(proxy_description)" >&2
    printf '模型缓存目录：%s\n' "$model_dir" >&2
    printf '修复网络或代理后，从仓库根目录重试同一条 setup-linux.sh 命令；已完成步骤会复用。\n' >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --device)
            [[ $# -ge 2 ]] || { usage >&2; exit 2; }
            device="$2"
            shift 2
            ;;
        --python)
            [[ $# -ge 2 ]] || { usage >&2; exit 2; }
            python_cmd="$2"
            shift 2
            ;;
        --proxy)
            [[ $# -ge 2 && -n "$2" ]] || { usage >&2; exit 2; }
            proxy_mode="explicit"
            proxy_url="$2"
            shift 2
            ;;
        --no-proxy)
            proxy_mode="disabled"
            shift
            ;;
        --skip-models) skip_models=1; shift ;;
        --skip-mihomo) skip_mihomo=1; shift ;;
        --skip-submodule) skip_submodule=1; shift ;;
        --skip-backend-deps) skip_backend_deps=1; shift ;;
        --skip-dedup-deps) skip_dedup_deps=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) printf '错误：未知选项：%s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
done

[[ "$device" == "cpu" || "$device" == "cuda" ]] || {
    printf '错误：--device 只能是 cpu 或 cuda。\n' >&2
    exit 2
}
[[ "$(uname -s)" == "Linux" ]] || {
    printf '错误：setup-linux.sh 仅支持 Linux。\n' >&2
    exit 1
}

for command_name in git gzip chmod mkdir cp; do
    command -v "$command_name" >/dev/null 2>&1 || fail_missing "$command_name"
done
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    fail_missing "curl 或 wget"
fi
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    fail_missing "sha256sum 或 shasum"
fi
command -v "$python_cmd" >/dev/null 2>&1 || fail_missing "$python_cmd"

python_version="$($python_cmd -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')" || fail_missing "$python_cmd"
"$python_cmd" - <<'PY' || {
import sys
if sys.version_info < (3, 10):
    raise SystemExit(1)
PY
    printf '错误：需要 Python >= 3.10，当前为 %s。\n' "$python_version" >&2
    exit 1
}
"$python_cmd" -m venv --help >/dev/null 2>&1 || fail_missing "Python venv 模块"

case "$proxy_mode" in
    explicit)
        export HTTP_PROXY="$proxy_url" HTTPS_PROXY="$proxy_url"
        export http_proxy="$proxy_url" https_proxy="$proxy_url"
        export NO_PROXY="${NO_PROXY:-127.0.0.1,localhost}"
        export no_proxy="${no_proxy:-$NO_PROXY}"
        ;;
    disabled)
        unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
        export NO_PROXY="*" no_proxy="*"
        ;;
esac

printf 'ImageWeave Linux 安装：device=%s，Python=%s，下载代理=%s\n' \
    "$device" "$python_version" "$(proxy_description)"

if [[ $skip_submodule -eq 0 ]]; then
    git -C "$root_dir" submodule update --init --recursive || stage_failed "submodule 初始化"
else
    printf '跳过 submodule 初始化。\n'
fi
[[ -f "$root_dir/gallery-dl-codeberg/gallery_dl/__init__.py" ]] || {
    printf '错误：gallery-dl submodule 不完整；请移除 --skip-submodule 后重试。\n' >&2
    exit 1
}

for venv_path in "$backend_venv" "$dedup_venv"; do
    if [[ ! -x "$venv_path/bin/python" ]]; then
        printf '创建虚拟环境：%s\n' "$venv_path"
        "$python_cmd" -m venv "$venv_path" || stage_failed "venv 创建"
    else
        printf '复用虚拟环境：%s\n' "$venv_path"
    fi
done

backend_python="$backend_venv/bin/python"
dedup_python="$dedup_venv/bin/python"

if [[ $skip_backend_deps -eq 0 ]]; then
    "$backend_python" -m pip install --upgrade pip || stage_failed "后端 pip 更新"
    "$backend_python" -m pip install -r "$backend_dir/requirements.txt" || stage_failed "后端依赖安装"
else
    printf '跳过后端依赖安装。\n'
fi

if [[ $skip_dedup_deps -eq 0 ]]; then
    "$dedup_python" -m pip install --upgrade pip || stage_failed "去重 pip 更新"
    # Linux 服务器只保留 headless OpenCV，防止 GUI 与 headless wheel 同时提供 cv2。
    "$dedup_python" -m pip uninstall -y opencv-python opencv-contrib-python opencv-contrib-python-headless >/dev/null 2>&1 || true
    "$dedup_python" -m pip install -r "$root_dir/requirements-dedup-common.txt" || stage_failed "去重公共依赖安装"

    if [[ "$device" == "cpu" ]]; then
        cpu_clean="$($dedup_python - <<'PY'
import importlib.metadata as metadata
try:
    import torch
    import torchvision
    versions_ok = torch.__version__ == "2.11.0+cpu" and torchvision.__version__ == "0.26.0+cpu"
except Exception:
    versions_ok = False
names = {dist.metadata["Name"].lower() for dist in metadata.distributions() if dist.metadata.get("Name")}
print("1" if versions_ok and not any(name.startswith("nvidia-") for name in names) else "0")
PY
)"
        if [[ "$cpu_clean" != "1" ]]; then
            mapfile -t cuda_packages < <("$dedup_python" - <<'PY'
import importlib.metadata as metadata
names = sorted({dist.metadata["Name"] for dist in metadata.distributions() if dist.metadata.get("Name")})
for name in names:
    if name.lower().startswith("nvidia-") or name.lower() in {"torch", "torchvision", "triton"}:
        print(name)
PY
)
            if [[ ${#cuda_packages[@]} -gt 0 ]]; then
                "$dedup_python" -m pip uninstall -y "${cuda_packages[@]}" || stage_failed "CUDA 依赖清理"
            fi
        fi
        "$dedup_python" -m pip install -r "$root_dir/requirements-dedup-cpu.txt" || stage_failed "CPU PyTorch 安装"
    else
        "$dedup_python" -m pip install -r "$root_dir/requirements-dedup-cuda.txt" || stage_failed "CUDA PyTorch 安装"
    fi
else
    printf '跳过去重依赖安装。\n'
fi

if [[ "$device" == "cpu" ]]; then
    "$dedup_python" - <<'PY' || stage_failed "CPU 环境校验"
import importlib.metadata as metadata
import torch
import torchvision
names = sorted({dist.metadata["Name"].lower() for dist in metadata.distributions() if dist.metadata.get("Name")})
forbidden = [name for name in names if name.startswith("nvidia-")]
if torch.__version__ != "2.11.0+cpu":
    raise SystemExit(f"需要 torch 2.11.0+cpu，实际为 {torch.__version__}")
if torchvision.__version__ != "0.26.0+cpu":
    raise SystemExit(f"需要 torchvision 0.26.0+cpu，实际为 {torchvision.__version__}")
if torch.cuda.is_available():
    raise SystemExit("CPU 安装中 torch.cuda.is_available() 意外为 true")
if forbidden:
    raise SystemExit("CPU 安装残留 NVIDIA 包：" + ", ".join(forbidden))
print(f"CPU PyTorch 校验通过：torch={torch.__version__}, torchvision={torchvision.__version__}, cuda=false")
PY
fi

mkdir -p \
    "$backend_dir/runtime" \
    "$backend_dir/runtime/downloads" \
    "$backend_dir/runtime/logs" \
    "$backend_dir/runtime/proxy" \
    "$backend_dir/credentials" \
    "$backend_dir/credentials/managed" \
    "$model_dir"
chmod 0700 \
    "$backend_dir/runtime" \
    "$backend_dir/runtime/downloads" \
    "$backend_dir/runtime/logs" \
    "$backend_dir/runtime/proxy" \
    "$backend_dir/credentials" \
    "$backend_dir/credentials/managed" \
    "$model_dir"

if [[ $skip_mihomo -eq 0 ]]; then
    mihomo_args=()
    [[ "$proxy_mode" == "explicit" ]] && mihomo_args+=(--proxy "$proxy_url")
    [[ "$proxy_mode" == "disabled" ]] && mihomo_args+=(--no-proxy)
    "$backend_dir/scripts/install_mihomo.sh" "${mihomo_args[@]}" || stage_failed "Mihomo 下载/校验"
else
    printf '跳过 Mihomo 安装。\n'
fi

config_path="$backend_dir/config.json"
if [[ ! -e "$config_path" ]]; then
    "$backend_python" - "$backend_dir/config.example.json" "$config_path" "$backend_python" "$dedup_python" "$device" <<'PY' || stage_failed "配置生成"
import json
import os
import sys
from pathlib import Path

example, destination, backend_python, dedup_python, device = sys.argv[1:]
data = json.loads(Path(example).read_text(encoding="utf-8"))
data["gallery"]["python_executable"] = os.path.abspath(backend_python)
# 安装下载代理与项目抓取代理池不同；没有节点源时新配置默认禁用抓取代理池。
data["proxy"]["enabled"] = False
data["proxy"]["auto_start"] = False
data["proxy"]["transport_core_binary"] = "bin/proxy-core"
data["dedup"]["enabled"] = True
data["dedup"]["python_executable"] = os.path.abspath(dedup_python)
data["dedup"]["worker_script"] = "../dedup_review_worker.py"
data["dedup"]["core_script"] = "../dedup_core.py"
data["dedup"]["model_dir"] = "../.models"
data["dedup"]["device"] = device
path = Path(destination)
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
fd = os.open(path, flags, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(data, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
    printf '已创建配置：%s（项目抓取代理池默认禁用，未写入安装代理）\n' "$config_path"
else
    printf '保留已有配置，不覆盖：%s\n' "$config_path"
fi
chmod 0600 "$config_path"

if [[ $skip_models -eq 0 ]]; then
    export TORCH_HOME="$model_dir/torch"
    "$dedup_python" "$root_dir/dedup_core.py" --prepare-models \
        --model-dir "$model_dir" --device "$device" || stage_failed "SSCD/DINOv2 模型下载与校验"
else
    printf '跳过模型下载；启用去重的 readyz 会保持 not ready，完整重跑时移除 --skip-models。\n'
fi

printf '\n安装步骤完成。运行快速诊断：\n  ./scripts/doctor.sh\n启动服务：\n  ./scripts/run.sh\n'
