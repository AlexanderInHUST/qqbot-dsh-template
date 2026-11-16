"""Her file workspace (2026-11-16, 主人：“给鱼妹弄个单独隔离的 workspace 来存放文件……定期清理，
清理在 4 点跟随记忆一起整理”；“记忆如果一直能记住就不要删”).

The bridge owns the files: /files/<chat>/<id><ext> plus <id>.meta.json (src/app/files.js, chat dirs
group-<n> / private-<n>), and tells memory.py about each one (kind="file"). Here, once a night at the end
of consolidate.run_once, a file goes when she no longer remembers it: no live file memory points at it
(it faded, or was pushed out by newer ones). Files saved in the last graceHours stay anyway (the memory may
not be written yet). Half-written .part files older than an hour go too, and memories whose file is gone
are forgotten. Nothing else ever deletes files except her own qq_file_delete."""

import json
import os
import re
import time

import memory
from store import extras_config

DIR_RE = re.compile(r"^(group|private)-(\d{5,12})$")
FILE_RE = re.compile(r"^([a-z0-9]{6,32})(\.[a-z0-9]{1,8})?$")
META_SUFFIX = ".meta.json"


def _cfg() -> dict:
    return {"enabled": True, "dir": os.environ.get("FILES_DIR", "/files"), "graceHours": 72,
            **extras_config().get("workspace", {})}


def _scan(root: str) -> dict[str, dict[str, dict]]:
    """{chat key: {file id: {"paths": [...], "meta": {...}, "mtime": t}}} for everything on disk."""
    out: dict[str, dict[str, dict]] = {}
    if not os.path.isdir(root):
        return out
    for d in sorted(os.listdir(root)):
        m = DIR_RE.match(d)
        path = os.path.join(root, d)
        if not m or not os.path.isdir(path) or os.path.islink(path):
            continue
        key = f"{m.group(1)}:{m.group(2)}"
        files = out.setdefault(key, {})
        for name in os.listdir(path):
            p = os.path.join(path, name)
            if os.path.islink(p) or not os.path.isfile(p):
                continue
            base = name[:-5] if name.endswith(".part") else name
            if base.endswith(META_SUFFIX):
                fid = base[: -len(META_SUFFIX)]
            else:
                fm = FILE_RE.match(base)
                if not fm:
                    continue
                fid = fm.group(1)
            row = files.setdefault(fid, {"paths": [], "meta": None, "mtime": 0.0, "part": []})
            mtime = os.path.getmtime(p)
            if name.endswith(".part"):
                row["part"].append((p, mtime))
                continue
            row["paths"].append(p)
            row["mtime"] = max(row["mtime"], mtime)
            if name.endswith(META_SUFFIX):
                try:
                    with open(p, encoding="utf-8") as f:
                        row["meta"] = json.load(f)
                except (OSError, ValueError):
                    row["meta"] = {}
    return out


def cleanup(now: float | None = None, dry_run: bool = False) -> dict:
    cfg = _cfg()
    if not cfg["enabled"]:
        return {"skipped": "off"}
    now = now or time.time()
    grace = float(cfg["graceHours"]) * 3600
    disk = _scan(cfg["dir"])
    refs = memory.file_refs()
    removed, parts, kept = [], 0, 0
    present: dict[str, set[str]] = {}  # files still on disk after this run
    for key, files in disk.items():
        for fid, row in files.items():
            for p, mtime in row["part"]:
                if now - mtime > 3600:
                    parts += 1
                    if not dry_run:
                        _rm(p)
            if not row["paths"]:
                continue
            saved = float((row["meta"] or {}).get("savedAt") or 0) / 1000 or row["mtime"]
            if fid in refs.get(key, set()) or now - saved < grace:
                kept += 1
                if any(not p.endswith(META_SUFFIX) for p in row["paths"]):
                    present.setdefault(key, set()).add(fid)
                continue
            removed.append(f"{key} {(row['meta'] or {}).get('name') or fid}")
            if not dry_run:
                for p in row["paths"]:
                    _rm(p)
    # 盘上没了的文件（手动删了、恢复了旧备份）：记忆也忘掉。整个目录都没挂上时不动记忆
    forgot = [] if dry_run or not os.path.isdir(cfg["dir"]) else memory.forget_missing_files(present)
    result = {"kept": kept, "removed": removed, "parts": parts, "forgot": [f"{e['fileKey']} {e.get('name')}" for e in forgot]}
    if not dry_run and (removed or parts or forgot):
        print(f"[文件] 清理：删了 {len(removed)} 个不记得的文件，{parts} 个没写完的，忘了 {len(forgot)} 条文件没了的记忆", flush=True)
    return result


def _rm(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
