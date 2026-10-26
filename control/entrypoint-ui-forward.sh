#!/bin/sh
# 把容器回环上的网页转发到容器网卡，供 docker-compose 的端口映射使用。
# 宿主机那一侧只映射到 127.0.0.1，远程服务器请用 SSH 隧道访问。
# 浏览器发来的 Host 头仍然是 127.0.0.1:<端口>，能通过 qq-bridge 控制台的 Host 校验。
set -eu

socat TCP-LISTEN:13080,fork,reuseaddr TCP:127.0.0.1:3080 &
socat TCP-LISTEN:13100,fork,reuseaddr TCP:127.0.0.1:3100 &
# noVNC：经 mcp-gw 转进沙箱
socat TCP-LISTEN:16080,fork,reuseaddr TCP:mcp-gw:6080 &
# 第二块屏（聊天用的浏览器）
socat TCP-LISTEN:16082,fork,reuseaddr TCP:mcp-gw:6082 &
wait
