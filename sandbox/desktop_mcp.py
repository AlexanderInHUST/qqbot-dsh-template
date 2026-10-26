"""Sandbox virtual-desktop MCP server: screenshot, mouse and keyboard on the Xvfb display.

Deliberately has no tool that launches programs or runs commands; the only apps on the
desktop are the window manager and the Chromium that Playwright MCP opens.
"""

import os
import subprocess

from mcp.server.fastmcp import FastMCP, Image

DISPLAY = os.environ.get("DISPLAY", ":99")
WIDTH = int(os.environ.get("SCREEN_WIDTH", "1280"))
HEIGHT = int(os.environ.get("SCREEN_HEIGHT", "800"))
MAX_TEXT = 500
# xdotool key names the model may press; anything else is rejected
ALLOWED_KEYS = {
    "Return", "Escape", "Tab", "BackSpace", "Delete", "space",
    "Up", "Down", "Left", "Right", "Home", "End", "Page_Up", "Page_Down",
    "ctrl+a", "ctrl+c", "ctrl+v", "ctrl+f", "ctrl+l", "ctrl+t", "ctrl+w", "ctrl+r",
    "ctrl+plus", "ctrl+minus", "ctrl+0", "F5", "F11",
}

mcp = FastMCP(
    "sandbox-desktop",
    instructions="隔离沙箱的虚拟桌面（1280x800）。先截图再操作；坐标以截图像素为准。",
    host="0.0.0.0",
    port=int(os.environ.get("DESKTOP_MCP_PORT", "8932")),
)


def _run(args: list[str], timeout: float = 10) -> bytes:
    env = {"DISPLAY": DISPLAY, "PATH": "/usr/bin:/bin"}
    return subprocess.run(args, env=env, check=True, capture_output=True, timeout=timeout).stdout


def _check_point(x: int, y: int) -> None:
    if not (0 <= x < WIDTH and 0 <= y < HEIGHT):
        raise ValueError(f"坐标超出屏幕范围 {WIDTH}x{HEIGHT}: ({x}, {y})")


@mcp.tool()
def screenshot() -> Image:
    """截取整个虚拟桌面，返回 PNG。"""
    png = _run(["import", "-display", DISPLAY, "-window", "root", "png:-"])
    return Image(data=png, format="png")


@mcp.tool()
def click(x: int, y: int, button: str = "left", double: bool = False) -> str:
    """在 (x, y) 点击。button: left / middle / right。"""
    _check_point(x, y)
    buttons = {"left": "1", "middle": "2", "right": "3"}
    if button not in buttons:
        raise ValueError("button 只能是 left / middle / right")
    repeat = ["--repeat", "2"] if double else []
    _run(["xdotool", "mousemove", str(x), str(y), "click", *repeat, buttons[button]])
    return "ok"


@mcp.tool()
def scroll(x: int, y: int, direction: str = "down", amount: int = 3) -> str:
    """在 (x, y) 处滚动。direction: up / down；amount: 1~10。"""
    _check_point(x, y)
    if direction not in ("up", "down"):
        raise ValueError("direction 只能是 up / down")
    amount = max(1, min(amount, 10))
    wheel = "4" if direction == "up" else "5"
    _run(["xdotool", "mousemove", str(x), str(y), "click", "--repeat", str(amount), wheel])
    return "ok"


@mcp.tool()
def type_text(text: str) -> str:
    """在当前焦点处输入文字（最多 500 字符）。"""
    if len(text) > MAX_TEXT:
        raise ValueError(f"一次最多输入 {MAX_TEXT} 个字符")
    _run(["xdotool", "type", "--delay", "30", "--", text], timeout=60)
    return "ok"


@mcp.tool()
def press_key(key: str) -> str:
    """按键，例如 Return、Escape、ctrl+l。只允许常用的浏览类按键。"""
    if key not in ALLOWED_KEYS:
        raise ValueError(f"不允许的按键：{key}；可用：{', '.join(sorted(ALLOWED_KEYS))}")
    _run(["xdotool", "key", "--", key])
    return "ok"


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
