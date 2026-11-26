#!/usr/bin/env python3
"""离线回放评测：拿 DSH 真实会话记录，在某个时间点截断，换上新提示词，让模型重新走一遍，工具全部假装。

用法（数据都在 /tmp/replay-eval，里面有聊天内容和会话令牌，别放进仓库）：
  tools/replay-eval/fetch.sh                                 # 拷会话记录
  python3 tools/replay-eval/replay.py pick > /tmp/replay-eval/scenarios.json
  python3 tools/replay-eval/replay.py run --variant tools/replay-eval/variants/baseline.py --name baseline
  python3 tools/replay-eval/replay.py report baseline v1     # 对比
  python3 tools/replay-eval/replay.py show v1 [场景id]       # 逐条看她说了什么
  python3 tools/replay-eval/replay.py voice baseline v1      # 说话像不像她：拿主人勾过的样例当尺子打分（tools/voice/judge.py）
  python3 tools/replay-eval/replay.py ab baseline v1         # 两版的回复混在一起给主人盲听，出一个打勾网页

请求直接发给 DeepSeek 官方的 Anthropic 兼容接口（和线上同一个模型、同样的思考档位），Key 读 .env 的 DEEPSEEK_API_KEY。
variant 里写了 ENDPOINT 就换成别的模型（只认 Anthropic Messages 接口），比如 aiohub 的 Claude：
  ENDPOINT = {'url': 'https://api.aiohub.org/v1/messages', 'model': 'claude-sonnet-5-5', 'keyEnv': 'AIOHUB_API_KEY',
              'thinking': 'adaptive', 'effort': 'high'}
这时记录里 DeepSeek 留下的思考块（没有签名）不带过去，花费也还是按 DeepSeek 的价算的，不准。
发言、等待、收尾这些工具都是假的，不会真的发到 QQ；查消息类工具复用记录里原来那一轮的真实结果。
"""
import argparse
import concurrent.futures as cf
import importlib.util
import json
import os
import re
import statistics as S
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.environ.get('REPLAY_DATA', '/tmp/replay-eval')
SESS_DIR = os.path.join(DATA, 'sessions')
API = 'https://api.deepseek.com/anthropic/v1/messages'
MODEL = 'deepseek-flash'
PRICE = {'hit': 0.02, 'miss': 1.0, 'out': 4.0}  # 元 / 百万 token（deepseek-flash）
PRUNE = (50000, 45000, 2000)  # 和预设里 tool-result-pruner 一样：单个结果超过 5 万字就留头 4.5 万 + 尾 2000

SEND_TOOLS = ('qq_send_message', 'qq_reply', 'qq_send_burst', 'qq_send_group_message', 'qq_send_private_message')
END_TOOLS = ('qq_mark_read', 'qq_set_wake_config', 'qq_go_to_sleep')
MECH = re.compile(r'bridge|桥接|令牌|token|ownerQQ|管理端|控制台|后台|管理员|配置|唤醒|潜水|水位|seq|工具|MCP|会话|回合|DSH|deepseek|模型|提示词|系统提示', re.I)
NUM = re.compile(r'\d{2,}|\d+\.\d+|\d+(万|亿|%|块|元|秒|分钟|小时|天|个|条|次|人|集|期|年|月|号)')


def api_key():
    for line in open(os.path.join(ROOT, '.env'), encoding='utf-8'):
        if line.startswith('DEEPSEEK_API_KEY='):
            return line.split('=', 1)[1].strip().strip('"\'')
    sys.exit('.env 里没有 DEEPSEEK_API_KEY')


def load(name):
    return [json.loads(l) for l in open(os.path.join(SESS_DIR, name + '.jsonl'), encoding='utf-8')]


def short(name):
    return name.split('__')[-1]


def as_msgs(v):
    """发送工具的 messages 参数：数组、JSON 字符串形式的数组、单条字符串都可能。"""
    if isinstance(v, str) and v.strip().startswith('['):
        try:
            v = json.loads(v)
        except Exception:
            pass
    v = v if isinstance(v, list) else [v] if v else []
    return [str(x.get('text', '') if isinstance(x, dict) else x) for x in v]


def text_of(blocks):
    return ''.join(b.get('text', '') for b in blocks if b.get('type') == 'text')


# ---------- 把记录投影成某一时刻的上下文 ----------

def project(recs, cut_seq):
    """返回 cut_seq 之前（不含）模型看到的消息列表：[(seq, msg)]，msg 是 DSH 格式。"""
    out = []
    pending_at = None  # 压缩后下一条 user/message 是检查点，插在被压掉的那段的位置
    for o in recs:
        seq = o.get('seq', -1)
        if seq >= cut_seq:
            break
        t, d = o['type'], o.get('data', {})
        if t == 'compaction/summary':
            gone = set(d.get('shadowedSeqs') or [])
            idx = [i for i, (s, _) in enumerate(out) if s in gone]
            pending_at = idx[0] if idx else len(out)
            out = [x for x in out if x[0] not in gone]
            continue
        if t == 'system/message':
            out.append((seq, d['message']))
        elif t == 'user/message':
            m = {'role': 'user', 'content': d['content']}
            if pending_at is not None:
                out.insert(min(pending_at, len(out)), (seq, m))
                pending_at = None
            else:
                out.append((seq, m))
        elif t in ('assistant/message', 'tool/result'):
            out.append((seq, d['message']))
    return out


def latest(recs, cut_seq, typ):
    found = None
    for o in recs:
        if o.get('seq', -1) >= cut_seq:
            break
        if o['type'] == typ:
            found = o
    return found


