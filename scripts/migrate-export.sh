#!/bin/sh
# 在旧机器上打迁移包：停掉整套服务，把七个卷、.env、config/、roles/ 打成一个 tar。
# 用法：scripts/migrate-export.sh       → 生成 qqbot-migrate-<时间>.tar（权限 600）
# 迁移包里有模型 API Key、OneBot token、QQ 和 B 站的登录态，只用 U 盘 / scp 之类的私下渠道拷贝。
# 导出后不要在旧机器上再 docker compose up：同一个 QQ 号在两台机器同时在线，容易触发风控或被踢下线。
set -eu

cd "$(dirname "$0")/.."
test -f .env || { echo "没有 .env，无法导出" >&2; exit 1; }
test -f config/qq-bridge/config.json || { echo "没有 config/qq-bridge/config.json，无法导出" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="backups/migrate-$STAMP"
OUT="qqbot-migrate-$STAMP.tar"

echo "停止所有服务（卷里的数据需要静止才能完整备份）…"
docker compose stop

scripts/backup.sh "$WORK"
cp .env "$WORK/dot-env"
# 记一下来源，导入时打印出来核对
{
  echo "exported_at=$STAMP"
  echo "source_host=$(hostname)"
  echo "source_arch=$(uname -m)"
  echo "compose_project=${COMPOSE_PROJECT_NAME:-qqbot_agent}"
} > "$WORK/MANIFEST"

umask 077
tar -C "$WORK" -cf "$OUT" .
rm -rf "$WORK"
echo
echo "迁移包：$(pwd)/${OUT}（$(du -h "$OUT" | cut -f1)）"
echo "服务已停止，导出后不要在这台机器上再启动它们。"
