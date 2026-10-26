#!/bin/sh
# 从 backups/<时间>/ 恢复七个 docker 卷（会覆盖卷里的现有数据）。配置和人格卡需要你自己解压 config-and-roles.tar.gz。
# 用法：docker compose down && scripts/restore.sh backups/20261021-120000 [-y]
set -eu

cd "$(dirname "$0")/.."
SRC="${1:?用法：scripts/restore.sh backups/<时间> [-y]}"
YES="${2:-}"
# 和 docker-compose.yml 顶部的 name: 一致
PROJECT="${COMPOSE_PROJECT_NAME:-qqbot_agent}"
# SnowLuma 的三个卷里有 QQ 登录态，恢复后不用重新扫码
VOLUMES="dsh-home bridge-state qq-gateway-data qq-client-config qq-client-data sandbox-browser extras-state"

for vol in $VOLUMES; do
  test -f "$SRC/${vol}.tar.gz" || { echo "缺少 $SRC/${vol}.tar.gz" >&2; exit 1; }
done

if [ "$YES" != "-y" ]; then
  printf '将用 %s 覆盖 %s 下的卷：%s，继续？[y/N] ' "$SRC" "$PROJECT" "$VOLUMES"
  read -r answer
  [ "$answer" = "y" ] || { echo "已取消"; exit 1; }
fi

for vol in $VOLUMES; do
  # 带上 compose 的标签，之后 docker compose up 会把它当成自己的卷，不会报“不是本项目创建的”
  docker volume create \
    --label "com.docker.compose.project=${PROJECT}" \
    --label "com.docker.compose.volume=${vol}" \
    "${PROJECT}_${vol}" >/dev/null
  docker run --rm \
    -v "${PROJECT}_${vol}:/dst" \
    -v "$(pwd)/$SRC:/src:ro" \
    debian:bookworm-20260918-slim \
    sh -c "find /dst -mindepth 1 -delete && tar --numeric-owner -C /dst -xzf /src/${vol}.tar.gz"
done
echo "卷已恢复。需要的话解压 $SRC/config-and-roles.tar.gz，然后 docker compose up -d"
