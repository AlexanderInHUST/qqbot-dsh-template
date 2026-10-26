"""Shared helpers: config loading, JSON state files with atomic writes, content filters."""

import json
import os
import re
import tempfile
import threading

DATA_DIR = os.environ.get("EXTRAS_DATA_DIR", "/data")
EXTRAS_CONFIG = os.environ.get("EXTRAS_CONFIG", "/config/extras.json")
BRIDGE_CONFIG = os.environ.get("BRIDGE_CONFIG", "/config/qq-bridge.json")

# One lock for all state files: tool calls are rare, contention is not a concern.
LOCK = threading.RLock()


def load_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save_json(path: str, data) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def state_path(name: str) -> str:
    return os.path.join(DATA_DIR, name)


def extras_config() -> dict:
    """Re-read on every call so edits to config/extras.json apply without a restart."""
    return load_json(EXTRAS_CONFIG, {})


def bridge_config() -> dict:
    return load_json(BRIDGE_CONFIG, {})


def owner_subjects(bc: dict | None = None) -> set[str]:
    """qq:N for ownerQQ and extraOwnerQQ (阿明 / 阿红): their memories and cards are never left out or forgotten."""
    bc = bridge_config() if bc is None else bc
    ids = {str(bc.get("ownerQQ") or "")} | {str(x) for x in bc.get("extraOwnerQQ") or []}
    return {f"qq:{x}" for x in ids if x.isdigit()}


# ---- where something was heard, and who may see it ----
# 家里以外的群（大群、技术群…）只看得到在家里以外的群听来的东西：主人私下的事、家里群里的事不往外带。

_SOURCE_RE = re.compile(r"^(private|group):\d{5,12}$")


def home_groups(bc: dict | None = None) -> set[str]:
    bc = bridge_config() if bc is None else bc
    return {f"group:{g}" for g in bc.get("homeGroups") or []}


def source_key(source) -> str:
    """The conversation something was said in, from memory.json's source ("digest:group:N", "private:N"…);
    "?" when it isn't one (consolidate, hand fixes, play:main): not shown outside."""
    s = str(source or "")
    s = s[len("digest:"):] if s.startswith("digest:") else s
    return s if _SOURCE_RE.match(s) else "?"


def outside(key, homes: set[str]) -> bool:
    """A group that isn't one of the home groups (the big groups…)."""
    return str(key or "").startswith("group:") and key not in homes


def owner_words(bc: dict | None = None, aliases=()) -> list[str]:
    """Words that mean an owner: 主人, their titles (爸爸 / 妈妈), QQ numbers and names (阿明、阿红…)."""
    bc = bridge_config() if bc is None else bc
    words = {"主人"} | {str(t) for t in (bc.get("ownerTitles") or {}).values()}
    words |= {s.split(":", 1)[1] for s in owner_subjects(bc)} | {str(a) for a in aliases}
    return sorted(w for w in words if len(w) >= 2)


# Things that must never be stored in long-term memory or echoed into prompts.
_SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9]{16,}"),
    re.compile(r"(?i)\b(token|api[_ -]?key|secret|password|passwd|cookie|sessdata)\b"),
    re.compile(r"密码|口令|验证码|令牌|密钥"),
    re.compile(r"\b\d{6}\b"),  # one-time codes
]
# Text that tries to change behaviour instead of recording a fact.
_INSTRUCTION_PATTERNS = [
    re.compile(r"(?i)ignore (all |the )?(previous|prior)|system prompt|you (must|should) now"),
    re.compile(r"忽略(之前|以上|前面)|无视(之前|以上)|系统提示|提示词|以后(你)?(都)?(要|必须|一律)|从现在起(你)?(要|必须)"),
    re.compile(r"@全体|全体成员"),
]


def secret_reason(text: str) -> str | None:
    """Only the secret check: used for the owner's instructions, which are allowed to be instructions."""
    for p in _SECRET_PATTERNS:
        if p.search(text):
            return "看起来包含密码、验证码、token 之类的敏感信息，不能记"
    return None


def rejection_reason(text: str) -> str | None:
    """Return why a piece of text must not be stored, or None when it is fine."""
    reason = secret_reason(text)
    if reason:
        return reason
    for p in _INSTRUCTION_PATTERNS:
        if p.search(text):
            return "这像是在给你下指令，不是事实，不能记"
    return None
