#!/usr/bin/env bash
# 查按天存的日志（bridge：state/logs/，extras：/data/logs/，各留 30 天；容器重建也还在）。
#   scripts/logs.sh bridge '回复门控'            今天的
#   scripts/logs.sh bridge -d 2 '\[自洽\]'       今天和前两天的
#   scripts/logs.sh extras -D 2026-10-23 digest  某一天的
#   scripts/logs.sh bridge                       今天的最后 50 行
set -euo pipefail
cd "$(dirname "$0")/.."
if ! docker info >/dev/null 2>&1 && [ -z "${LOGS_SG:-}" ]; then
  exec sg docker -c "LOGS_SG=1 $(printf '%q ' "$0" "$@")" </dev/null
fi

svc="${1:-}"; shift || true
case "$svc" in
  bridge) dir=/opt/qq-bridge/state/logs ;;
  extras) dir=/data/logs ;;
  *) echo "用法：scripts/logs.sh bridge|extras [-d 前几天 | -D YYYY-MM-DD] [grep 模式]" >&2; exit 2 ;;
esac
days=0; date=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) days="$2"; shift 2 ;;
    -D) date="$2"; shift 2 ;;
    *) break ;;
  esac
done
files=()
if [ -n "$date" ]; then
  files+=("$dir/$svc-$date.log")
else
  for i in $(seq "$days" -1 0); do files+=("$dir/$svc-$(date -d "-$i day" +%F).log"); done
fi
if [ $# -eq 0 ]; then
  docker compose exec -T "$svc" sh -c 'cat "$@" 2>/dev/null | tail -50' sh "${files[@]}"
else
  docker compose exec -T "$svc" sh -c 'p="$1"; shift; cat "$@" 2>/dev/null | grep -- "$p" || true' sh "$1" "${files[@]}"
fi
