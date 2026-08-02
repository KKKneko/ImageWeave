#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
backend_dir="$root_dir/gallery-dl-backend"
python_bin="$backend_dir/.venv/bin/python"
port="${IMAGEWEAVE_SMOKE_PORT:-18787}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/imageweave-service-smoke.XXXXXX")"
server_pid=""

cleanup() {
    if [[ -n "$server_pid" ]]; then
        kill "$server_pid" >/dev/null 2>&1 || true
        wait "$server_pid" >/dev/null 2>&1 || true
    fi
    rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

[[ -x "$python_bin" ]] || {
    printf '错误：后端 venv 不可用，请先运行 setup-linux.sh。\n' >&2
    exit 1
}

make_config() {
    local mode="$1"
    local destination="$work_dir/config-$mode.json"
    "$python_bin" - "$backend_dir/config.example.json" "$destination" "$work_dir/$mode" "$port" "$mode" "$root_dir" <<'PY'
import json
import os
import sys
from pathlib import Path

example, destination, root, port, mode, workspace = sys.argv[1:]
workspace = Path(workspace).absolute()
root = Path(root).absolute()
data = json.loads(Path(example).read_text(encoding="utf-8"))
data["runtime_dir"] = str(root / "runtime")
data["database_path"] = str(root / "runtime" / "backend.sqlite3")
data["default_output_root"] = str(root / "runtime" / "downloads")
data["allowed_output_roots"] = [str(root / "runtime" / "downloads")]
data["allowed_config_roots"] = [str(root / "credentials")]
data["allowed_cookie_roots"] = [str(root / "credentials")]
data["server"]["port"] = int(port)
data["gallery"]["repo_path"] = str(workspace / "gallery-dl-codeberg")
data["gallery"]["cache_file"] = str(root / "credentials" / "managed" / "cache.sqlite3")
data["gallery"]["python_executable"] = sys.executable
data["proxy"]["enabled"] = False
data["proxy"]["auto_start"] = False
data["dedup"]["enabled"] = mode == "missing-models"
data["dedup"]["device"] = "cpu"
data["dedup"]["python_executable"] = str(workspace / ".venv" / "bin" / "python")
data["dedup"]["worker_script"] = str(workspace / "dedup_review_worker.py")
data["dedup"]["core_script"] = str(workspace / "dedup_core.py")
data["dedup"]["model_dir"] = str(root / "missing-models")
path = Path(destination)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(data, handle, ensure_ascii=False)
PY
    printf '%s\n' "$destination"
}

wait_for_health() {
    local deadline=$((SECONDS + 30))
    while (( SECONDS < deadline )); do
        if "$python_bin" - "$port" <<'PY' >/dev/null 2>&1
import json
import sys
import urllib.request
with urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/healthz", timeout=2) as response:
    assert response.status == 200
    assert json.load(response)["ok"] is True
PY
        then
            return 0
        fi
        sleep 0.25
    done
    printf '错误：服务未在 30 秒内通过 /healthz。\n' >&2
    return 1
}

run_server() {
    local config="$1"
    (
        cd "$backend_dir"
        exec "$python_bin" -m gdl_backend --config "$config"
    ) >"$work_dir/server.log" 2>&1 &
    server_pid=$!
    wait_for_health
}

stop_server() {
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
    server_pid=""
}

disabled_config="$(make_config disabled)"
run_server "$disabled_config"
"$python_bin" - "$port" <<'PY'
import json
import sys
import urllib.request
with urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/readyz", timeout=5) as response:
    body = json.load(response)
    assert response.status == 200 and body["ready"] is True
    assert body["components"]["dedup"]["status"] == "disabled"
PY
stop_server

missing_config="$(make_config missing-models)"
run_server "$missing_config"
"$python_bin" - "$port" <<'PY'
import json
import sys
import urllib.error
import urllib.request
try:
    urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/readyz", timeout=10)
except urllib.error.HTTPError as exc:
    body = json.load(exc)
    assert exc.code == 503 and body["ready"] is False
    assert body["components"]["dedup"]["status"] == "error"
else:
    raise AssertionError("模型缺失时 /readyz 不应返回 200")
PY
stop_server

printf 'Linux 服务 smoke 通过：healthz=200，禁用去重 readyz=200，缺模型 readyz=503。\n'
