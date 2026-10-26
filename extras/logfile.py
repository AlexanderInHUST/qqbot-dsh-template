"""按天存日志：stdout / stderr 每行加上“MM-DD HH:MM:SS”再抄一份到 /data/logs/extras-YYYY-MM-DD.log，留 30 天。

docker 的容器日志每次 force-recreate 就没了，以前查不了前一天 digest / consolidate 做了什么。
bridge 每条消息都会 POST /digest/notify、发话后 POST /memory/told，uvicorn 的访问日志一半是这两条，
200 的不记（出错的照记）。
"""

import logging
import os
import sys
import threading
import time

LOG_DIR = os.path.join(os.environ.get("EXTRAS_DATA_DIR", "/data"), "logs")
KEEP_DAYS = max(1, int(os.environ.get("EXTRAS_LOG_KEEP_DAYS", "30") or 30))
QUIET_PATHS = ("/digest/notify", "/memory/told")

_lock = threading.Lock()
_day = ""


def _prune(today):
    cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - KEEP_DAYS * 86400))
    for name in os.listdir(LOG_DIR):
        if name.startswith("extras-") and name.endswith(".log") and name[7:17] < cutoff:
            try:
                os.remove(os.path.join(LOG_DIR, name))
            except OSError:
                pass


def write_line(text):
    global _day
    now = time.localtime()
    day = time.strftime("%Y-%m-%d", now)
    stamp = time.strftime("%m-%d %H:%M:%S", now)
    try:
        with _lock:
            if day != _day:
                _day = day
                os.makedirs(LOG_DIR, exist_ok=True)
                _prune(day)
            with open(os.path.join(LOG_DIR, f"extras-{day}.log"), "a", encoding="utf-8") as f:
                f.write(f"{stamp} {text}\n")
    except OSError:
        pass


class _Tee:
    """包住原来的流：照常写出去，同时按行抄进当天的日志文件。"""

    def __init__(self, stream):
        self._stream = stream
        self._buf = ""

    def write(self, data):
        n = self._stream.write(data)
        self._buf += data
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            if line.strip():
                write_line(line.rstrip())
        return n

    def flush(self):
        self._stream.flush()

    def __getattr__(self, name):
        return getattr(self._stream, name)


class _QuietAccess(logging.Filter):
    def filter(self, record):
        args = record.args if isinstance(record.args, tuple) else ()
        # uvicorn.access 的 args：(client, method, path, http_version, status)
        if len(args) >= 5 and args[4] == 200 and str(args[2]).split("?")[0] in QUIET_PATHS:
            return False
        return True


def install():
    if not isinstance(sys.stdout, _Tee):
        sys.stdout = _Tee(sys.stdout)
    if not isinstance(sys.stderr, _Tee):
        sys.stderr = _Tee(sys.stderr)
    logging.getLogger("uvicorn.access").addFilter(_QuietAccess())
