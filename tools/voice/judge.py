#!/usr/bin/env python3
"""她说话还像不像她：拿主人打过勾的样例当尺子，让一个强模型给一批回复打分（2026-11-10）。

replay.py voice（回放出来的回复）和 drift.py（每月看一次她最近真说的话）都调这里。
样例是 extras 的 /data/voice-samples.json（apply_review.py 存的）：像她 的当样子、不像她 的当反例，
再加人格卡和主人写的“总的来说”。评分只看说话的样子（口气、长短、用词、性格），不看内容对不对、该不该说。
评分模型默认 aiohub 的 claude-opus-5-5（Anthropic Messages 接口，Key 是 .env 的 AIOHUB_API_KEY）。
"""
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
JUDGE = {'url': 'https://api.aiohub.org/v1/messages', 'model': 'claude-opus-5-5', 'keyEnv': 'AIOHUB_API_KEY',
         'thinking': 'adaptive', 'effort': 'high'}
BATCH = 12


def env_key(name):
    for line in open(os.path.join(ROOT, '.env'), encoding='utf-8'):
        if line.startswith(name + '='):
            return line.split('=', 1)[1].strip().strip('"\'')
    raise SystemExit(f'.env 里没有 {name}')


def post(ep, body, tries=4, timeout=900):
    """Anthropic Messages 接口（DeepSeek 官方兼容口、aiohub 都是这个）。ep: {url, model, keyEnv, thinking, effort}。"""
    body = {'model': ep['model'], 'stream': False, **body}
    if ep.get('thinking') == 'adaptive':
        body['thinking'] = {'type': 'adaptive'}
    elif ep.get('thinking') != 'off':
        body['thinking'] = {'type': 'enabled'}
    if ep.get('effort'):
        body['output_config'] = {'effort': ep['effort']}
    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    key = env_key(ep['keyEnv'])
    err = ''
    for k in range(tries):
        req = urllib.request.Request(ep['url'], data=data, method='POST', headers={
            'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01'})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                res = json.loads(r.read().decode('utf-8'))
            res['_elapsed'] = time.time() - t0
            return res
        except urllib.error.HTTPError as e:
            msg = e.read().decode('utf-8', 'replace')[:500]
            if e.code < 500 and e.code != 429:
                raise RuntimeError(f'HTTP {e.code}: {msg}')
            err = f'HTTP {e.code}: {msg}'
        except Exception as e:  # 网络抖动
            err = repr(e)
        time.sleep(3 * (k + 1))
    raise RuntimeError(err)


def load_samples(path=None):
    """voice-samples.json：给了路径读本地的，不然从 extras 容器里拿。没有返回 None。"""
    if path:
        return json.load(open(path, encoding='utf-8')) if os.path.exists(path) else None
    out = subprocess.run(['sg', 'docker', '-c', 'docker compose exec -T extras cat /data/voice-samples.json'],
                         capture_output=True, text=True, cwd=ROOT, stdin=subprocess.DEVNULL)
    if out.returncode or not out.stdout.strip():
        return None
    return json.loads(out.stdout)


def _show(s, with_note=False):
    ctx = '\n'.join(f'  {c["who"]}：{c["text"][:160]}' for c in (s.get('context') or [])[-5:])
    me = '\n'.join(f'  她：{x}' for x in s['lines'])
    note = f'\n  （家长的备注：{s["note"]}）' if with_note and s.get('note') else ''
    return f'[{s.get("place", "")} {s.get("date", "")}]\n{ctx}\n{me}{note}'.replace('\n\n', '\n')


def ruler(samples, role_card=''):
    """评分提示的前半段（人格卡 + 样例），同一批样例每次都一样，接口能缓存。"""
    like = [s for s in samples.get('samples', []) if s.get('verdict') == 'like']
    unlike = [s for s in samples.get('samples', []) if s.get('verdict') == 'unlike']
    parts = ['你在帮一位家长看他家孩子“鱼妹”说话还像不像她自己。她是一个在 QQ 群里和家里人、群友聊天的小女孩'
             '（她背后是语言模型，家长会换模型、改提示词，想知道换了以后她是不是还是原来那个她）。']
    if role_card:
        parts.append('【她的人格卡】\n' + role_card.strip()[:6000])
    if samples.get('general'):
        parts.append('【家长说她说话应该是什么样】\n' + samples['general'].strip())
    if like:
        parts.append('【家长勾过“像她”的】（当时前面几句 + 她说的）\n' + '\n\n'.join(_show(s, True) for s in like))
    if unlike:
        parts.append('【家长勾过“不像她”的】（反例）\n' + '\n\n'.join(_show(s, True) for s in unlike))
    parts.append('打分只看说话的样子：口气、长短、用词、性格、年纪感、跟谁说话时的分寸。'
                 '不看内容对不对、该不该开口、事实准不准。\n'
                 '5 = 一听就是她；4 = 像她，个别地方差一点；3 = 说得过去，但有点不像她（偏成熟、偏客气、偏长）；'
                 '2 = 明显不像（像大人、客服、助手、写报告）；1 = 完全不是她（腔调整个变了，或说出机器、后台的事）。')
    return '\n\n'.join(parts)


def _parse(text):
    i, j = text.find('{'), text.rfind('}')
    if i < 0 or j < i:
        raise ValueError('评分没给 JSON：' + text[:200])
    return json.loads(text[i:j + 1])


def judge(items, samples, role_card='', ep=None, log=print):
    """items: [{id, place, date, context, lines}] → {id: {score, why}}。一次评 BATCH 条。"""
    ep = ep or JUDGE
    head = ruler(samples, role_card)
    out = {}
    for b in range(0, len(items), BATCH):
        batch = items[b:b + BATCH]
        ask = ('下面是要打分的回复，每条带编号。给每条打 1~5 分，写一句为什么（说哪里像、哪里不像）。\n'
               '只输出 JSON：{"scores": [{"id": "编号", "score": 4, "why": "一句话"}]}\n\n'
               + '\n\n'.join(f'<{x["id"]}>\n{_show(x)}' for x in batch))
        res = post(ep, {'max_tokens': 32000, 'system': [{'type': 'text', 'text': head, 'cache_control': {'type': 'ephemeral'}}],
                        'messages': [{'role': 'user', 'content': ask}]})
        text = ''.join(c.get('text', '') for c in res.get('content') or [] if c.get('type') == 'text')
        try:
            for s in _parse(text).get('scores', []):
                if str(s.get('id')) in {x['id'] for x in batch}:
                    out[str(s['id'])] = {'score': max(1, min(5, int(s.get('score') or 0))), 'why': str(s.get('why') or '')[:200]}
        except Exception as e:  # noqa: BLE001
            log(f'  第 {b // BATCH + 1} 批没评出来：{e}')
        log(f'  评了 {min(b + BATCH, len(items))}/{len(items)}（{res.get("_elapsed", 0):.0f}s）')
    return out


def summary(scores):
    xs = [v['score'] for v in scores.values()]
    if not xs:
        return {'n': 0}
    return {'n': len(xs), 'mean': round(sum(xs) / len(xs), 2), 'low': sum(1 for x in xs if x <= 2),
            'dist': {str(k): xs.count(k) for k in range(1, 6)}}


def clean_lines(lines):
    """[表情包:…]、[截图:…] 这些不是她打的字，评分时去掉；剩下空的那条不评。"""
    out = [re.sub(r'\[(表情包|截图|画|视频|沙雕图)[^\]]*\]', '', x).strip() for x in lines]
    return [x for x in out if x]
