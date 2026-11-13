#!/bin/sh
# 备份运行期数据：七个 docker 卷 + 你的配置、人格卡和 .env。升级前一定先跑一次。
# 每周自动跑的全量也是它（scripts/backup-auto.sh weekly），每天的是 backup-auto.sh daily。
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
  # 浏览器的缓存不要（两个 profile 里将近 2G，浏览器自己会重新下，B 站登录在 Cookies / Local Storage 里，不受影响）
  # BACKUP_SKIP_ATTACHMENTS=1：dsh-home 不带会话里的图（每周自动的那份，图另外按文件增量备份，见 backup-auto.sh）
  set --
  case "$vol" in
    sandbox-browser)
      for c in 'Default/Cache' 'Default/Code Cache' 'Default/GPUCache' 'Default/Service Worker/CacheStorage' \
        'Default/Service Worker/ScriptCache' 'Default/DawnGraphiteCache' 'Default/DawnWebGPUCache' \
        GPUPersistentCache GrShaderCache ShaderCache component_crx_cache extensions_crx_cache; do
        set -- "$@" "--exclude=./*/$c"
      done ;;
    dsh-home) if [ -n "${BACKUP_SKIP_ATTACHMENTS:-}" ]; then set -- --exclude=./attachments; fi ;;
  esac
  # --numeric-owner：保留数字 uid/gid，换一台机器恢复后容器里的用户仍然对得上
  # 从容器的标准输出接过来写（不绑定挂载输出目录），OUT 可以是任意绝对路径
  # 容器开着时 tar 报“file changed as we read it”退出 1，那份照样能用；2 以上才算失败
  docker run --rm -v "${PROJECT}_${vol}:/src:ro" debian:bookworm-20260918-slim sh -c \
    'tar --numeric-owner --warning=no-file-changed -C /src "$@" -czf - .; s=$?; [ $s -le 1 ]' sh "$@" >"$OUT/${vol}.tar.gz.part"
  gzip -t "$OUT/${vol}.tar.gz.part"
  mv "$OUT/${vol}.tar.gz.part" "$OUT/${vol}.tar.gz"
done

# COPYFILE_DISABLE：macOS 的 tar 不要塞 ._* 扩展属性文件进去，换到 Linux 解压会多出一堆垃圾文件
# qq-bridge/ 是自带的源码（node_modules、state 不要）
COPYFILE_DISABLE=1 tar -czf "$OUT/config-and-roles.tar.gz" --exclude=qq-bridge/node_modules --exclude=qq-bridge/state \
  config roles qq-bridge control extras sandbox egress scripts docs docker-compose.yml $(test -f .env && echo .env)
chmod -R go-rwx "$OUT"
echo "备份完成：$OUT"
