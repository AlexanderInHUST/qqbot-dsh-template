"""Sandbox file reader (2026-11-16): turns a file people sent her into text or a page picture.

qq-bridge keeps her files (src/app/files.js) but never opens untrusted documents itself: it POSTs the bytes
here (through mcp-gw:8934) and gets plain text back. Parsing runs in a child process with a memory limit and a
timeout, on a temp file in /tmp (tmpfs), so a hostile or broken file can at worst kill that child inside the
sandbox, which has no secrets and no way to reach the bridge. No tool here opens a URL or runs anything else.

POST /text?type=pdf|docx|xlsx|pptx   body: the file → {"ok", "text", "pages"?}
POST /page?type=pdf&page=N           body: the file → {"ok", "png": base64, "pages"}
"""

import base64
import json
import os
import resource
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("FILE_PARSE_PORT", "8934"))
MAX_BYTES = 60 * 1024 * 1024
MAX_TEXT = 400_000
TIMEOUT = 60
MEM_LIMIT = 1024 * 1024 * 1024
KINDS = ("pdf", "docx", "xlsx", "pptx")
SLOTS = threading.BoundedSemaphore(2)


def _limits():
    resource.setrlimit(resource.RLIMIT_AS, (MEM_LIMIT, MEM_LIMIT))
    resource.setrlimit(resource.RLIMIT_CPU, (TIMEOUT, TIMEOUT))
    resource.setrlimit(resource.RLIMIT_FSIZE, (200 * 1024 * 1024, 200 * 1024 * 1024))


def _run(args, timeout=TIMEOUT):
    env = {"PATH": "/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8"}
    return subprocess.run(args, env=env, capture_output=True, timeout=timeout, preexec_fn=_limits, check=True).stdout


def _pdf_pages(path):
    out = _run(["/usr/bin/pdfinfo", path], 20).decode("utf-8", "replace")
    for line in out.splitlines():
        if line.startswith("Pages:"):
            return int(line.split(":", 1)[1].strip() or 0)
    return 0


def _text(kind, path):
    if kind == "pdf":
        pages = _pdf_pages(path)
        text = _run(["/usr/bin/pdftotext", "-enc", "UTF-8", "-l", "300", path, "-"]).decode("utf-8", "replace")
        return {"text": text.replace("\f", "\n\n"), "pages": pages}
    # docx / xlsx / pptx: the python libraries, in a child with the same limits
    out = _run([sys.executable, "-I", os.path.abspath(__file__), "--extract", kind, path])
    return json.loads(out)


def _page(path, page):
    pages = _pdf_pages(path)
    if not 1 <= page <= max(pages, 1):
        raise ValueError(f"只有 {pages} 页")
    with tempfile.TemporaryDirectory(dir="/tmp") as d:
        _run(["/usr/bin/pdftoppm", "-png", "-r", "110", "-scale-to", "1600", "-f", str(page), "-l", str(page),
              "-singlefile", path, os.path.join(d, "p")])
        with open(os.path.join(d, "p.png"), "rb") as f:
            return {"png": base64.b64encode(f.read()).decode(), "pages": pages}


def _extract(kind, path):
    """Runs in the child process. Text only: no macros, no embedded objects, no links followed."""
    parts = []
    if kind == "docx":
        import docx
        d = docx.Document(path)
        for p in d.paragraphs:
            parts.append(p.text)
        for t in d.tables:
            for row in t.rows:
                parts.append(" | ".join(c.text.strip() for c in row.cells))
    elif kind == "xlsx":
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        for ws in wb.worksheets:
            parts.append(f"【{ws.title}】")
            for n, row in enumerate(ws.iter_rows(values_only=True)):
                if n >= 2000:
                    parts.append("……（后面还有很多行）")
                    break
                cells = ["" if v is None else str(v) for v in row]
                while cells and not cells[-1]:
                    cells.pop()
                if cells:
                    parts.append(" | ".join(cells))
    elif kind == "pptx":
        import pptx
        for n, slide in enumerate(pptx.Presentation(path).slides, 1):
            parts.append(f"【第 {n} 页】")
            for shape in slide.shapes:
                if shape.has_text_frame:
                    parts.append(shape.text_frame.text)
    text = "\n".join(parts)
    print(json.dumps({"text": text[:MAX_TEXT]}, ensure_ascii=False))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write("[file-parse] " + (fmt % args) + "\n")

    def _reply(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        kind = (q.get("type") or [""])[0]
        size = int(self.headers.get("content-length") or 0)
        if url.path not in ("/text", "/page") or kind not in KINDS or (url.path == "/page" and kind != "pdf"):
            return self._reply(404, {"ok": False, "error": "不支持"})
        if not 0 < size <= MAX_BYTES:
            return self._reply(413, {"ok": False, "error": "文件太大"})
        if not SLOTS.acquire(timeout=120):
            return self._reply(503, {"ok": False, "error": "忙"})
        try:
            with tempfile.NamedTemporaryFile(dir="/tmp", suffix="." + kind) as f:
                left = size
                while left:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
                f.flush()
                if url.path == "/page":
                    out = _page(f.name, int((q.get("page") or ["1"])[0]))
                else:
                    out = _text(kind, f.name)
                    out["text"] = str(out.get("text") or "")[:MAX_TEXT]
            self._reply(200, {"ok": True, **out})
        except subprocess.TimeoutExpired:
            self._reply(200, {"ok": False, "error": "文件太复杂，打不开"})
        except subprocess.CalledProcessError:
            self._reply(200, {"ok": False, "error": "文件打不开（可能坏了或加了密码）"})
        except Exception as error:  # noqa: BLE001
            self._reply(200, {"ok": False, "error": str(error)[:200]})
        finally:
            SLOTS.release()


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--extract":
        _extract(sys.argv[2], sys.argv[3])
    else:
        ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
