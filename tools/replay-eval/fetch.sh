#!/usr/bin/env bash
# 把 DSH 会话记录拷出来解压成 jsonl，放在 ${OUT:-/tmp/replay-eval/sessions}/<key>.jsonl
# 会话记录里有聊天内容和会话令牌，别放进仓库。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${OUT:-/tmp/replay-eval/sessions}"
mkdir -p "$OUT"
chmod 700 "$(dirname "$OUT")" "$OUT"
dc() { sg docker -c "docker compose $(printf '%q ' "$@")" < /dev/null; }
map=$(dc exec -T bridge cat /opt/qq-bridge/state/sessions.json)
echo "$map" | python3 -c '
import json, sys
d = json.load(sys.stdin); d = d.get("sessions", d)
for k, v in d.items():
    sid = v if isinstance(v, str) else v.get("sessionId", "")
    if sid: print(k, sid)
' | while read -r key sid; do
  src=$(dc exec -T dsh sh -c "ls /data/dsh/sessions/*/$sid/session.v4.jsonl.zstd 2>/dev/null | head -1" | tr -d '\r')
  [ -n "$src" ] || { echo "跳过 $key：找不到 $sid"; continue; }
  name=$(echo "$key" | tr ':' '_')
  dc exec -T dsh cat "$src" > "$OUT/$name.zst"
  node tools/replay-eval/unzstd.cjs "$OUT/$name.zst" "$OUT/$name.jsonl"
  rm -f "$OUT/$name.zst"
  echo "$key -> $OUT/$name.jsonl ($(wc -l < "$OUT/$name.jsonl") 行)"
done
# 当前的二代人格卡（bridge 处理过的版本），评测里拼系统提示用
dc exec -T bridge node -e 'const tok = require("fs").readFileSync("/opt/qq-bridge/state/console-token", "utf8").trim(); fetch("http://127.0.0.1:3100/api/socialV2/prompt?key=group:1100000001", { headers: { "x-console-token": tok } }).then((r) => r.json()).then((j) => process.stdout.write(j.role?.hint ?? ""));' > "$(dirname "$OUT")/role-card-v2.md"
echo "人格卡 -> $(dirname "$OUT")/role-card-v2.md ($(wc -c < "$(dirname "$OUT")/role-card-v2.md") 字节)"
