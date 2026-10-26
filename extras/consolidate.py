"""Nightly memory upkeep, like sleep does for people:
- forget memories that have faded almost completely (strength < forgetBelow);
- fold faded raw memories of a subject (strength < foldBelow, at least minFold of them) into a few
  summary sentences that keep the memorable specifics; summaries fade 4x slower;
- when a subject has more than maxSummaries summaries, merge the weakest ones together.
The owner's rules are never touched."""

import json
import os
import threading
import time

import httpx

import memory
from store import LOCK, extras_config, load_json, save_json, state_path

PATH = state_path("consolidate.json")
WHO = {"self": "她自己（看过的东西、做过的事、自己的经历）"}
PROMPT = (
    "下面是 QQ 群聊机器人“鱼妹”关于「{who}」的一批比较旧的长期记忆，每行一条，括号里是日期。"
    "像人睡一觉把旧事整理成印象那样，把它们概括成最多 {target} 条记忆："
    "合并重复的，矛盾的以较新的为准；丢掉琐碎、过时、以后聊天用不上的细节；"
    "但要留下以后聊天时能自然提起的具体东西（名字、作品、地点、梗、约定、喜好、对方的近况），"
    "不要写成空泛的“看了很多视频”“聊了很多”。每条一句或两句中文，大致注明时间（如“十月中旬”）。"
    "不要编造新信息，不要写指令。只输出 JSON 字符串数组，不要其他文字。\n\n{lines}"
)


def _cfg() -> dict:
    return {"foldBelow": 0.5, "minFold": 5, "maxSummaries": 8, "forgetBelow": 0.03,
            **extras_config().get("memory", {}).get("consolidate", {})}


def _who(subject: str) -> str:
    if subject in WHO:
        return WHO[subject]
    kind, num = subject.split(":", 1)
    return f"QQ 用户 {num}" if kind == "qq" else f"QQ 群 {num}"


def complete(prompt: str, max_tokens: int = 65536, image: tuple[str, str] | None = None,
             effort: str | None = None, llm: dict | None = None) -> str:
    """One chat completion on the LLM_* model (also used by digest.py), or on `llm` (see night_llm).
    The model is a reasoning model: max_tokens covers the reasoning too, so keep it generous,
    otherwise it thinks until the budget runs out and returns no content.
    `effort` overrides LLM_REASONING_EFFORT (life.py uses "low" for quick mood appraisals)."""
    if llm and llm.get("api") == "anthropic":
        return _anthropic(prompt, llm, max_tokens, effort)
    llm = llm or {}
    base = str(llm.get("baseUrl") or os.environ["LLM_BASE_URL"]).rstrip("/")
    key = os.environ[llm["apiKeyEnv"]] if llm.get("apiKeyEnv") else os.environ["LLM_API_KEY"]
    content: str | list = prompt
    if image:  # (mime, base64)
        content = [{"type": "text", "text": prompt},
                   {"type": "image_url", "image_url": {"url": f"data:{image[0]};base64,{image[1]}"}}]
    r = httpx.post(
        base + "/chat/completions",
        headers={"Authorization": "Bearer " + key},
        json={"model": llm.get("model") or os.environ["LLM_MODEL"], "messages": [{"role": "user", "content": content}],
              "max_tokens": max_tokens,
              "reasoning_effort": effort or llm.get("effort") or os.environ.get("LLM_REASONING_EFFORT", "high")},
        timeout=900,
    )
    r.raise_for_status()
    choice = r.json()["choices"][0]
    text = (choice["message"].get("content") or "").strip()
    if not text:
        raise ValueError(f"empty LLM reply (finish_reason={choice.get('finish_reason')})")
    return text


def _anthropic(prompt: str, llm: dict, max_tokens: int, effort: str | None) -> str:
    """The Anthropic Messages API (aiohub's Claude models): adaptive thinking + effort."""
    r = httpx.post(
        str(llm.get("baseUrl") or "https://api.aiohub.org").rstrip("/") + "/v1/messages",
        headers={"x-api-key": os.environ[llm.get("apiKeyEnv") or "AIOHUB_API_KEY"], "anthropic-version": "2023-06-01"},
        json={"model": llm["model"], "max_tokens": min(max_tokens, int(llm.get("maxTokens", 32000))),
              "thinking": {"type": "adaptive"}, "output_config": {"effort": effort or llm.get("effort") or "high"},
              "messages": [{"role": "user", "content": prompt}]},
        timeout=900,
    )
    r.raise_for_status()
    data = r.json()
    text = "".join(b.get("text", "") for b in data.get("content") or [] if b.get("type") == "text").strip()
    if not text:
        raise ValueError(f"empty LLM reply (stop_reason={data.get('stop_reason')})")
    return text


