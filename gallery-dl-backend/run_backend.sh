#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

if [[ -n "${PYTHON:-}" ]]; then
    python_bin="$PYTHON"
    command -v "$python_bin" >/dev/null 2>&1 || {
        printf '错误：PYTHON 指定的解释器不可用：%s\n' "$python_bin" >&2
        exit 1
    }
elif [[ -x "$script_dir/.venv/bin/python" ]]; then
    python_bin="$script_dir/.venv/bin/python"
else
    printf '错误：后端虚拟环境不存在或不可执行：%s\n' "$script_dir/.venv/bin/python" >&2
    printf '请从仓库根目录运行：./scripts/setup-linux.sh --device cpu\n' >&2
    exit 1
fi

config_path="${GDL_BACKEND_CONFIG:-$script_dir/config.json}"
expect_config=0
for argument in "$@"; do
    if [[ $expect_config -eq 1 ]]; then
        config_path="$argument"
        expect_config=0
    elif [[ "$argument" == "--config" ]]; then
        expect_config=1
    elif [[ "$argument" == --config=* ]]; then
        config_path="${argument#--config=}"
    fi
done
if [[ $expect_config -eq 1 ]]; then
    printf '错误：--config 缺少路径参数。\n' >&2
    exit 2
fi
if [[ ! -f "$config_path" ]]; then
    printf '错误：配置文件不存在：%s\n' "$config_path" >&2
    printf '请先运行 setup，或复制 config.example.json 并通过 --config 指定。\n' >&2
    exit 1
fi

exec "$python_bin" -m gdl_backend "$@"
