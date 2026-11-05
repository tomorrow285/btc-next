#!/usr/bin/env bash
# 执行器启动脚本（适合 systemd 调用）。
#
#   bash scripts/run.sh
#
# systemd 环境通常没有完整的 PATH，可用 NODE_BIN 指定绝对路径：
#   NODE_BIN=/usr/local/bin/node bash scripts/run.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"

cd "$ROOT"
exec "$NODE_BIN" --import tsx src/cli/run.ts "$@"
