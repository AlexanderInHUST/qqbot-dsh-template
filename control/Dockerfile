# 控制面镜像：DeepSeek Harness + qq-bridge（源码在 qq-bridge/）。
# dsh / bridge / ui-forward 三个服务共用这个镜像。持有凭据，但不给 AI 任何执行能力。
ARG NODE_IMAGE=node:22.23.2-bookworm-slim
FROM ${NODE_IMAGE}

# 版本全部写死，升级时在 docker-compose.yml 里一起改
ARG DSH_VERSION=0.2.0-rc.2
ARG PNPM_VERSION=10.33.0

# ffmpeg：qq-bridge 把 QQ 动图抽帧拼成宫格给模型看（patches 里的 src/gif-frames.js）
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates socat tini ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# dsh plugin 命令内部调用 pnpm，必须在 PATH 上
RUN npm install -g --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@${PNPM_VERSION}" \
 && dsh --version

# pi-ai 适配器补一个“每次请求最多几张图”的上限（中转站超过 32 张图就报 400），见脚本注释
COPY control/patch-pi-ai-image-count.mjs /opt/qqbot-patches/
RUN node /opt/qqbot-patches/patch-pi-ai-image-count.mjs \
      "$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js"

# 工具参数里的 anyOf [X, null] 会让中转站的 Gemini 拒绝整个请求，见脚本注释
COPY control/patch-pi-ai-tool-schema-null.mjs /opt/qqbot-patches/
RUN node /opt/qqbot-patches/patch-pi-ai-tool-schema-null.mjs \
      "$(npm root -g)/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js"

# 鱼妹的会话压缩时用中文、第一人称记笔记，不抄令牌和编号（原来是给写代码的助手用的英文模板），见脚本注释
COPY control/patch-dsh-compaction-qq.mjs /opt/qqbot-patches/
RUN node /opt/qqbot-patches/patch-dsh-compaction-qq.mjs \
      "$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js"

# qq-bridge：源码就在本仓库的 qq-bridge/ 目录（从上游 v0.2.0-r4 / a56164e7 分出来以后自己维护）
COPY qq-bridge/ /opt/qq-bridge/
RUN cd /opt/qq-bridge \
 && npm ci --no-audit --no-fund \
 && node scripts/build-agent-preset-patches.mjs

COPY control/entrypoint-dsh.sh control/entrypoint-bridge.sh control/entrypoint-ui-forward.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/entrypoint-*.sh \
 && mkdir -p /data/dsh /opt/qq-bridge/state \
 && chown -R node:node /data /opt/qq-bridge

ENV DSH_HOME=/data/dsh \
    NODE_ENV=production

USER node
WORKDIR /opt/qq-bridge
ENTRYPOINT ["/usr/bin/tini", "--"]
