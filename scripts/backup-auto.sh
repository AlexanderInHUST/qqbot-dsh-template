#!/usr/bin/env bash
# 自动备份鱼妹（2026-11-09）。她是要一直养下去的，数据只有一份放在一块盘上不行。
#   scripts/backup-auto.sh daily     她自己的数据：bridge-state、extras-state、dsh-home（不带 attachments/ cache/ .pnpm-store/），
#                                    加 config/、roles/、.env、docker-compose.yml。2026-11 约 180MB、十几秒，传网盘三四分钟。
#                                    再把会话里的图（dsh-home 的 attachments）按文件增量拷一份，见下面“附件”。
#   scripts/backup-auto.sh weekly    scripts/backup.sh 的全量：七个卷（QQ 登录态、play 浏览器的 B 站登录都在），
#                                    不带会话里的图和浏览器缓存（2026-11 这两样 4.3GB 里占了 3.5GB），约 800MB，传网盘十几分钟。
#   scripts/backup-auto.sh install   装 systemd 用户定时器（每天 05:20、每周日 05:40；关着机错过了，下次开 WSL 补跑）
#   scripts/backup-auto.sh status    最近一次备份的情况（yumei-power.sh status 也会显示）
# yumei-power.sh stop 停完容器后也跑一次 daily：卷都静止了，是最完整的一份。
#
# 放两处：
#   本机 BACKUP_DIR（默认仓库的 backups/auto）：每天/<时间>/ 留 KEEP_DAILY 份，每周/<时间>/ 留 KEEP_WEEKLY 份。
#     和 docker 卷在同一块盘上，防的是卷被清、数据改坏，防不了盘坏。
#   网盘 CLOUD_REMOTE（rclone 远端，比如 remote:鱼妹备份，PikPak、OneDrive 之类都行，rclone 装在 ~/.local/bin）：
#     每天/、每周/ 各传最新一份，留 KEEP_CLOUD_DAILY / KEEP_CLOUD_WEEKLY 份；附件/ 只传新增的图。盘坏了靠它。
#     先传成 <时间>.part 再改名，传一半断了的下次清掉；这次没传上的，下次 daily 会把最新的每天、每周补传。
#     传网盘时不占着备份的锁（一键关闭那次备份不用等它），两次上传撞上了后来的跳过。
#     一键关闭那次不传（hta 跑完就 wsl --shutdown，传一半会被掐断），等早上的定时器补。
#     原样传，不加密（主人说只有他看）；里面有 .env 的 API Key 和 QQ 登录用的 token，网盘别分享。
# 附件：会话里的图按内容的 sha256 起名、写了不改（dsh-home/attachments/v1/objects/xx/<sha256>），2026-11 有 8 千多张、2.3GB。
#   每次 daily 只把本机 附件/ 里还没有的拷过来（核对 sha256，不对的删掉下次再拷），网盘 附件/ 也只传新的（rclone copy）。
#   从不删：会话压缩、重置后 DSH 不用的图也留着。上传断了不白传，下次接着传没传的。
# 配置写在 ~/.config/yumei-backup/config（shell 变量，比如 CLOUD_REMOTE=remote:鱼妹备份）。
# 恢复：scripts/restore.sh <目录>（每天的那份会自己认出来，只恢复她的三个卷，见 restore.sh 开头）。
#   网盘上的先 rclone copy remote:鱼妹备份/每天/<时间> <本地目录> 拉下来；图在 remote:鱼妹备份/附件，
#   恢复每周那份时 restore.sh 会把 backups/auto/附件（或 ATTACHMENTS=<目录>）拷回 dsh-home。
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
CONF_DIR="$HOME/.config/yumei-backup"
STATUS="$CONF_DIR/status"
[ -f "$CONF_DIR/config" ] && . "$CONF_DIR/config"
BACKUP_DIR="${BACKUP_DIR:-$REPO/backups/auto}"
KEEP_DAILY="${KEEP_DAILY:-30}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
KEEP_CLOUD_DAILY="${KEEP_CLOUD_DAILY:-30}"
KEEP_CLOUD_WEEKLY="${KEEP_CLOUD_WEEKLY:-4}"
CLOUD_REMOTE="${CLOUD_REMOTE:-}"
export PATH="$HOME/.local/bin:$PATH"
PROJECT="${COMPOSE_PROJECT_NAME:-qqbot_agent}"
IMAGE="debian:bookworm-20260918-slim"
STAMP_RE='^[0-9]{8}-[0-9]{6}$'
ATTACH="$BACKUP_DIR/附件"

