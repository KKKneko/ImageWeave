#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
backend_dir="$root_dir/gallery-dl-backend"
python_bin="$backend_dir/.venv/bin/python"
config_path="${GDL_BACKEND_CONFIG:-$backend_dir/config.json}"

if [[ "$(uname -s)" != "Linux" ]]; then
    printf '错误：doctor.sh 仅用于 Linux 部署。\n' >&2
    exit 1
fi
if [[ ! -x "$python_bin" ]]; then
    printf '错误：后端虚拟环境不可用：%s\n请先运行：./scripts/setup-linux.sh --device cpu\n' "$python_bin" >&2
    exit 1
fi
if [[ ! -f "$config_path" ]]; then
    printf '错误：配置文件不存在：%s\n请先运行 setup，或从 gallery-dl-backend/config.example.json 创建。\n' "$config_path" >&2
    exit 1
fi

export PYTHONPATH="$backend_dir${PYTHONPATH:+:$PYTHONPATH}"
exec "$python_bin" -m gdl_backend.diagnostics --config "$config_path"
