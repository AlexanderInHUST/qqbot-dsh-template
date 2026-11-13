#!/usr/bin/env python3
"""从 DSH 会话记录里挑她说过的话，给主人打勾“像她 / 不像她”（2026-11-10，“她的声音换了模型也是她”）。

用法（数据都在 /tmp/replay-eval，里面有聊天内容，别放进仓库）：
  python3 tools/voice/extract.py [--n 1.0] > /tmp/replay-eval/review/voice-candidates.json
  python3 tools/voice/extract.py --dir <fetch.sh 拷的目录> --since-days 30 --no-odd   # drift.py 用：按会话 key 起名的那份

会话记录是 tools/replay-eval 拷下来的 allsess/*.jsonl。每处会话按时间走一遍：唤醒快照（recent + messages）、
qq_wait_for_messages / 查消息的结果里的消息攒成“当时看到的”，她每次发话取前面最近 5 条当上下文，
她发的几句接在后面记成“我”。按会话分层、在时间上均匀地挑，再加几条看着可能不像她的（太长、说了机器的词），
好让主人也勾出几条反例。令牌、图片链接里的 rkey 都换掉。
"""
import argparse
import json
import os
import re
import sys
import time

DATA = os.environ.get('REPLAY_DATA', '/tmp/replay-eval')
ALL = os.path.join(DATA, 'allsess')
TOKEN = re.compile(r'[0-9a-f]{32,}', re.I)
RKEY = re.compile(r'rkey=[^&\s"]+')
MECH = re.compile(r'bridge|桥接|令牌|token|ownerQQ|管理端|控制台|后台|管理员|配置|唤醒|潜水|水位|seq|工具|MCP|会话|回合|DSH|deepseek|模型|提示词|系统提示', re.I)
SEND = ('qq_send_message', 'qq_reply', 'qq_send_burst', 'qq_send_group_message', 'qq_send_private_message')
SNAP = '【本次消息快照】'

# 会话 id 前 8 位 → (哪儿, 名字, 想挑几条)
PLAN = {
    '16665704': ('private:900000001', '爸爸私聊', 8),
    '1bb0ceec': ('private:900000001', '爸爸私聊', 4),
    '7b34552d': ('private:1600000002', '妈妈私聊', 4),
    '3a27b888': ('group:1100000001', '家里的小群', 16),
    'a1735a30': ('group:800000002', '大群', 7),
    'cd235616': ('group:1000000004', '另一个大群', 7),
    'e414785e': ('group:1100000003', '技术群', 4),
    '0b64af8d': ('play:main', '自由时间发进聊天', 6),
}
ODD = 6  # 另外挑几条“看着可能不像”的
# fetch.sh 拷出来的按 key 起名（group_1100000001.jsonl），这时按 key 定名字和条数
BY_KEY = {
    'private_900000001': ('爸爸私聊', 8), 'private_1600000002': ('妈妈私聊', 4), 'group_1100000001': ('家里的小群', 12),
    'group_800000002': ('大群', 4), 'group_1000000004': ('另一个大群', 4), 'group_1100000003': ('技术群', 4),
    'play_main': ('自由时间发进聊天', 4),
}


def mask(s):
    return RKEY.sub('rkey=…', TOKEN.sub('（令牌）', str(s)))


def as_msgs(v):
    if isinstance(v, str) and v.strip().startswith('['):
        try:
            v = json.loads(v)
        except Exception:
            pass
    v = v if isinstance(v, list) else [v] if v else []
    return [str(x.get('text', '') if isinstance(x, dict) else x) for x in v if (x.get('text') if isinstance(x, dict) else x)]


def text_of(blocks):
    return ''.join(b.get('text', '') for b in blocks or [] if b.get('type') == 'text')


def json_after(text, marker):
    i = text.find(marker)
    if i < 0:
        return None
    j = text.find('{', i)
    if j < 0:
        return None
    try:
        return json.JSONDecoder().raw_decode(text[j:])[0]
    except Exception:
        return None


def when(t):
    if isinstance(t, (int, float)) and t > 1e12:
        return time.strftime('%Y-%m-%d %H:%M', time.localtime(t / 1000))
    return str(t or '')


def chat_msgs(obj):
    """快照 / 工具结果里的消息列表（recent 在前，messages、newMessages 在后）。"""
    out = []
    if not isinstance(obj, dict):
        return out
    for field in ('recent', 'messages', 'newMessages'):
        for m in obj.get(field) or []:
            if isinstance(m, dict) and 'text' in m and ('sender' in m or m.get('isSelf')):
                out.append(m)
    return out


