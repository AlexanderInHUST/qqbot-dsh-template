#!/bin/sh
# 部署前检查：Docker、目录位置、文件权限、换行符、密钥和配置。在 Mac、Linux、WSL 上都能跑。
# 用法：scripts/preflight.sh          只检查
#       scripts/preflight.sh --fix    顺手修能自动修的（换行符、config.json 权限）
set -u

cd "$(dirname "$0")/.."
FIX="${1:-}"
fail=0
ok()   { echo "  ok    $*"; }
warn() { echo "  注意  $*"; }
bad()  { echo "  失败  $*"; fail=1; }

echo "== 环境"
os="$(uname -s)"
if grep -qi microsoft /proc/version 2>/dev/null; then ok "WSL（$(uname -r)）"; else ok "$os $(uname -m)"; fi
case "$(pwd)" in
  /mnt/*) bad "项目在 Windows 盘（$(pwd)）上：权限检查不生效、速度慢。挪到 WSL 自己的目录，例如 ~/qqbot_agent" ;;
  *) ok "项目目录 $(pwd)" ;;
esac

echo "== Docker"
if docker info >/dev/null 2>&1; then
  ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)，$(docker info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null)"
  mem="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
  gib=$((mem / 1073741824))
  if [ "$gib" -ge 10 ]; then ok "Docker 可用内存 ${gib}G"; else warn "Docker 可用内存只有 ${gib}G，建议 10G 以上（WSL 改 %UserProfile%\\.wslconfig 的 memory=）"; fi
else
  bad "连不上 Docker。WSL 里：Docker Desktop 打开 Settings → Resources → WSL integration；或者在 WSL 里装 docker-ce 并启动"
fi
if docker compose version >/dev/null 2>&1; then ok "$(docker compose version | head -1)"; else bad "没有 docker compose v2 插件"; fi

echo "== 文件"
# Linux/WSL 上绑定挂载的权限是真的：dsh/bridge 以 uid 1000 读写 config.json，extras 靠 gid 1000 读它
if [ "$os" = Linux ]; then
  if [ "$(id -u)" = 1000 ] && [ "$(id -g)" = 1000 ]; then ok "当前用户 uid/gid 1000"
  else warn "当前用户 uid=$(id -u) gid=$(id -g)，不是 1000：需要 sudo chown 1000:1000 config/qq-bridge/config.json"; fi
fi
crlf="$(grep -rlI "$(printf '\r')" control egress extras sandbox scripts config roles docker-compose.yml 2>/dev/null || true)"
if [ -z "$crlf" ]; then ok "没有 CRLF 换行"
elif [ "$FIX" = --fix ]; then
  for f in $crlf; do sed -i.bak 's/\r$//' "$f" && rm -f "$f.bak"; done; ok "已把这些文件改回 LF：$(echo $crlf)"
else bad "这些文件是 CRLF 换行（Windows 检出导致），容器会起不来：$(echo $crlf)。加 --fix 自动修"; fi

if [ -f .env ]; then
  for k in DEEPSEEK_API_KEY SNOWLUMA_VNC_PASSWD; do
    if grep -Eq "^$k=.+" .env; then ok ".env 里有 $k"; else bad ".env 里 $k 是空的"; fi
  done
  if grep -Eq "^AIOHUB_API_KEY=.+" .env; then ok ".env 里有 AIOHUB_API_KEY（备用模型）"; else warn ".env 里没有 AIOHUB_API_KEY：只能用 DeepSeek 官方模型"; fi
else bad "没有 .env（从迁移包导入，或复制 .env.example 后填写）"; fi

c=config/qq-bridge/config.json
if [ -d "$c" ]; then bad "$c 是个目录（docker 在文件不存在时自动建的），删掉后从迁移包恢复或复制 config.example.json"
elif [ ! -f "$c" ]; then bad "没有 ${c}（从迁移包导入，或复制 config.example.json 后填写）"
else
  if grep -q "__FILL_" "$c"; then bad "$c 里还有 __FILL_ 占位符"; else ok "$c 已填写"; fi
  if [ "$os" = Linux ]; then
    mode="$(stat -c %a "$c")"
    if [ "$mode" = 640 ]; then ok "$c 权限 640"
    elif [ "$FIX" = --fix ]; then chmod 640 "$c" && ok "已把 $c 权限改成 640"
    else bad "$c 权限是 ${mode}，需要 640（属主读写、extras 所在的组只读）。加 --fix 自动修"; fi
  fi
fi
for f in config/extras.json config/dsh/home.cordis.patch.yml; do
  [ -f "$f" ] && ok "$f" || bad "缺少 $f"
done
ls roles/*.md >/dev/null 2>&1 && ok "人格卡 $(ls roles/*.md | tr '\n' ' ')" || bad "roles/ 下没有人格卡"

echo "== 端口（只绑 127.0.0.1）"
running="$(docker compose ps -q 2>/dev/null | wc -l | tr -d ' ')"
for p in 3080 3100 5099 6080 6081 6082; do
  if [ "$running" -gt 0 ]; then ok "${p}（本项目已在运行，跳过）"; continue; fi
  if (command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q "[:.]$p "); then bad "端口 $p 已被占用"
  else ok "$p 空闲"; fi
done

echo
if [ "$fail" = 0 ]; then echo "检查通过，可以 docker compose build && docker compose up -d"; else echo "有失败项，先处理上面标“失败”的地方"; fi
exit "$fail"
