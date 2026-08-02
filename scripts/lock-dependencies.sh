#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
backend_pyproject="$root_dir/gallery-dl-backend/pyproject.toml"
uv_version="0.12.1"
mode="check"

usage() {
    cat <<'EOF'
用法：./scripts/lock-dependencies.sh [--check | --upgrade]

  --check    按现有固定版本重新生成到临时目录并检查漂移（默认）
  --upgrade  重新解析受支持 Python/平台的最新兼容传递依赖并更新锁文件
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check) mode="check"; shift ;;
        --upgrade) mode="upgrade"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) printf '错误：未知选项：%s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
done

[[ -f "$backend_pyproject" ]] || {
    printf '错误：依赖事实来源不存在：%s\n' "$backend_pyproject" >&2
    exit 1
}

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/imageweave-lock.XXXXXX")"
cleanup() {
    rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

uv_bin="${UV:-}"
if [[ -n "$uv_bin" && ! -x "$uv_bin" ]]; then
    printf '错误：UV 指定的可执行文件不可用。\n' >&2
    exit 1
fi
if [[ -z "$uv_bin" ]] && command -v uv >/dev/null 2>&1; then
    candidate="$(command -v uv)"
    if [[ "$($candidate --version 2>/dev/null)" == "uv $uv_version"* ]]; then
        uv_bin="$candidate"
    fi
fi
if [[ -z "$uv_bin" ]]; then
    python_cmd="${PYTHON:-python3}"
    command -v "$python_cmd" >/dev/null 2>&1 || {
        printf '错误：找不到用于临时安装 uv 的 Python：%s\n' "$python_cmd" >&2
        exit 1
    }
    "$python_cmd" -m venv "$work_dir/uv-venv"
    "$work_dir/uv-venv/bin/python" -m pip install \
        --disable-pip-version-check --no-input "uv==$uv_version"
    uv_bin="$work_dir/uv-venv/bin/uv"
fi
actual_uv="$($uv_bin --version)"
[[ "$actual_uv" == "uv $uv_version"* ]] || {
    printf '错误：锁文件要求 uv %s，实际为 %s。\n' "$uv_version" "$actual_uv" >&2
    exit 1
}

compile_common=(
    --universal
    --python-version 3.11
    --generate-hashes
    --emit-index-url
    --emit-index-annotation
    --custom-compile-command './scripts/lock-dependencies.sh --upgrade'
)
[[ "$mode" == "upgrade" ]] && compile_common+=(--upgrade)

insert_torch_index() {
    local path="$1"
    local backend="$2"
    "${PYTHON:-python3}" - "$path" "$backend" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
backend = sys.argv[2]
url = f"https://download.pytorch.org/whl/{backend}"
text = path.read_text(encoding="utf-8")
line = f"--extra-index-url {url}\n"
if line not in text:
    marker = "--index-url https://pypi.org/simple\n"
    if marker not in text:
        raise SystemExit("生成锁缺少 PyPI index 行")
    text = text.replace(marker, marker + line, 1)
path.write_text(text, encoding="utf-8")
PY
}

compile_lock() {
    local name="$1"
    local output="$2"
    local torch_backend="$3"
    shift 3
    local temporary="$work_dir/$name.txt"
    if [[ "$mode" == "check" ]]; then
        [[ -f "$output" ]] || {
            printf '错误：锁文件缺失：%s\n' "$output" >&2
            return 1
        }
        cp -- "$output" "$temporary"
    fi

    local command=("$uv_bin" pip compile "$@" "${compile_common[@]}" -o "$temporary")
    if [[ -n "$torch_backend" ]]; then
        command+=(--torch-backend "$torch_backend")
    fi
    (cd "$root_dir" && "${command[@]}") >/dev/null
    if [[ -n "$torch_backend" ]]; then
        insert_torch_index "$temporary" "$torch_backend"
    fi

    if [[ "$mode" == "check" ]]; then
        if ! cmp -s -- "$output" "$temporary"; then
            printf '依赖锁漂移：%s\n请运行：./scripts/lock-dependencies.sh --upgrade\n' \
                "${output#"$root_dir/"}" >&2
            diff -u -- "$output" "$temporary" || true
            return 1
        fi
    else
        cp -- "$temporary" "$output"
        chmod 0644 "$output"
        printf '已更新：%s\n' "${output#"$root_dir/"}"
    fi
}

compile_lock \
    backend \
    "$root_dir/gallery-dl-backend/requirements.txt" \
    "" \
    "$backend_pyproject"
compile_lock \
    dedup-common \
    "$root_dir/requirements-dedup-common.txt" \
    "" \
    --group "$backend_pyproject:dedup-common"
compile_lock \
    dedup-cpu \
    "$root_dir/requirements-dedup-cpu.txt" \
    cpu \
    --group "$backend_pyproject:dedup-cpu"
compile_lock \
    dedup-cuda \
    "$root_dir/requirements-dedup-cuda.txt" \
    cu128 \
    --group "$backend_pyproject:dedup-cuda"

if grep -Eiq '^[[:space:]]*(nvidia-|triton([=[:space:]]|$)|pytorch-triton|cuda[-_])' \
    "$root_dir/requirements-dedup-cpu.txt"; then
    printf '错误：CPU 锁中出现 NVIDIA/CUDA/Triton 包。\n' >&2
    exit 1
fi
if grep -Eiq '^[[:space:]]*opencv-python([=[:space:]]|$)' \
    "$root_dir/requirements-dedup-cpu.txt"; then
    printf '错误：CPU 锁中出现非 headless OpenCV。\n' >&2
    exit 1
fi

printf '依赖锁%s完成：Python 3.11–3.14，CPU/CUDA 路径独立。\n' \
    "$([[ "$mode" == "check" ]] && printf '检查' || printf '更新')"
