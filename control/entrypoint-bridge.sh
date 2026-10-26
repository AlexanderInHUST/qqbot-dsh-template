#!/bin/sh
# 启动 qq-bridge。它和 dsh 共用网络命名空间（network_mode: service:dsh），
# 所以 127.0.0.1:3080 就是 DSH，127.0.0.1:3100 是它自己的控制台。
set -eu

# 等 DSH 起来（未登录时返回 401 也算起来了）
i=0
until node -e "fetch('http://127.0.0.1:3080/').then(()=>process.exit(0),()=>process.exit(1))"; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[entrypoint] 等了 120 秒 DSH 还没起来，退出等待重启" >&2
    exit 1
  fi
  sleep 2
done

# 等 SnowLuma 的 OneBot WebSocket 端口能连上（QQ 登录后才会监听）。
# qq-bridge 启动时第一次连接失败后不会再重试，所以必须等 QQ 上线再启动它。
i=0
until node -e "
  const c = require('/opt/qq-bridge/config.json').snowluma;
  const u = new URL(c.wsUrl);
  require('net').connect({ host: u.hostname, port: Number(u.port) || 80, timeout: 3000 })
    .on('connect', () => process.exit(0)).on('error', () => process.exit(1)).on('timeout', () => process.exit(1));
"; do
  if [ $((i % 30)) -eq 0 ]; then
    echo "[entrypoint] 还连不上 SnowLuma 的 OneBot（QQ 可能停在登录界面，去 http://127.0.0.1:6081 点一下登录），继续等…"
  fi
  i=$((i + 1))
  sleep 2
done

if grep -q "__FILL_" /opt/qq-bridge/config.json; then
  echo "[entrypoint] config/qq-bridge/config.json 里还有 __FILL_ 占位符没填，先填好再启动" >&2
  exit 1
fi

exec node src/bridge.js
