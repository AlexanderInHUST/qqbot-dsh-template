#!/bin/sh
# 备份运行期数据：七个 docker 卷 + 你的配置和人格卡。升级前一定先跑一次。
# 用法：scripts/backup.sh            → 生成 backups/<时间>/
# 备份里有模型 API Key、OneBot token 和 QQ 登录态，注意保管，不要上传到公开的地方。
# SnowLuma 在运行时备份它的卷可能拿到写了一半的数据，最好先 docker compose stop snowluma。
set -eu

cd "$(dirname "$0")/.."
# 和 docker-compose.yml 顶部的 name: 一致
PROJECT="${COMPOSE_PROJECT_NAME:-qqbot_agent}"
# SnowLuma 的三个卷里有 QQ 登录态，恢复后不用重新扫码
VOLUMES="dsh-home bridge-state qq-gateway-data qq-client-config qq-client-data sandbox-browser extras-state"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${1:-backups/$STAMP}"
mkdir -p "$OUT"

for vol in $VOLUMES; do
  docker volume inspect "${PROJECT}_${vol}" >/dev/null
  # --numeric-owner：保留数字 uid/gid，换一台机器恢复后容器里的用户仍然对得上
  docker run --rm \
    -v "${PROJECT}_${vol}:/src:ro" \
    -v "$(pwd)/$OUT:/dst" \
    debian:bookworm-20260918-slim \
    sh -c "tar --numeric-owner -C /src -czf '/dst/${vol}.tar.gz' . && chown $(id -u):$(id -g) '/dst/${vol}.tar.gz' && chmod 600 '/dst/${vol}.tar.gz'"
done
# 上面的包是容器里的 root 写的：在容器里就改回当前用户、只自己能读（Linux 上外面的 chmod 改不动 root 的文件）

# COPYFILE_DISABLE：macOS 的 tar 不要塞 ._* 扩展属性文件进去，换到 Linux 解压会多出一堆垃圾文件
# qq-bridge/ 是自带的源码（node_modules、state 不要）
COPYFILE_DISABLE=1 tar -czf "$OUT/config-and-roles.tar.gz" --exclude=qq-bridge/node_modules --exclude=qq-bridge/state \
  config roles qq-bridge control extras sandbox egress scripts docs docker-compose.yml
chmod -R go-rwx "$OUT"
echo "备份完成：$OUT"
