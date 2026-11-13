#!/usr/bin/env bash
# 一键关 / 一键开鱼妹（桌面上的 鱼妹开关.hta 调它，也能手动跑）。
#   scripts/yumei-power.sh stop     记下“爸爸要打游戏把她关了”，再停掉所有容器，停完备份一次她的数据（scripts/backup-auto.sh daily，
#                                   卷都静止了，是最完整的一份；Docker Desktop 和 WSL 由 hta 在 Windows 那边关）
#   scripts/yumei-power.sh start    等 Docker 起来，拉起所有容器，再按 CLAUDE.md 连 dsh 一起重建 dsh bridge extras ui-forward
#   scripts/yumei-power.sh status   各容器状态、这次启动以来 QQ 连上没有、最近一次备份
# 关掉期间她不在：bridge 下次启动时看 state/away-reason.json 知道是为什么（src/app/away.js）。
set -uo pipefail
cd "$(dirname "$0")/.."
if ! docker info >/dev/null 2>&1 && [ -z "${POWER_SG:-}" ] && getent group docker >/dev/null; then
  # docker 组还没生效的登录会话
  if sg docker -c "docker info" >/dev/null 2>&1; then exec sg docker -c "POWER_SG=1 $(printf '%q ' "$0" "$@")" </dev/null; fi
fi

case "${1:-}" in
  stop)
    if docker compose ps --status running --services 2>/dev/null | grep -qx bridge; then
      docker compose exec -T bridge node -e "require('fs').writeFileSync('state/away-reason.json', JSON.stringify({ why: 'game', at: Date.now() }))" \
        && echo "已记下：爸爸要打游戏，把她关了" || echo "没记上关掉的原因（她醒来会以为是电脑出了点问题）"
    fi
    docker compose stop -t 20 && echo "容器都停了"
    # 备份没成也照样关（hta 那边不卡着），下次定时器再备份
    # 网盘这次不传：hta 跑完就 wsl --shutdown，传一半会被掐断，早上的定时器补传
    BACKUP_NO_UPLOAD=1 scripts/backup-auto.sh daily || echo "这次没备份上，定时器明早会再备份"
    ;;
  start)
    for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
    docker info >/dev/null 2>&1 || { echo "Docker 两分钟还没起来，先别点了，看看 Docker Desktop"; exit 1; }
    docker compose up -d || exit 1
    # 重建 extras 必须连 dsh 一起，否则她调记忆工具全是 Session not found（见 CLAUDE.md 常用命令）
    docker compose up -d --force-recreate dsh bridge extras ui-forward || exit 1
    echo "都拉起来了。QQ 要在登录页点一下“登录”"
    ;;
  status)
    scripts/backup-auto.sh status
    python3 tools/voice/drift.py status
    docker info >/dev/null 2>&1 || { echo "Docker 没开"; exit 0; }
    docker compose ps --format '{{.Service}}  {{.State}}' 2>/dev/null
    if docker compose ps --status running --services 2>/dev/null | grep -qx bridge; then
      # 看这次启动以来最后一次是连上还是断开（grep -q 会让 pipefail 误报，先整段拿下来）
      last=$(docker compose logs bridge 2>/dev/null | grep -E 'SnowLuma 已连接|SnowLuma 连接断开' | tail -n 1)
      case "$last" in
        *已连接*) echo "QQ：已连接，鱼妹在线" ;;
        *) echo "QQ：还没连上（去登录页点“登录”）" ;;
      esac
    fi
    ;;
  *) echo "用法：scripts/yumei-power.sh stop|start|status" >&2; exit 2 ;;
esac
