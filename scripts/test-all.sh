#!/usr/bin/env bash
# 全部离线测试：qq-bridge（本机 + 装好 DSH 的控制面镜像里）和 extras 的单元测试。
# 只用假数据；不连 QQ、不碰正在跑的容器，用的是 build 出来的镜像。
#   scripts/test-all.sh            先 build 再测
#   scripts/test-all.sh --no-build 用现有镜像
set -euo pipefail
cd "$(dirname "$0")/.."
# 当前 shell 还没进 docker 组（WSL 上新登录前是这样）就用 sg 重跑自己
if ! docker info >/dev/null 2>&1 && [ -z "${TEST_ALL_SG:-}" ]; then
  exec sg docker -c "TEST_ALL_SG=1 $(printf '%q ' "$0" "$@")" </dev/null
fi

[ "${1:-}" = "--no-build" ] || docker compose build dsh extras

status=0
echo "== qq-bridge（本机）"
[ -d qq-bridge/node_modules ] || (cd qq-bridge && npm ci --no-audit --no-fund >/dev/null)
(cd qq-bridge && node scripts/run-tests.mjs) | tail -3 || status=1

echo "== qq-bridge（控制面镜像：要 DSH 的测试、persona 校验）"
docker run --rm --network none -v "$PWD/qq-bridge/scripts:/opt/qq-bridge/scripts:ro" \
  --entrypoint sh qqbot-control:local -c '
    cd /opt/qq-bridge
    node scripts/run-tests.mjs --dsh > /tmp/o 2>&1; r=$?; tail -3 /tmp/o; [ $r = 0 ] || exit $r
    DSH_INSTALL_MODULES=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules \
      node scripts/verify-persona-config.mjs > /tmp/o 2>&1; r=$?; tail -1 /tmp/o; exit $r' || status=1

echo "== extras"
docker run --rm --network none -v "$PWD/extras:/src:ro" --entrypoint sh qqbot-extras:local -c '
    cp /src/*.py /tmp/ && cd /tmp
    /opt/extras/venv/bin/python -m unittest test_extras > /tmp/o 2>&1; r=$?; tail -3 /tmp/o; exit $r' || status=1

exit $status