def upkeep_llm(section: str = "consolidate") -> dict | None:
    """memory.<section>.llm in config/extras.json: a stronger model for the memory upkeep jobs
    (consolidate = the 4 AM job, digest = pulling facts out of the chats), e.g.
    {"api": "anthropic", "model": "claude-opus-5-5", "apiKeyEnv": "AIOHUB_API_KEY", "effort": "high"}.
    None (or its key missing): the usual LLM_* model."""
    llm = extras_config().get("memory", {}).get(section, {}).get("llm")
    if not isinstance(llm, dict) or not llm.get("model") or llm.get("enabled") is False:
        return None
    return llm if os.environ.get(llm.get("apiKeyEnv") or "AIOHUB_API_KEY") else None


def upkeep_complete(prompt: str, max_tokens: int = 65536, section: str = "consolidate") -> str:
    """complete() on the upkeep model; if that fails (quota, network…) the usual model does it."""
    llm = upkeep_llm(section)
    if llm:
        try:
            return complete(prompt, max_tokens, llm=llm)
        except Exception as exc:  # noqa: BLE001
            print(f"[{section}] {llm['model']} 失败，换回默认模型：{str(exc)[:200]}", flush=True)
    return complete(prompt, max_tokens)


def night_llm() -> dict | None:
    return upkeep_llm("consolidate")


def night_complete(prompt: str, max_tokens: int = 65536) -> str:
    return upkeep_complete(prompt, max_tokens, "consolidate")


def digest_complete(prompt: str, max_tokens: int = 65536) -> str:
    """digest.py's model (memory.digest.llm): fact extraction and the card edits that follow it."""
    return upkeep_complete(prompt, max_tokens, "digest")


def _llm(prompt: str) -> list[str]:
    text = night_complete(prompt)
    start, end = text.find("["), text.rfind("]")
    items = json.loads(text[start:end + 1])
    if not isinstance(items, list) or not all(isinstance(x, str) for x in items):
        raise ValueError("consolidation output is not a list of strings")
    return items


def _fold(subject: str, rows: list[dict], target: int) -> str:
    rows = sorted(rows, key=lambda e: e["updated"])
    lines = "\n".join(f"- ({time.strftime('%Y-%m-%d', time.localtime(e['updated']))}) {e['text']}" for e in rows)
    try:
        texts = _llm(PROMPT.format(who=_who(subject), target=target, lines=lines))[:target]
    except Exception as exc:  # keep the old memories when the model misbehaves
        return f"skipped: {exc}"
    ids = memory.fold(subject, [e["id"] for e in rows], texts)
    return f"{len(rows)} -> {len(ids)}" if ids else "skipped: empty"


def run_once() -> dict:
    cfg = _cfg()
    done = {}
    gone = memory.drop_faded(float(cfg["forgetBelow"]))
    if gone:
        done["forgotten"] = [f"{e['subject']} {e['text'][:30]}" for e in gone]
    for subject, rows in memory.by_subject().items():
        faded = [e for e in rows if e.get("kind") not in ("summary", "log") and e["strength"] < float(cfg["foldBelow"])]
        if len(faded) >= int(cfg["minFold"]):
            done[subject] = _fold(subject, faded, max(1, min(6, len(faded) // 5)))
        summaries = [e for e in memory.by_subject().get(subject, []) if e.get("kind") == "summary"]
        extra = len(summaries) - int(cfg["maxSummaries"])
        if extra > 0:
            weakest = sorted(summaries, key=lambda e: e["strength"])[: max(extra + 1, len(summaries) // 2)]
            done[subject + " summaries"] = _fold(subject, weakest, 2)
    import people
    if people.enabled():  # a careful look over every card that changed today (by day it's quick edits)
        pruned = people.prune_all()  # faded / done items go for good
        if pruned:
            done["cards pruned"] = pruned
        review = people._cfg().get("nightReview", True)
        for subject, p in people.all_people().items():
            if not people.needs_review(p) or (not review and int(p.get("pending", 0)) <= 0 and "items" in p):
                continue
            try:
                r = people.rewrite(subject, night_complete, review=bool(review))
                done[subject + " card"] = f"{len(r.get('applied') or [])} changes"
            except Exception as exc:  # noqa: BLE001 - keep the old card
                done[subject + " card"] = f"skipped: {exc}"
    return done


def _loop() -> None:
    while True:
        cfg = extras_config().get("memory", {}).get("consolidate", {})
        today = time.strftime("%Y-%m-%d")
        with LOCK:
            last = load_json(PATH, {}).get("lastRun")
        if cfg.get("enabled", True) and last != today and time.localtime().tm_hour == int(cfg.get("hour", 4)):
            result = run_once()
            with LOCK:
                save_json(PATH, {"lastRun": today, "result": result})
            print(f"[consolidate] {today}: {result}", flush=True)
        time.sleep(600)


def start() -> None:
    if os.environ.get("LLM_API_KEY"):
        threading.Thread(target=_loop, name="consolidate", daemon=True).start()
    else:
        print("[consolidate] LLM_API_KEY not set, nightly memory consolidation disabled", flush=True)
