# 出网代理（squid）与 mcp-gw 中转（socat）共用的小镜像
ARG DEBIAN_IMAGE=debian:bookworm-20260918-slim
FROM ${DEBIAN_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends squid socat tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/run/squid \
 && chown proxy:proxy /var/run/squid

COPY squid.conf /etc/squid/squid.conf

# 以 proxy 用户直接启动：squid 从 root 降权后打不开 /dev/stdout 写日志
USER proxy

ENTRYPOINT ["/usr/bin/tini", "--"]
# 默认跑 squid；mcp-gw 在 docker-compose.yml 里覆盖 command
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]
