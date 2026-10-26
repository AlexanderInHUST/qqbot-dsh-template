# qqbot-extras：跨会话长期记忆 + Telegram 搬图（MCP，供 dsh 调用）
ARG DEBIAN_IMAGE=debian:bookworm-20260918-slim
FROM ${DEBIAN_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates tini tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /opt/extras/requirements.txt
RUN python3 -m venv /opt/extras/venv \
 && /opt/extras/venv/bin/pip install --no-cache-dir -r /opt/extras/requirements.txt

COPY *.py /opt/extras/
RUN useradd --create-home --uid 10002 extras \
 && mkdir -p /data \
 && chown extras:extras /data

USER extras
WORKDIR /opt/extras
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/extras/venv/bin/python", "-E", "-s", "/opt/extras/server.py"]