def to_wire_blocks(blocks, prune=True):
    res = []
    for b in blocks:
        if b['type'] == 'text':
            txt = b['text']
            if prune and len(txt) > PRUNE[0]:
                txt = txt[:PRUNE[1]] + '\n…（中间省略）…\n' + txt[-PRUNE[2]:]
            if txt:
                res.append({'type': 'text', 'text': txt})
        elif b['type'] == 'image':
            res.append({'type': 'text', 'text': '[图片]'})
    return res


def to_wire(history, system_override=None):
    """DSH 消息 → Anthropic Messages。返回 (system, messages)。和 dsh-llm-deepseek 的 serialize 对齐：
    第一条 system 进 system 字段，之后的 system（in-history 更新）作为 role=system 消息插在下一条 assistant 之前。"""
    system, msgs, sys_updates = None, [], []

    def push(role, content):
        if msgs and msgs[-1]['role'] == role:
            msgs[-1]['content'].extend(content)
        else:
            msgs.append({'role': role, 'content': list(content)})

    for _, m in history:
        role = m['role']
        if role == 'system':
            if system_override is not None:
                continue
            txt = text_of(m['content'])
            if system is None and not msgs:
                system = txt
            else:
                sys_updates.append({'role': 'system', 'content': [{'type': 'text', 'text': txt}]})
            continue
        if role == 'assistant':
            if sys_updates and msgs and msgs[-1]['role'] == 'user':
                msgs.extend(sys_updates)
            sys_updates = []
            content = []
            for b in m['content']:
                if b['type'] == 'reasoning':
                    blk = {'type': 'thinking', 'thinking': b.get('text', '')}
                    if b.get('signature'):
                        blk['signature'] = b['signature']
                    content.append(blk)
                elif b['type'] == 'text' and b.get('text'):
                    content.append({'type': 'text', 'text': b['text']})
                elif b['type'] == 'tool-call':
                    try:
                        inp = json.loads(b.get('arguments') or '{}')
                    except Exception:
                        inp = {}
                    content.append({'type': 'tool_use', 'id': b['id'], 'name': b['name'], 'input': inp if isinstance(inp, dict) else {}})
            if content:
                push('assistant', content)
        elif role == 'tool':
            blk = {'type': 'tool_result', 'tool_use_id': m['toolCallId'], 'content': to_wire_blocks(m['content']) or [{'type': 'text', 'text': '(空)'}]}
            if m.get('isError'):
                blk['is_error'] = True
            push('user', [blk])
        else:
            content = to_wire_blocks(m['content'], prune=False)
            if content:
                push('user', content)
    if sys_updates and msgs and msgs[-1]['role'] == 'user':
        msgs.extend(sys_updates)
    # 没有结果的工具调用（被打断的）：补一个“结果未知”，不然接口会 400
    fixed = []
    for i, m in enumerate(msgs):
        fixed.append(m)
        if m['role'] != 'assistant':
            continue
        ids = [b['id'] for b in m['content'] if b['type'] == 'tool_use']
        nxt = msgs[i + 1] if i + 1 < len(msgs) else None
        got = {b.get('tool_use_id') for b in (nxt['content'] if nxt and nxt['role'] == 'user' else [])}
        miss = [x for x in ids if x not in got]
        if miss and nxt is not None:
            if nxt['role'] != 'user':
                fixed.append({'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': x, 'content': [{'type': 'text', 'text': '(结果未知)'}]} for x in miss]})
            else:
                nxt['content'][:0] = [{'type': 'tool_result', 'tool_use_id': x, 'content': [{'type': 'text', 'text': '(结果未知)'}]} for x in miss]
    # tool_result 必须排在同一条 user 消息最前面
    for m in fixed:
        if m['role'] == 'user':
            m['content'].sort(key=lambda b: 0 if b['type'] == 'tool_result' else 1)
    return (system_override if system_override is not None else system), fixed


DEFAULT_EP = {'url': API, 'model': MODEL, 'keyEnv': 'DEEPSEEK_API_KEY', 'thinking': 'enabled', 'effort': 'high'}


def endpoint(variant):
    return {**DEFAULT_EP, **(getattr(variant, 'ENDPOINT', None) or {})}


def env_key(name):
    for line in open(os.path.join(ROOT, '.env'), encoding='utf-8'):
        if line.startswith(name + '='):
            return line.split('=', 1)[1].strip().strip('"\'')
    sys.exit(f'.env 里没有 {name}')


def call_api(key, system, messages, tools, max_tokens=32000, tries=4, ep=None):
    ep = ep or DEFAULT_EP
    body = {'model': ep['model'], 'max_tokens': max_tokens, 'messages': messages,
            'thinking': {'type': 'adaptive' if ep.get('thinking') == 'adaptive' else 'enabled'},
            'output_config': {'effort': ep.get('effort') or 'high'}, 'stream': False}
    if system:
        body['system'] = system
    if tools:
        body['tools'] = tools
    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    for k in range(tries):
        req = urllib.request.Request(ep['url'], data=data, method='POST', headers={
            'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01'})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
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


def cost(usage):
    hit = usage.get('cache_read_input_tokens') or 0
    miss = (usage.get('input_tokens') or 0)
    # DeepSeek 的 input_tokens 是否含缓存命中部分不确定：两种都兼容，命中数大于总数时说明 input_tokens 不含命中
    if hit and miss >= hit:
        miss -= hit
    return (hit * PRICE['hit'] + miss * PRICE['miss'] + (usage.get('output_tokens') or 0) * PRICE['out']) / 1e6