if ! docker info >/dev/null 2>&1 && [ -z "${BACKUP_SG:-}" ] && getent group docker >/dev/null; then
  # docker 组还没生效的登录会话（见 yumei-power.sh）
  if sg docker -c "docker info" >/dev/null 2>&1; then exec sg docker -c "BACKUP_SG=1 $(printf '%q ' "$0" "$@")" </dev/null; fi
fi

say() { echo "[备份] $*"; }
mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR"

# 只留最新的 N 个子目录（名字是时间，按名字排就是按时间）
keep_newest() {
  local dir="$1" n="$2"
  [ -d "$dir" ] || return 0
  ls -1 "$dir" | grep -E "$STAMP_RE" | sort | head -n -"$n" | while read -r old; do rm -rf "${dir:?}/$old"; done
}

vol_tar() {  # vol_tar <卷> <输出文件> [tar 的排除参数…]
  local vol="$1" out="$2"; shift 2
  docker volume inspect "${PROJECT}_${vol}" >/dev/null 2>&1 || { say "没有卷 ${PROJECT}_${vol}"; return 1; }
  # 容器开着时会话记录、日志一直在写，tar 报“file changed as we read it”退出 1，那份照样能用；2 以上才算失败
  docker run --rm -v "${PROJECT}_${vol}:/src:ro" "$IMAGE" sh -c \
    'tar --numeric-owner --warning=no-file-changed -C /src "$@" -czf - .; s=$?; [ $s -le 1 ]' sh "$@" >"$out.part" \
    && gzip -t "$out.part" && mv "$out.part" "$out"
}

write_status() {  # write_status <kind> <ok|warn|fail> <where> <说明>
  local tmp="$STATUS.tmp.$$"
  { grep -v "^$1 " "$STATUS" 2>/dev/null; echo "$1 $2 $(date '+%Y-%m-%d %H:%M') $3 $4"; } >"$tmp" && mv "$tmp" "$STATUS"
}

