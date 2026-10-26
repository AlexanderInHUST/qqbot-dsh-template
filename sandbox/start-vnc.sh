#!/bin/sh
# 启动 x11vnc，不设密码：它只监听容器内回环，外面只能经 noVNC（宿主机 127.0.0.1:6080 / 6082）访问。
# 如果以后把 6080 / 6082 暴露到本机以外，记得加回密码（-rfbauth）。
# 参数：显示器 端口（默认 :99 5900 是玩的那块屏；聊天浏览器那块是 :100 5901）
set -eu
exec x11vnc -display "${1:-:99}" -forever -shared -localhost -rfbport "${2:-5900}" -nopw -quiet
