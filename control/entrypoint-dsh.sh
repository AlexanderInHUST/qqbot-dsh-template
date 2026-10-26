#!/bin/sh
# 启动 DeepSeek Harness Web。每次启动都重放一遍 qq-bridge 的 setup（它是幂等的），
# 这样升级镜像后 preset 和 MCP 条目会自动跟上。
set -eu

PROFILE_DIR="$DSH_HOME/profiles/web"

# 首次运行：--dump-config 会按内置模板初始化 web profile，不会启动服务
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "[entrypoint] 初始化 DSH web profile"
  dsh --profile web --dump-config >/dev/null
fi

# 注册 qq-chat / qq-chat-v2 预设、qq-bridge 的三个 MCP、bundle 链接，并执行 dsh plugin install
node /opt/qq-bridge/scripts/setup-dsh.mjs

# 家目录层补丁：沙箱 MCP（只读挂载在 /config，复制进去，避免 DSH 写回时碰到只读文件）
cp /config/dsh/home.cordis.patch.yml "$DSH_HOME/cordis.patch.yml"

# 只监听容器内回环；宿主机通过 ui-forward 访问
exec dsh web --no-open --host 127.0.0.1 --port 3080