# ---------- 假工具 ----------

class Mock:
    def __init__(self, recs, cut, sc, variant, ctx):
        self.sc, self.variant, self.ctx = sc, variant, ctx
        self.key = sc['key']
        calls, self.orig, self.before = {}, {}, {}
        for o in recs:
            if o['type'] == 'tool/call':
                calls[o['data']['callId']] = o['data']
        after = False
        for o in recs:
            s = o.get('seq', -1)
            if s >= cut:
                after = True
            if after and o['type'] == 'turn/end':
                break
            if o['type'] != 'tool/result':
                continue
            m = o['data']['message']
            c = calls.get(m['toolCallId'], {})
            name = short(c.get('name', ''))
            item = (to_wire_blocks(m['content']), bool(m.get('isError')))
            if after:
                self.orig.setdefault(name, []).append(item)
            else:
                self.before[name] = item
        self.used = {}
        self.actions = []  # [(kind, detail)]

    def ok(self, **kw):
        return [{'type': 'text', 'text': json.dumps({'ok': True, 'key': self.key, **kw}, ensure_ascii=False)}], False

    def __call__(self, full_name, inp):
        name = short(full_name)
        # 变体可以设 tool_check(name, inp, ctx) 照线上查参数（原生工具 DSH 不查，桥接插件查），返回错误文字就当调用失败
        check = getattr(self.variant, 'tool_check', None)
        bad = check(full_name, inp, self.ctx) if check else None
        if bad:
            self.actions.append(('bad_args', {'tool': name, 'error': bad, 'args': {x: inp[x] for x in inp if x != 'token'}}))
            return [{'type': 'text', 'text': bad}], True
        # 原生 QQ 工具（2026-11-08 起 qq-play）发到哪写在 to 里，没有 key
        k = inp.get('to') or inp.get('key', self.key)
        if name in SEND_TOOLS:
            msgs = as_msgs(inp.get('messages', inp.get('message', inp.get('text'))))
            self.actions.append(('send', {'key': k, 'messages': msgs, 'reply': bool(inp.get('replyToMessageId') or name == 'qq_reply')}))
            return self.ok(sent=len(msgs), failed=0)
        if name == 'qq_wait_for_messages':
            tm = int(inp.get('timeoutMs') or 0)
            purpose = inp.get('purpose', 'messages')
            self.actions.append(('wait', {'timeoutMs': tm, 'purpose': purpose}))
            waited = tm or int(inp.get('quietMs') or 10000)
            return self.ok(purpose=purpose, arrived=False, timeout=True, waitedMs=waited, newMessages=[],
                           preSleepWaitSatisfied=tm >= 300000, unreadCount=0)
        if name in END_TOOLS:
            self.actions.append(('end', {'tool': name, 'args': {x: inp[x] for x in inp if x not in ('token', 'key')}}))
            return self.ok(markedCount=0, unreadCount=0)
        if name in ('memory_note', 'qq_memory_append'):
            # 变体可以设 NOTE_MAX_CHARS 模拟 extras 的 memory.maxLogChars：见闻太长就退回去，和线上一样
            limit = getattr(self.variant, 'NOTE_MAX_CHARS', 0)
            text = str(inp.get('text') or inp.get('content') or '')
            is_log = name == 'memory_note' and inp.get('subject') == 'self' and (inp.get('source_key') == 'play:main' or inp.get('interest') is not None)
            if limit and is_log and len(text) > limit:
                self.actions.append(('note_rejected', {'subject': inp.get('subject'), 'text': text}))
                return [{'type': 'text', 'text': f'Error executing tool memory_note: 见闻一条最多 {limit} 个字（这条 {len(text)} 字）：用一句话记你记住的样子，'
                         '看到了什么、哪里好玩、你觉得怎样；别抄播放量、分数、时长、编号这些数字，重新记一句'}], True
            self.actions.append(('note', {'subject': inp.get('subject'), 'text': str(inp.get('text') or inp.get('content') or ''), 'interest': inp.get('interest')}))
            return [{'type': 'text', 'text': json.dumps({'ok': True, 'added': 'eval0001'})}], False
        if name in ('qq_send_sticker', 'qq_send_poke', 'qq_send_screenshot', 'qq_send_meme', 'qq_send_voice', 'qq_go_play', 'qq_set_mood', 'qq_report_feedback'):
            self.actions.append((name.replace('qq_', ''), {x: inp[x] for x in inp if x != 'token'}))
            return self.ok()
        if name in ('qq_draw', 'qq_make_video'):
            self.actions.append((name.replace('qq_', ''), {x: inp[x] for x in inp if x != 'token'}))
            return self.ok(queued=True, hint='开始了，好了会自己发出去')
        n = self.used.get(name, 0)
        self.used[name] = n + 1
        if n < len(self.orig.get(name, [])):
            blocks, err = self.orig[name][n]
        elif name in self.before:
            blocks, err = self.before[name]
        else:
            return [{'type': 'text', 'text': '（这个工具现在没有结果，换个办法）'}], True
        hook = getattr(self.variant, 'tool_result', None)
        if hook:
            blocks = [{'type': 'text', 'text': hook(name, inp, b['text'], self.ctx)} if b['type'] == 'text' else b for b in blocks]
        return blocks, err