def walk(path, where):
    ctx, seen, samples, names = [], set(), [], {}

    peer = {'private:900000001': '爸爸', 'private:1600000002': '妈妈'}.get(where)

    def add(m):
        k = (m.get('messageId') or '', m.get('seq'), m.get('text'), str(m.get('time')))
        if k in seen:
            return
        seen.add(k)
        me = m.get('isSelf') or m.get('sender') == '我'
        # 她自己发的那几句发的时候已经记过了，快照里又给一遍
        if me and any(x['who'] == '我' and x['text'] == mask(m.get('text', ''))[:300] for x in ctx[-12:]):
            return
        ctx.append({'who': '我' if me else peer or str(m.get('sender') or '?'),
                    'text': mask(m.get('text', ''))[:300], 'time': when(m.get('time'))})
        del ctx[:-40]

    for line in open(path, encoding='utf-8'):
        o = json.loads(line)
        t, d = o['type'], o.get('data', {})
        if t == 'user/message':
            snap = json_after(text_of(d.get('content')), SNAP)
            for m in chat_msgs(snap):
                add(m)
        elif t == 'tool/call':
            names[d.get('callId')] = d.get('name', '')
            name = d.get('name', '').split('__')[-1]
            if name not in SEND:
                continue
            try:
                args = json.loads(d.get('arguments') or '{}')
            except Exception:
                continue
            lines = [mask(x) for x in as_msgs(args.get('messages', args.get('text', args.get('message'))))]
            if not lines:
                continue
            # 发失败重发的同一段不算两回
            if samples and samples[-1]['lines'] == lines:
                continue
            to = args.get('to') or args.get('key') or where
            samples.append({'at': o['time'], 'date': when(o['time']), 'to': mask(to),
                            'context': [] if where == 'play:main' else [dict(x) for x in ctx[-5:]],
                            'lines': lines})
            for x in lines:
                ctx.append({'who': '我', 'text': x[:300], 'time': when(o['time'])})
        elif t == 'tool/result':
            msg = d.get('message') or {}
            name = names.get(msg.get('toolCallId'), '').split('__')[-1]
            if name in SEND or not name.startswith('qq_'):
                continue
            try:
                obj = json.loads(text_of(msg.get('content')))
            except Exception:
                continue
            for m in chat_msgs(obj):
                add(m)
    return samples


def spread(items, n):
    """在时间上均匀地挑 n 条（头几天说得多，按条数均匀会全挤在前面）。"""
    if n <= 0:
        return []
    if len(items) <= n:
        return list(items)
    t0, t1 = items[0]['at'], items[-1]['at']
    left, out = list(items), []
    for i in range(n):
        want = t0 + (t1 - t0) * (i + 0.5) / n
        best = min(left, key=lambda s: abs(s['at'] - want))
        left.remove(best)
        out.append(best)
    return sorted(out, key=lambda s: s['at'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=float, default=1.0, help='每处想挑的条数乘这个数')
    ap.add_argument('--dir', help='fetch.sh 拷的目录（文件按会话 key 起名）；不给就用 allsess 和上面的 PLAN')
    ap.add_argument('--since-days', type=float, default=0, help='只挑最近几天的')
    ap.add_argument('--no-odd', action='store_true', help='不另挑“看着可能不像”的')
    a = ap.parse_args()
    out, odd_pool = [], []
    if a.dir:
        plan = []
        for f in sorted(os.listdir(a.dir)):
            name = f[:-6] if f.endswith('.jsonl') else ''
            if name in BY_KEY:
                label, want = BY_KEY[name]
                plan.append((name, os.path.join(a.dir, f), name.replace('_', ':', 1), label, want))
    else:
        files = {f.split('-')[1]: os.path.join(ALL, f) for f in os.listdir(ALL) if f.endswith('.jsonl')}
        plan = [(sid, files.get(sid), where, label, want) for sid, (where, label, want) in PLAN.items()]
    since = (time.time() - a.since_days * 86400) * 1000 if a.since_days else 0
    for sid, path, where, label, want in plan:
        if not path:
            print(f'没有会话 {sid}', file=sys.stderr)
            continue
        all_s = [s for s in walk(path, where) if s['at'] >= since]
        # 光“嗯”“哈哈”的不挑，看不出什么
        good = [s for s in all_s if sum(len(x) for x in s['lines']) >= 6]
        picked = spread(good, max(1, round(want * a.n)))
        for s in picked:
            s.update(where=where, place=label, pick='even')
        out.extend(picked)
        ids = {id(s) for s in picked}
        odd_pool.extend(dict(s, where=where, place=label) for s in good if id(s) not in ids and (
            sum(len(x) for x in s['lines']) > 140 or MECH.search(' '.join(s['lines']))))
        print(f'{label} {sid}：发了 {len(all_s)} 回，挑 {len(picked)}', file=sys.stderr)
    odd_pool.sort(key=lambda s: s['at'])
    for s in spread(odd_pool, 0 if a.no_odd else ODD):
        s['pick'] = 'odd'
        out.append(s)
    out.sort(key=lambda s: s['at'])
    for i, s in enumerate(out):
        s['id'] = f'v{i + 1:02d}'
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
    print(f'共 {len(out)} 条（其中看着可能不像的 {sum(s["pick"] == "odd" for s in out)} 条）', file=sys.stderr)


if __name__ == '__main__':
    main()
