#!/bin/sh
# 从备份目录恢复 docker 卷（会覆盖卷里的现有数据）。配置和人格卡需要你自己解压 config-and-roles.tar.gz。
# 用法：docker compose down && scripts/restore.sh <备份目录> [-y]
#   全量（scripts/backup.sh）：恢复七个卷。
#   每周自动的那份（KIND 写着 weekly）：也是七个卷，但不带会话里的图（dsh-home/attachments），
#     图从 ATTACHMENTS=<目录>（默认 backups/auto/附件，backup-auto.sh 每天增量拷的）补回去，已经有的不动。
#     本机那份也没了就先拉网盘上的：rclone copy remote:鱼妹备份/附件 /tmp/附件，再 ATTACHMENTS=/tmp/附件。
#     网盘上有几张叫 <sha256>.dup（原名被传坏的半截文件占着），拷回去时自动改回原名。
#   每天的（scripts/backup-auto.sh daily，目录里有 KIND 文件写着 daily）：只恢复她自己的数据
#     bridge-state、extras-state、dsh-home，dsh-home 里的 attachments/、cache/ 不动（每天的不带会话里的图）。
#     换机器或卷全没了：先恢复最近的每周全量，再恢复它之后最近的每天那份。
# 备份目录可以是相对仓库的 backups/…，也可以是绝对路径。网盘上的先拉下来：rclone copy remote:鱼妹备份/每天/<时间> /tmp/<时间>
set -eu

cd "$(dirname "$0")/.."
SRC="${1:?用法：scripts/restore.sh <备份目录> [-y]}"
YES="${2:-}"
# 和 docker-compose.yml 顶部的 name: 一致
PROJECT="${COMPOSE_PROJECT_NAME:-qqbot_agent}"
KIND="full"
test -f "$SRC/KIND" && KIND="$(cat "$SRC/KIND")"
ATTACHMENTS="${ATTACHMENTS:-backups/auto/附件}"
if [ "$KIND" = "daily" ]; then
  VOLUMES="bridge-state extras-state dsh-home"
else
  # SnowLuma 的三个卷里有 QQ 登录态，恢复后不用重新扫码
  VOLUMES="dsh-home bridge-state qq-gateway-data qq-client-config qq-client-data sandbox-browser extras-state"
fi

for vol in $VOLUMES; do
  test -f "$SRC/${vol}.tar.gz" || { echo "缺少 $SRC/${vol}.tar.gz" >&2; exit 1; }
  gzip -t "$SRC/${vol}.tar.gz" || { echo "$SRC/${vol}.tar.gz 坏了" >&2; exit 1; }
done
if [ "$KIND" = "weekly" ] && [ ! -d "$ATTACHMENTS/v1" ]; then
  echo "提醒：$ATTACHMENTS 下没有会话里的图，这次只恢复卷，图要另外从网盘拉（见开头）" >&2
fi

if [ "$YES" != "-y" ]; then
  printf '将用 %s（%s）覆盖 %s 下的卷：%s，继续？[y/N] ' "$SRC" "$KIND" "$PROJECT" "$VOLUMES"
  read -r answer
  [ "$answer" = "y" ] || { echo "已取消"; exit 1; }
fi

for vol in $VOLUMES; do
  # 带上 compose 的标签，之后 docker compose up 会把它当成自己的卷，不会报“不是本项目创建的”
  docker volume create \
    --label "com.docker.compose.project=${PROJECT}" \
    --label "com.docker.compose.volume=${vol}" \
    "${PROJECT}_${vol}" >/dev/null
  CLEAR="find /dst -mindepth 1 -delete"
  if [ "$KIND" != "full" ] && [ "$vol" = "dsh-home" ]; then
    CLEAR="find /dst -mindepth 1 -maxdepth 1 ! -name attachments ! -name cache -exec rm -rf {} +"
  fi
  # 从标准输入喂进去（不绑定挂载备份目录），绝对路径也行
  docker run --rm -i \
    -v "${PROJECT}_${vol}:/dst" \
    debian:bookworm-20260918-slim \
    sh -c "$CLEAR && tar --numeric-owner -C /dst -xzf -" <"$SRC/${vol}.tar.gz"
done

# 会话里的图：按文件补回去（名字就是内容的 sha256，已经有的不覆盖），属主跟卷根目录一样（dsh 是 1000）
if [ "$KIND" = "weekly" ] && [ -d "$ATTACHMENTS/v1" ]; then
  tar -C "$ATTACHMENTS" -cf - --exclude='./.*' . | docker run --rm -i -v "${PROJECT}_dsh-home:/dst" debian:bookworm-20260918-slim \
    sh -c 'mkdir -p /dst/attachments && tar -C /dst/attachments --skip-old-files -xf - &&
      find /dst/attachments -type f -name "*.dup" | while read -r f; do
        if [ -e "${f%.dup}" ]; then rm -f "$f"; else mv "$f" "${f%.dup}"; fi
      done &&
      chown -R --reference=/dst /dst/attachments && chmod -R go-rwx /dst/attachments'
  echo "会话里的图已从 $ATTACHMENTS 补回"
fi
echo "卷已恢复（$KIND）。需要的话解压 $SRC/config-and-roles.tar.gz，然后 docker compose up -d"