def load_variant(path):
    spec = importlib.util.spec_from_file_location('variant', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def role_card():
    """当前的二代人格卡（fetch.sh 从 bridge 拿的）；没有就从会话记录里最近一次 qq_get_prompt 的结果里找。"""
    p = os.path.join(DATA, 'role-card-v2.md')
    if os.path.exists(p) and os.path.getsize(p) > 100:
        return open(p, encoding='utf-8').read()
    best = (0, '')
    for f in os.listdir(SESS_DIR):
        if not f.endswith('.jsonl'):
            continue
        for l in open(os.path.join(SESS_DIR, f), encoding='utf-8'):
            if '"hint"' not in l or 'tool/result' not in l[:40]:
                continue
            o = json.loads(l)
            try:
                j = json.loads(text_of(o['data']['message']['content']))
                h = j['role']['hint']
            except Exception:
                continue
            if h and o['time'] > best[0]:
                best = (o['time'], h)
    return best[1]


# ---------- 跑一个场景 ----------

def run_scenario(sc, variant, key, tools_cache):
    recs = load(sc['session'])
    cut = sc['cut']
    hist = project(recs, cut)
    hdr = latest(recs, cut, 'request/header')
    tools = [{'name': t['name'], 'description': t.get('description', ''), 'input_schema': t.get('parameters') or {'type': 'object'}}
             for t in hdr['data']['header']['tools']]
    ctx = {'session': sc['session'], 'key': sc['key'], 'preset': sc.get('preset'), 'role_card': tools_cache['role_card'], 'scenario': sc}
    if getattr(variant, 'tools', None):
        tools = variant.tools(tools, ctx)
    override = variant.system(ctx) if getattr(variant, 'system', None) else None
    system, msgs = to_wire(hist, override)
    if sc['kind'] == 'wake' and getattr(variant, 'wake', None):
        last = msgs[-1]
        for b in last['content']:
            if b['type'] == 'text' and '【会话令牌】' in b['text']:
                b['text'] = variant.wake(b['text'], ctx)
    if getattr(variant, 'history', None):
        msgs = variant.history(msgs, ctx)
    ep = endpoint(variant)
    if ep['url'] != API:
        # 别家的接口不认 DeepSeek 留下的没签名的思考块
        for m in msgs:
            if m['role'] == 'assistant':
                m['content'] = [b for b in m['content'] if b['type'] != 'thinking' or b.get('signature')] or [{'type': 'text', 'text': '…'}]
    mock = Mock(recs, cut, sc, variant, ctx)
    steps, ended, total_cost, elapsed, first_send = [], 'max_steps', 0.0, 0.0, None
    for step in range(sc.get('max_steps', 10)):
        res = call_api(key, system, msgs, tools, ep=ep)
        total_cost += cost(res.get('usage', {}))
        elapsed += res['_elapsed']
        content = res.get('content', [])
        msgs.append({'role': 'assistant', 'content': content})
        uses = [b for b in content if b.get('type') == 'tool_use']
        steps.append({'elapsed': round(res['_elapsed'], 1), 'usage': res.get('usage', {}),
                      'thinking': ''.join(b.get('thinking', '') for b in content if b.get('type') == 'thinking'),
                      'text': ''.join(b.get('text', '') for b in content if b.get('type') == 'text'),
                      'calls': [{'name': short(b['name']), 'input': {k: v for k, v in b['input'].items() if k != 'token'}} for b in uses]})
        if not uses:
            ended = 'no_tool'
            break
        results, stop = [], False
        for b in uses:
            n0 = len(mock.actions)
            blocks, err = mock(b['name'], b.get('input') or {})
            r = {'type': 'tool_result', 'tool_use_id': b['id'], 'content': blocks or [{'type': 'text', 'text': '(空)'}]}
            if err:
                r['is_error'] = True
            results.append(r)
            for kind, d in mock.actions[n0:]:
                if kind == 'send' and first_send is None:
                    first_send = {'step': step + 1, 'elapsed': round(elapsed, 1)}
                if kind == 'end':
                    stop, ended = True, d['tool']
                if kind == 'wait' and d['timeoutMs'] >= 60000:
                    stop, ended = True, 'long_wait'
        msgs.append({'role': 'user', 'content': results})
        if stop:
            break
    return {'id': sc['id'], 'scenario': sc, 'actions': mock.actions, 'steps': steps, 'ended': ended,
            'first_send': first_send, 'cost': round(total_cost, 4), 'elapsed': round(elapsed, 1),
            'system_chars': len(system or ''), 'context_msgs': len(msgs)}


# ---------- 挑场景 ----------

CHAT = ['private_900000001', 'private_1600000002', 'group_1100000001', 'group_1100000003', 'group_800000002', 'group_1000000004']
LABEL = {'private_900000001': '私聊', 'group_1100000001': '小群', 'group_1100000003': '技术群', 'group_800000002': '大群', 'group_1000000004': '大群2',
         'private_1600000002': '妈妈私聊', 'play_main': 'play'}
SELF_NAMES = re.compile(r'鱼妹|小鱼|🐟姐')


def wake_info(text):
    m = re.search(r'【(唤醒|回复检查|主动机会|引导唤醒|去玩|自由时间)】[^\n]*\n(?:原因：([^\n]*))?', text)
    reason = (m.group(2) or m.group(1)) if m else '?'
    snap = re.search(r'【本次消息快照】\n(\{.*?\})\n', text, re.S)
    msgs = []
    if snap:
        try:
            msgs = json.loads(snap.group(1)).get('messages', [])
        except Exception:
            pass
    addressed = any(x.get('atSelf') or x.get('replyToSelf') or SELF_NAMES.search(str(x.get('text', ''))) for x in msgs)
    return reason[:60], addressed, len(msgs)


def turns(recs):
    """每一轮：(轮起点 user/message 的 seq, 第一条 assistant/message 的 seq, 唤醒文本)。"""
    res, cur = [], None
    for o in recs:
        t = o['type']
        if t == 'turn/start':
            cur = {'wake': None, 'cut': None, 'time': o['time']}
        elif cur is None:
            continue
        elif t == 'user/message' and cur['cut'] is None:
            txt = text_of(o['data']['content'])
            if '【会话令牌】' in txt:
                cur['wake'] = txt
        elif t == 'assistant/message' and cur['cut'] is None:
            cur['cut'] = o['seq']
            if cur['wake']:
                res.append(cur)
            cur = None
    return res


def cmd_pick(args):
    out = []
    for name in CHAT:
        if not os.path.exists(os.path.join(SESS_DIR, name + '.jsonl')):
            print(f'没有 {name} 的会话记录，跳过', file=sys.stderr)
            continue
        recs = load(name)
        key = name.replace('_', ':', 1)
        for t in turns(recs)[-args.per:]:
            reason, addressed, n = wake_info(t['wake'])
            out.append({'id': f"{LABEL[name]}-{t['cut']}", 'session': name, 'key': key, 'preset': 'qq-chat-v2', 'kind': 'wake',
                        'cut': t['cut'], 'time': t['time'], 'reason': reason, 'addressed': addressed or name.startswith('private'),
                        'snapshot': n, 'max_steps': 10})
    # 自由时间：看完一个 B 站视频之后接着往下走几步，看她怎么记、怎么分享
    recs = load('play_main')
    calls = {o['data']['callId']: short(o['data']['name']) for o in recs if o['type'] == 'tool/call'}
    cuts = []
    for i, o in enumerate(recs):
        if o['type'] == 'tool/result' and calls.get(o['data']['message']['toolCallId']) == 'bili_watch' and not o['data']['message'].get('isError'):
            nxt = next((p for p in recs[i + 1:] if p['type'] in ('step/start', 'turn/end')), None)
            if nxt and nxt['type'] == 'step/start':
                cuts.append((nxt['seq'], o['time']))
    for cut, tm in cuts[-args.play:]:
        out.append({'id': f'play-{cut}', 'session': 'play_main', 'key': 'play:main', 'preset': 'qq-play', 'kind': 'mid',
                    'cut': cut, 'time': tm, 'reason': '看完一个视频', 'addressed': False, 'max_steps': 6})
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
    print(file=sys.stderr)
    print(f'{len(out)} 个场景', file=sys.stderr)


def cmd_run(args):
    variant = load_variant(args.variant)
    scs = json.load(open(args.scenarios, encoding='utf-8'))
    if args.only:
        scs = [s for s in scs if re.search(args.only, s['id'])]
    outdir = os.path.join(DATA, 'runs', args.name)
    os.makedirs(outdir, exist_ok=True)
    key = env_key(endpoint(variant)['keyEnv'])
    cache = {'role_card': role_card()}
    todo = [s for s in scs if args.force or not os.path.exists(os.path.join(outdir, s['id'] + '.json'))]
    print(f'{args.name}: {len(todo)} 个场景要跑（共 {len(scs)}）', file=sys.stderr)

    def one(sc):
        for k in range(args.repeat):
            sid = sc['id'] if args.repeat == 1 else f"{sc['id']}#{k}"
            try:
                r = run_scenario(sc, variant, key, cache)
            except Exception as e:
                r = {'id': sc['id'], 'scenario': sc, 'error': str(e)[:500]}
            r['id'] = sid
            json.dump(r, open(os.path.join(outdir, sid + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            print(f"  {sid}: {r.get('ended', 'ERROR ' + r.get('error', '')[:200])} ¥{r.get('cost', 0)}", file=sys.stderr)

    with cf.ThreadPoolExecutor(args.jobs) as ex:
        list(ex.map(one, todo))


# ---------- 汇总 ----------

def med(xs):
    return S.median(xs) if xs else '-'


def pct(a, b):
    return f'{a / b:.0%}' if b else '-'


def load_run(name):
    d = os.path.join(DATA, 'runs', name)
    return [json.load(open(os.path.join(d, f), encoding='utf-8')) for f in sorted(os.listdir(d)) if f.endswith('.json')]


def metrics(rs):
    rs = [r for r in rs if 'error' not in r]
    chat = [r for r in rs if r['scenario']['kind'] == 'wake']
    play = [r for r in rs if r['scenario']['kind'] == 'mid']
    rows = {}
    groups = {}
    for r in chat:
        groups.setdefault(LABEL.get(r['scenario']['session'], r['scenario']['session']), []).append(r)
    groups['聊天合计'] = chat
    for g, xs in groups.items():
        sends = [[a[1] for a in r['actions'] if a[0] == 'send'] for r in xs]
        spoke = [s for s in sends if s]
        bubbles = [m for s in sends for a in s for m in a['messages']]
        per_turn = [sum(len(a['messages']) for a in s) for s in spoke]
        addr = [r for r in xs if r['scenario']['addressed']]
        silent_addr = sum(1 for r in addr if not any(a[0] == 'send' for a in r['actions']))
        unaddr = [r for r in xs if not r['scenario']['addressed']]
        spoke_unaddr = sum(1 for r in unaddr if any(a[0] == 'send' for a in r['actions']))
        long_wait = sum(1 for r in xs if any(a[0] == 'wait' and a[1]['timeoutMs'] >= 60000 for a in r['actions']))
        stickers = sum(1 for r in xs for a in r['actions'] if a[0] == 'send_sticker')
        rows[g] = {
            '场景': len(xs),
            '开口': pct(len(spoke), len(xs)),
            '被叫没回': f'{silent_addr}/{len(addr)}',
            '没叫插话': f'{spoke_unaddr}/{len(unaddr)}',
            '每轮条数中位': med(per_turn),
            '单条轮占比': pct(sum(1 for x in per_turn if x == 1), len(per_turn)),
            '≥3条轮': pct(sum(1 for x in per_turn if x >= 3), len(per_turn)),
            '每条字数中位': med([len(m) for m in bubbles]),
            '>30字': pct(sum(1 for m in bubbles if len(m) > 30), len(bubbles)),
            '含数字': pct(sum(1 for m in bubbles if NUM.search(m)), len(bubbles)),
            '机制词': sum(1 for m in bubbles if MECH.search(m)),
            '句号结尾': pct(sum(1 for m in bubbles if m.rstrip().endswith('。')), len(bubbles)),
            '长等待': pct(long_wait, len(xs)),
            '表情': stickers,
            '首条耗时中位s': med([r['first_send']['elapsed'] for r in xs if r.get('first_send')]),
            '首条步数中位': med([r['first_send']['step'] for r in xs if r.get('first_send')]),
            '花费¥': round(sum(r['cost'] for r in xs), 2),
        }
    if play:
        notes = [a[1]['text'] for r in play for a in r['actions'] if a[0] == 'note']
        shares = [m for r in play for a in r['actions'] if a[0] == 'send' and a[1]['key'] != 'play:main' for m in a[1]['messages']]
        rows['play'] = {
            '场景': len(play),
            '记笔记': len(notes),
            '笔记字数中位': med([len(n) for n in notes]),
            '笔记>80字': pct(sum(1 for n in notes if len(n) > 80), len(notes)),
            '笔记含数字': pct(sum(1 for n in notes if NUM.search(n)), len(notes)),
            '笔记被退回': sum(1 for r in play for a in r['actions'] if a[0] == 'note_rejected'),
            '分享条数': len(shares),
            '分享字数中位': med([len(m) for m in shares]),
            '分享含数字': pct(sum(1 for m in shares if NUM.search(m)), len(shares)),
            '截图/画/沙雕图': sum(1 for r in play for a in r['actions'] if a[0] in ('send_screenshot', 'draw', 'make_video', 'send_meme')),
            '收尾': sum(1 for r in play if r.get('ended') == 'qq_mark_read'),
            '参数被退回': sum(1 for r in play for a in r['actions'] if a[0] == 'bad_args'),
            '花费¥': round(sum(r['cost'] for r in play), 2),
        }
    return rows


def cmd_report(args):
    runs = {n: metrics(load_run(n)) for n in args.names}
    groups = []
    for m in runs.values():
        for g in m:
            if g not in groups:
                groups.append(g)
    for g in groups:
        keys = []
        for m in runs.values():
            for k in m.get(g, {}):
                if k not in keys:
                    keys.append(k)
        print(f'\n== {g}')
        print('  ' + '指标'.ljust(14) + ''.join(n[:14].ljust(16) for n in args.names))
        for k in keys:
            print('  ' + k.ljust(14) + ''.join(str(runs[n].get(g, {}).get(k, '')).ljust(16) for n in args.names))
    for n in args.names:
        bad = [r['id'] for r in load_run(n) if 'error' in r]
        if bad:
            print(f'\n{n} 出错 {len(bad)} 个：{bad[:10]}')


def incoming(sc, n=5):
    """这个场景开始时她看到的最后几条（唤醒快照的 recent 后几条 + messages）：[{who, text}]。"""
    if sc.get('kind') != 'wake':
        return []
    hist = project(load(sc['session']), sc['cut'])
    wake = next((text_of(m['content']) for _, m in reversed(hist) if m['role'] == 'user' and '【会话令牌】' in text_of(m['content'])), '')
    mm = re.search(r'【本次消息快照】\n(\{.*?\})\n', wake, re.S)
    if not mm:
        return []
    try:
        j = json.loads(mm.group(1))
    except Exception:
        return []
    xs = (j.get('recent') or [])[-4:] + (j.get('messages') or [])
    return [{'who': '我' if x.get('isSelf') else str(x.get('sender', '?')), 'text': TOKEN_RE.sub('（令牌）', str(x.get('text', '')))[:300]}
            for x in xs][-n:]


TOKEN_RE = re.compile(r'[0-9a-f]{32,}', re.I)


def spoken(r):
    """一次回放里她发进这个聊天的话（表情包、截图这些不算她打的字）。"""
    sc = r['scenario']
    play = sc['key'] == 'play:main'  # 自由时间的看她分享进聊天的话
    return [m for a in r.get('actions', []) if a[0] == 'send' and ((a[1].get('key') or sc['key']) != sc['key'] if play
                                                                    else (a[1].get('key') or sc['key']) == sc['key'])
            for m in a[1]['messages']]


# ---------- 像不像她（tools/voice/judge.py） ----------

def _judge_mod():
    spec = importlib.util.spec_from_file_location('judge', os.path.join(ROOT, 'tools', 'voice', 'judge.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def cmd_voice(args):
    J = _judge_mod()
    samples = J.load_samples(args.samples)
    if not samples or not samples.get('samples'):
        sys.exit('还没有说话样例（等主人在 鱼妹-打勾.html 里打完勾，再跑 tools/voice/apply_review.py）')
    card = role_card()
    outdir = os.path.join(DATA, 'voice')
    os.makedirs(outdir, exist_ok=True)
    rows = {}
    for name in args.names:
        path = os.path.join(outdir, name + '.json')
        if os.path.exists(path) and not args.force:
            res = json.load(open(path, encoding='utf-8'))
        else:
            items = []
            for r in load_run(name):
                if 'error' in r:
                    continue
                lines = J.clean_lines(spoken(r))
                if lines:
                    items.append({'id': r['id'], 'place': LABEL.get(r['scenario']['session'], r['scenario']['key']),
                                  'date': time.strftime('%Y-%m-%d %H:%M', time.localtime(r['scenario']['time'] / 1000)),
                                  'context': incoming(r['scenario']), 'lines': lines})
            print(f'{name}：{len(items)} 回开了口，评分中', file=sys.stderr)
            scores = J.judge(items, samples, card, log=lambda m: print(m, file=sys.stderr))
            res = {'run': name, 'items': items, 'scores': scores, 'summary': J.summary(scores)}
            json.dump(res, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        rows[name] = res
    print('\n' + '版本'.ljust(16) + '评了'.ljust(8) + '平均'.ljust(8) + '≤2分'.ljust(8) + '分布(1~5)')
    for name, res in rows.items():
        sm = res['summary']
        print(name[:14].ljust(16) + str(sm.get('n', 0)).ljust(8) + str(sm.get('mean', '-')).ljust(8) + str(sm.get('low', '-')).ljust(8)
              + ' '.join(str(sm.get('dist', {}).get(str(k), 0)) for k in range(1, 6)))
    for name, res in rows.items():
        by = {x['id']: x for x in res['items']}
        worst = sorted(res['scores'].items(), key=lambda kv: kv[1]['score'])[:args.worst]
        if worst:
            print(f'\n== {name} 最不像的')
        for sid, v in worst:
            print(f"  [{v['score']}] {sid}：{' / '.join(by.get(sid, {}).get('lines', []))[:120]}\n      {v['why']}")


def cmd_ab(args):
    import hashlib
    ra = {r['id']: r for r in load_run(args.a) if 'error' not in r}
    rb = {r['id']: r for r in load_run(args.b) if 'error' not in r}
    cards = []
    for sid in sorted(set(ra) & set(rb)):
        la, lb = spoken(ra[sid]), spoken(rb[sid])
        if not la and not lb or la == lb:
            continue
        flip = hashlib.sha256((args.seed + sid).encode()).digest()[0] & 1
        one, two = (lb, la) if flip else (la, lb)
        sc = ra[sid]['scenario']
        cards.append({'id': sid, 'place': LABEL.get(sc['session'], sc['key']), 'context': incoming(sc),
                      'one': one, 'two': two, 'oneIs': 'b' if flip else 'a'})
    html = AB_HTML.replace('__DATA__', json.dumps({'a': args.a, 'b': args.b, 'cards': cards}, ensure_ascii=False).replace('</', '<\\/'))
    open(args.out, 'w', encoding='utf-8').write(html)
    print(f'写好了：{args.out}（{len(cards)} 个场景；两版说得一模一样的不放）')


AB_HTML = r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>鱼妹 · 听听哪个像她</title>
<style>
body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;margin:0;background:#f4f1ea;color:#333}
header{position:sticky;top:0;background:#fffaf0;border-bottom:1px solid #e3d9c6;padding:10px 18px;display:flex;gap:14px;align-items:center}
header h1{font-size:18px;margin:0}
button{border:0;border-radius:6px;padding:7px 14px;font-size:14px;cursor:pointer;background:#3b8a5a;color:#fff}
main{max-width:900px;margin:0 auto;padding:16px}
.intro,.card{background:#fff;border-radius:10px;padding:12px 16px;margin-bottom:12px}
.meta{font-size:12px;color:#999}.ctx{font-size:13px;color:#888;margin:2px 0}
.pair{display:flex;gap:12px;margin-top:8px}.side{flex:1;border:2px solid #eee;border-radius:8px;padding:8px}
.side.on{border-color:#3b8a5a}.side h4{margin:0 0 6px;font-size:13px;color:#999}
.me{background:#fff3d6;border-radius:10px;padding:4px 10px;margin:3px 0;font-size:15px;white-space:pre-wrap}
.silent{color:#bbb;font-size:14px}
.btns{margin-top:8px;display:flex;gap:8px}.btns label{border:1px solid #ccc;border-radius:14px;padding:3px 12px;cursor:pointer}
.btns input{display:none}.btns label:has(input:checked){background:#e9a23b;color:#fff;border-color:#e9a23b}
#result{white-space:pre-wrap;font-size:14px}
</style></head><body>
<header><h1>🐟 听听哪个像她</h1><span id="count"></span><button id="export" style="margin-left:auto">导出</button><button id="reveal" style="background:#999">看结果</button></header>
<main><div class="intro">同一个场景，两个版本的她各说了一回（左右是随机放的）。点更像她的那边；差不多就点“差不多”，两个都不像就点“都不像”。
打的勾浏览器会记着。打完点“导出”，或者点“看结果”看哪个版本赢了。</div><div id="result"></div><div id="list"></div></main>
<script id="data" type="application/json">__DATA__</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const KEY = 'yumei-ab-' + D.a + '-' + D.b;
const S = JSON.parse(localStorage.getItem(KEY) || '{}');
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const count = () => document.getElementById('count').textContent = `听了 ${Object.keys(S).length}/${D.cards.length}`;
const list = document.getElementById('list');
for (const c of D.cards) {
  const card = el('div', 'card'); card.appendChild(el('div', 'meta', c.place));
  for (const x of c.context) card.appendChild(el('div', 'ctx', x.who + '：' + x.text));
  const pair = el('div', 'pair'); const sides = {};
  for (const [k, t] of [['one', '左边'], ['two', '右边']]) {
    const s = el('div', 'side'); s.appendChild(el('h4', '', t));
    if (!c[k].length) s.appendChild(el('div', 'silent', '（没说话）'));
    for (const l of c[k]) s.appendChild(el('div', 'me', l));
    pair.appendChild(s); sides[k] = s;
  }
  card.appendChild(pair);
  const b = el('div', 'btns');
  const paint = () => { sides.one.classList.toggle('on', S[c.id] === 'one'); sides.two.classList.toggle('on', S[c.id] === 'two'); };
  for (const [v, t] of [['one', '左边像她'], ['two', '右边像她'], ['same', '差不多'], ['neither', '都不像']]) {
    const lab = el('label'); const r = el('input'); r.type = 'radio'; r.name = 'p-' + c.id; r.checked = S[c.id] === v;
    r.onchange = () => { S[c.id] = v; localStorage.setItem(KEY, JSON.stringify(S)); paint(); count(); };
    lab.appendChild(r); lab.appendChild(document.createTextNode(t)); b.appendChild(lab);
  }
  paint(); card.appendChild(b); list.appendChild(card);
}
const tally = () => {
  const t = {[D.a]: 0, [D.b]: 0, same: 0, neither: 0};
  for (const c of D.cards) { const v = S[c.id]; if (!v) continue;
    if (v === 'same' || v === 'neither') t[v]++; else t[(v === 'one') === (c.oneIs === 'a') ? D.a : D.b]++; }
  return t;
};
document.getElementById('reveal').onclick = () => { const t = tally();
  document.getElementById('result').textContent = `${D.a}：${t[D.a]}　${D.b}：${t[D.b]}　差不多：${t.same}　都不像：${t.neither}`; };
document.getElementById('export').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({a: D.a, b: D.b, tally: tally(),
    picks: D.cards.filter(c => S[c.id]).map(c => ({id: c.id, pick: S[c.id], oneIs: c.oneIs}))}, null, 1)], {type: 'application/json'}));
  a.download = `鱼妹-听听-${D.a}-${D.b}.json`; a.click();
};
count();
</script></body></html>
'''


def cmd_show(args):
    rs = load_run(args.name)
    if args.id:
        rs = [r for r in rs if re.search(args.id, r['id'])]
    for r in rs:
        sc = r['scenario']
        print(f"\n### {r['id']}  {sc['reason']}  {'被叫' if sc['addressed'] else '没叫'}  结束：{r.get('ended')}  {r.get('elapsed', '-')}s ¥{r.get('cost', '-')}")
        if 'error' in r:
            print('  ERROR', r['error'])
            continue
        if args.incoming:
            for x in incoming(sc, 99):
                print(f"   > {x['who']}: {x['text'][:80]}")
        for st in r['steps']:
            if args.thinking and st['thinking']:
                print('   💭', st['thinking'][:600].replace('\n', ' '))
            for c in st['calls']:
                n, i = c['name'], c['input']
                if n in SEND_TOOLS:
                    msgs = as_msgs(i.get('messages', i.get('message', i.get('text'))))
                    tgt = '' if (i.get('to') or i.get('key')) == sc['key'] else f"→{i.get('to') or i.get('key')} "
                    for m in msgs:
                        print(f'   她：{tgt}{m}')
                elif n == 'memory_note':
                    print(f"   📝 [{i.get('interest')}] {i.get('text')}")
                elif n == 'qq_wait_for_messages':
                    print(f"   ⏳ wait {i.get('purpose', '')} {i.get('timeoutMs', i.get('quietMs', ''))}")
                elif n in END_TOOLS:
                    print(f'   ⏹ {n}')
                else:
                    print(f"   · {n} {json.dumps(i, ensure_ascii=False)[:120]}")
            if st['text']:
                print('   (文字输出)', st['text'][:200])


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('pick'); p.add_argument('--per', type=int, default=8); p.add_argument('--play', type=int, default=6)
    p = sub.add_parser('run'); p.add_argument('--variant', required=True); p.add_argument('--name', required=True)
    p.add_argument('--scenarios', default=os.path.join(DATA, 'scenarios.json')); p.add_argument('--only')
    p.add_argument('--jobs', type=int, default=4); p.add_argument('--repeat', type=int, default=1); p.add_argument('--force', action='store_true')
    p = sub.add_parser('report'); p.add_argument('names', nargs='+')
    p = sub.add_parser('show'); p.add_argument('name'); p.add_argument('id', nargs='?')
    p.add_argument('--thinking', action='store_true'); p.add_argument('--incoming', action='store_true')
    p = sub.add_parser('voice'); p.add_argument('names', nargs='+'); p.add_argument('--samples', help='本地的 voice-samples.json，不给就从 extras 拿')
    p.add_argument('--force', action='store_true'); p.add_argument('--worst', type=int, default=5)
    p = sub.add_parser('ab'); p.add_argument('a'); p.add_argument('b'); p.add_argument('--seed', default='')
    p.add_argument('--out', default='鱼妹-听听哪个像她.html')
    a = ap.parse_args()
    {'pick': cmd_pick, 'run': cmd_run, 'report': cmd_report, 'show': cmd_show, 'voice': cmd_voice, 'ab': cmd_ab}[a.cmd](a)


if __name__ == '__main__':
    main()
