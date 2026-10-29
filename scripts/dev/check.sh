#!/usr/bin/env bash
# Local CI equivalent: typecheck + tests for all workspaces, then analytics pytest.
set -euo pipefail
cd "$(dirname "$0")/../.."
pnpm -r typecheck
pnpm -r test   # API vitest config runs files serially (fileParallelism: false); no extra flag needed
PY="analytics/.venv/bin/python"
[ -x "$PY" ] || PY="python3"
"$PY" -m pytest analytics/tests -q