daily() {
  local stamp out
  stamp="$(date +%Y%m%d-%H%M%S)"
  out="$BACKUP_DIR/每天/$stamp"
  mkdir -p "$out.tmp" || { write_status daily fail "$BACKUP_DIR" "建不了目录"; return 1; }
  local ok=1
  vol_tar bridge-state "$out.tmp/bridge-state.tar.gz" || ok=0
  vol_tar extras-state "$out.tmp/extras-state.tar.gz" || ok=0
  vol_tar dsh-home "$out.tmp/dsh-home.tar.gz" --exclude=./attachments --exclude=./cache --exclude=./.pnpm-store || ok=0
  tar -czf "$out.tmp/config-and-roles.tar.gz" --exclude='config/qq-bridge/config.json.bak*' --exclude='config/extras.json.bak*' \
    config roles docker-compose.yml $(test -f .env && echo .env) || ok=0
  # 抽查：她的记忆、状态真在里面（先整份列出来再找，grep -q 提前退出会让 pipefail 误报）
  local list
  list="$(tar -tzf "$out.tmp/extras-state.tar.gz" 2>/dev/null)"
  grep -qx '\./memory\.json' <<<"$list" || { say "extras-state 里没有 memory.json"; ok=0; }
  list="$(tar -tzf "$out.tmp/bridge-state.tar.gz" 2>/dev/null)"
  grep -q '^\./social-v2/' <<<"$list" || { say "bridge-state 里没有 social-v2/"; ok=0; }
  if [ "$ok" != 1 ]; then
    rm -rf "$out.tmp"; write_status daily fail "$BACKUP_DIR" "有一块没备份上，看 journalctl --user -u yumei-backup-daily"; return 1
  fi
  echo daily >"$out.tmp/KIND"
  { echo "time=$stamp"; echo "host=$(hostname)"; echo "git=$(git rev-parse --short HEAD 2>/dev/null)";
    (cd "$out.tmp" && sha256sum *.tar.gz); } >"$out.tmp/MANIFEST"
  cat >"$out.tmp/恢复说明.txt" <<'EOF'
这是鱼妹每天的备份：她的记忆、人物卡、计划日记、成长档案（extras-state），聊天状态（bridge-state），
会话记录（dsh-home，不带会话里的图），还有配置、人格卡、.env。
恢复（会覆盖现有的）：docker compose down && scripts/restore.sh <这个目录>
卷全没了或换了机器：先 restore 最近的“每周”全量，再 restore 它之后最近的这份“每天”。
里面有 API Key 和登录用的 token，别发给别人。
EOF
  chmod -R go-rwx "$out.tmp" 2>/dev/null
  mv "$out.tmp" "$out"
  rm -rf "$BACKUP_DIR"/每天/*.tmp 2>/dev/null
  keep_newest "$BACKUP_DIR/每天" "$KEEP_DAILY"
  write_status daily ok "$out" "$(du -sh "$out" | cut -f1)"
  say "每天的备份好了：$out"
}

weekly() {
  local stamp out
  stamp="$(date +%Y%m%d-%H%M%S)"
  out="$BACKUP_DIR/每周/$stamp"
  mkdir -p "$BACKUP_DIR/每周"
  if BACKUP_SKIP_ATTACHMENTS=1 scripts/backup.sh "$out.tmp" >/dev/null; then
    echo weekly >"$out.tmp/KIND"
    (cd "$out.tmp" && sha256sum *.tar.gz) >"$out.tmp/MANIFEST"
    mv "$out.tmp" "$out"
    rm -rf "$BACKUP_DIR"/每周/*.tmp 2>/dev/null
    keep_newest "$BACKUP_DIR/每周" "$KEEP_WEEKLY"
    write_status weekly ok "$out" "$(du -sh "$out" | cut -f1)"
    say "每周的全量好了：$out"
  else
    rm -rf "$out.tmp"; write_status weekly fail "$BACKUP_DIR" "scripts/backup.sh 出错"; return 1
  fi
}

attachments() {  # 会话里的图：本机 附件/ 里没有的拷过来
  local have want missing n bad=0
  mkdir -p "$ATTACH"
  want="$(docker run --rm -v "${PROJECT}_dsh-home:/src:ro" "$IMAGE" sh -c 'cd /src/attachments 2>/dev/null && find . -type f' | sort)" \
    || { write_status attach fail "$ATTACH" "列不出卷里的图"; return 1; }
  have="$(cd "$ATTACH" && find . -type f ! -name '.*' | sort)"
  missing="$(comm -23 <(echo "$want") <(echo "$have") | grep -v '^$')"
  n="$(grep -c . <<<"$missing")"
  if [ "$n" -gt 0 ]; then
    printf '%s\n' "$missing" | docker run --rm -i -v "${PROJECT}_dsh-home:/src:ro" "$IMAGE" \
      tar -C /src/attachments -T - -cf - | tar -C "$ATTACH" -xf - \
      || { write_status attach fail "$ATTACH" "拷图出错"; return 1; }
    # 名字就是内容的 sha256，不对的删掉，下次再拷
    while read -r f; do
      [ -f "$ATTACH/$f" ] || { bad=$((bad+1)); continue; }
      [ "$(sha256sum "$ATTACH/$f" | cut -c1-64)" = "$(basename "$f")" ] || { rm -f "$ATTACH/$f"; bad=$((bad+1)); }
    done <<<"$missing"
  fi
  chmod -R go-rwx "$ATTACH" 2>/dev/null
  local total; total="$(grep -c . <<<"$want")"
  if [ "$bad" -gt 0 ]; then
    write_status attach fail "$ATTACH" "新拷了 $((n-bad)) 张，$bad 张没拷对，下次再拷"; return 1
  fi
  write_status attach ok "$ATTACH" "共 $total 张 $(du -sh "$ATTACH" | cut -f1)，这次新拷 $n 张"
  say "会话里的图：共 $total 张，这次新拷 $n 张"
}

upload_attachments() {  # 网盘 附件/ 只传新的（rclone 按名字和大小比，已经有的跳过）
  command -v rclone >/dev/null || { write_status cloud-attach fail "$CLOUD_REMOTE/附件" "没装 rclone"; return 1; }
  [ -d "$ATTACH/v1" ] || return 0
  local R="$CLOUD_REMOTE/附件" dups="$ATTACH/.cloud-dup" local_list remote_list missing f n=0
  touch "$dups"
  # PikPak 建文件太快会限流（“operation is too frequent”，11-10 第一次传 8 千张传到一个多小时被掐），每秒最多 4 次。
  # 被掐断的那几张在网盘上留下看不见、删不掉的半截同名文件，再传就是 file_duplicated_name：
  # 这种的另存成 <名字>.dup，记在 .cloud-dup 里以后不再按原名传（restore.sh 会把 .dup 改回来）
  rclone copy --transfers 4 --tpslimit 4 --retries 3 --low-level-retries 10 --exclude '.*' --exclude-from "$dups" "$ATTACH" "$R" \
    || say "有图没按原名传上，看看是不是网盘上有传坏的同名文件"
  local_list="$(cd "$ATTACH" && find v1 -type f ! -name '.*' | sort)"
  remote_list="$(rclone lsf -R --files-only "$R" 2>/dev/null | sed 's/\.dup$//' | sort -u)" \
    || { write_status cloud-attach fail "$R" "列不出网盘上的图，下次再传"; return 1; }
  missing="$(comm -23 <(echo "$local_list") <(echo "$remote_list") | grep -v '^$')"
  while read -r f; do
    [ -n "$f" ] || continue
    if rclone copyto --tpslimit 4 "$ATTACH/$f" "$R/$f.dup"; then echo "$f" >>"$dups"; else n=$((n+1)); fi
  done <<<"$missing"
  if [ "$n" -gt 0 ]; then
    write_status cloud-attach fail "$R" "还有 $n 张没传上，下次接着传"; return 1
  fi
  write_status cloud-attach ok "$R" "和本机一样多（$(grep -c . <<<"$local_list") 张，$(grep -c . "$dups") 张存成 .dup）"
}

upload() {  # upload <每天|每周> <网盘上留几份>：把本机最新的一份传上去（已经在网盘上的不重传），再清掉多的、传一半的
  local sub="$1" keep="$2" kind newest have dir="$BACKUP_DIR/$1" remote="$CLOUD_REMOTE/$1"
  [ "$sub" = 每天 ] && kind=cloud-daily || kind=cloud-weekly
  command -v rclone >/dev/null || { write_status "$kind" fail "$remote" "没装 rclone"; return 1; }
  newest="$(ls -1 "$dir" 2>/dev/null | grep -E "$STAMP_RE" | sort | tail -n 1)"
  [ -n "$newest" ] || return 0
  have="$(rclone lsf --dirs-only "$remote" 2>/dev/null)" || have=""
  if ! grep -qx "$newest/" <<<"$have"; then
    say "传到网盘：$remote/$newest"
    if rclone copy --retries 5 --low-level-retries 10 "$dir/$newest" "$remote/$newest.part" \
      && rclone moveto "$remote/$newest.part" "$remote/$newest"; then
      write_status "$kind" ok "$remote/$newest" "$(du -sh "$dir/$newest" | cut -f1)"
      say "传好了：$remote/$newest"
    else
      write_status "$kind" fail "$remote" "$newest 没传上，下次再补"; return 1
    fi
    have="$(rclone lsf --dirs-only "$remote" 2>/dev/null)"
  fi
  grep -E '\.part/$' <<<"$have" | while read -r d; do rclone purge "$remote/${d%/}"; done
  grep -E '^[0-9]{8}-[0-9]{6}/$' <<<"$have" | sort | head -n -"$keep" | while read -r d; do rclone purge "$remote/${d%/}"; done
  return 0
}

uploads() {  # uploads <daily|weekly>：放开备份的锁再传，另一边正在传就跳过
  [ -n "$CLOUD_REMOTE" ] || return 0
  if [ -n "${BACKUP_NO_UPLOAD:-}" ]; then say "这次不传网盘，等下次定时器补"; return 0; fi
  flock -u 9
  exec 8>"$CONF_DIR/upload.lock"
  flock -n 8 || { say "另一边正在传网盘，这次不传"; return 0; }
  local ok=0
  # 图放最后：它文件多，撞上限流也不耽误每天、每周那两份
  if [ "$1" = weekly ]; then
    upload 每周 "$KEEP_CLOUD_WEEKLY" || ok=1
  else
    upload 每天 "$KEEP_CLOUD_DAILY" || ok=1
    upload 每周 "$KEEP_CLOUD_WEEKLY" || ok=1   # 每周那次没传上的，在这里补
  fi
  upload_attachments || ok=1
  return $ok
}

install_timers() {
  local unit="$HOME/.config/systemd/user"
  mkdir -p "$unit"
  for kind in daily weekly; do
    cat >"$unit/yumei-backup-$kind.service" <<EOF
[Unit]
Description=鱼妹的备份（$kind）
[Service]
Type=oneshot
WorkingDirectory=$REPO
ExecStart=$REPO/scripts/backup-auto.sh $kind
Nice=10
IOSchedulingClass=idle
EOF
  done
  # 每天 05:20（凌晨 4 点记忆整理之后）；每周日 05:40。Persistent：WSL 关着错过了，下次开机补跑
  printf '[Unit]\nDescription=每天备份鱼妹\n[Timer]\nOnCalendar=*-*-* 05:20\nPersistent=true\nRandomizedDelaySec=300\n[Install]\nWantedBy=timers.target\n' \
    >"$unit/yumei-backup-daily.timer"
  printf '[Unit]\nDescription=每周全量备份鱼妹\n[Timer]\nOnCalendar=Sun *-*-* 05:40\nPersistent=true\nRandomizedDelaySec=300\n[Install]\nWantedBy=timers.target\n' \
    >"$unit/yumei-backup-weekly.timer"
  systemctl --user daemon-reload && systemctl --user enable --now yumei-backup-daily.timer yumei-backup-weekly.timer
  systemctl --user list-timers 'yumei-backup-*' --no-pager
}

status() {
  [ -f "$STATUS" ] || { echo "备份：还没备份过"; return 0; }
  local kind state day time where note name mark
  for want in daily weekly attach cloud-daily cloud-weekly cloud-attach; do
    while read -r kind state day time where note; do
      [ "$kind" = "$want" ] || continue
      case "$kind" in daily) name="本机每天";; weekly) name="本机每周";; attach) name="本机的图";;
        cloud-daily) name="网盘每天";; cloud-weekly) name="网盘每周";; *) name="网盘的图";; esac
      case "$state" in ok) mark="";; warn) mark="（注意）";; *) mark="（失败）";; esac
      echo "备份$name$mark：$day $time  $note  $where"
    done <"$STATUS"
  done
}

# 同一时间只备份一个（定时器和关机那次撞上）
exec 9>"$CONF_DIR/lock"
case "${1:-}" in
  daily|weekly)
    flock -w 1800 9 || { say "上一次还没跑完"; exit 1; }
    "$1" || exit 1
    [ "$1" = daily ] && attachments
    uploads "$1" ;;
  install) install_timers ;;
  status) status ;;
  *) echo "用法：scripts/backup-auto.sh daily|weekly|install|status" >&2; exit 2 ;;
esac
