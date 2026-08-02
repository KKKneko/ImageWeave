#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"

"$script_dir/doctor.sh"
exec "$root_dir/gallery-dl-backend/run_backend.sh" "$@"
