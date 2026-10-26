# 沙箱电脑：Xvfb 虚拟桌面 + noVNC（给你围观）+ Playwright MCP（浏览器）+ desktop MCP（截图/鼠标/键盘）
# 没有 shell 类工具；容器里不放任何密钥，可以随时销毁重建。
ARG NODE_IMAGE=node:22.23.2-bookworm-slim
FROM ${NODE_IMAGE}

ARG PLAYWRIGHT_MCP_VERSION=0.0.83

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb fluxbox x11vnc novnc websockify xdotool imagemagick \
      supervisor python3 python3-venv fonts-noto-cjk fonts-noto-color-emoji ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Playwright MCP 和它自带版本对应的 Chromium（--with-deps 会装好系统依赖）
RUN npm install -g --no-audit --no-fund "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && PW_CLI="$(find "$(npm root -g)/@playwright/mcp" -path '*/node_modules/playwright/cli.js' | head -n 1)" \
 && test -n "$PW_CLI" \
 && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright node "$PW_CLI" install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

# browser_take_screenshot 传了 filename 就只回文字不回图，模型会以为截到了其实什么也没看到。
# 改成不管有没有 filename 都把图片带回去；升级 playwright-mcp 后这句匹配不到会直接构建失败。
RUN f="$(npm root -g)/@playwright/mcp/node_modules/playwright-core/lib/coreBundle.js" \
 && grep -q 'if (!params2.filename)$' "$f" \
 && sed -i 's/^\(\s*\)if (!params2.filename)$/\1if (true)/' "$f" \
 && ! grep -q 'if (!params2.filename)$' "$f"

COPY requirements.txt /opt/desktop-mcp/requirements.txt
RUN python3 -m venv /opt/desktop-mcp/venv \
 && /opt/desktop-mcp/venv/bin/pip install --no-cache-dir -r /opt/desktop-mcp/requirements.txt
COPY desktop_mcp.py /opt/desktop-mcp/desktop_mcp.py
COPY supervisord.conf /etc/supervisor/sandbox.conf
COPY start-vnc.sh /usr/local/bin/start-vnc.sh

# 所有程序都以普通用户 sandbox 运行
RUN useradd --create-home --uid 10001 sandbox \
 && mkdir -p /var/lib/sandbox-browser \
 && chown -R sandbox:sandbox /opt/ms-playwright /var/lib/sandbox-browser \
 && chmod 0755 /usr/local/bin/start-vnc.sh

ENV DISPLAY=:99 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=800 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

USER sandbox
WORKDIR /home/sandbox
EXPOSE 6080 6082 8931 8932 8933
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/sandbox.conf"]
