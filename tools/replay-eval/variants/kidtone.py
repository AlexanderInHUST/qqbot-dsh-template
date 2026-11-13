"""普通群聊大人的知识时像小孩（2026-11-10）：系统提示换成工作区的 qq-chat-v2（加了【帮人查东西】里“普通群里有人聊芯片、
股票财报……用你自己的话说，像小孩子转述听来的”那条），最前面是现在的人格卡（$REPLAY_DATA/role-card-v2.md）。
KID_OLD=<yml> 用那份 preset 当对照（比如改之前拷出来的 qq-chat-v2.before.yml），两边别的都一样。
工具表、唤醒提示、历史都用记录里原来的。
"""
import json
import os

import yaml

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..')
DATA = os.environ.get('REPLAY_DATA', '/tmp/replay-eval')
YML = os.environ.get('KID_OLD') or os.path.join(ROOT, 'qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml')
_cache = {}


def system(ctx):
    if 'sys' not in _cache:
        rows = yaml.safe_load(open(YML, encoding='utf-8'))
        prefix = next(r for r in rows if r.get('id') == 'persona')['config']['prefix']
        card = open(os.path.join(DATA, 'role-card-v2.md'), encoding='utf-8').read().strip()
        _cache['sys'] = prefix.replace('{{qq_role_card}}', card)
    return _cache['sys']

# KID_HINT=1：web_search / web_fetch 的结果里带一句 hint（线上 mcp-web-search-safe.js 的 KID_HINT），看放在用的地方管不管用
HINT = os.environ.get('KID_HINT') == '1'
HINT_TEXT = '这是大人写的资料。跟人说的时候用你自己的话，像小孩子转述听来的，挑一两点最好懂的说，别照着念数字、百分比和专业词。'


def tool_result(name, inp, text, ctx):
    if not HINT or name not in ('web_search', 'web_fetch'):
        return text
    try:
        v = json.loads(text)
    except Exception:
        return text + '\n\n' + HINT_TEXT
    if isinstance(v, dict):
        v['hint'] = HINT_TEXT
        return json.dumps(v, ensure_ascii=False, indent=2)
    return text
