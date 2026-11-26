"""说话 AI 味（2026-11-25）：AIF=old 用改之前拷出来的 preset 和人格卡，AIF=new 用工作区的 preset 和改过“说话”那条的人格卡。
old 的 preset 默认在 /tmp/aiflavor/<preset>.before.yml（改之前 cp 出来的），人格卡是 $REPLAY_DATA/card-old.md / card-new.md
（fetch.sh 拿的 role-card-v2.md 改一句：“一句 2~15 个字”换成“一件事会说明白”）。
new 还把回放里新调的 web_search / web_fetch 结果的 hint 换成新的 KID_HINT。工具表、唤醒提示、历史都用记录里原来的。
"""
import json
import os

import yaml

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..')
DATA = os.environ.get('REPLAY_DATA', '/tmp/replay-eval')
SIDE = os.environ.get('AIF', 'new')
# AIF_CARD=new：preset 用 AIF_OLD_DIR 里的旧版，人格卡和 hint 用新的（拿上一次部署的 preset 当基线时用）
CARD = os.environ.get('AIF_CARD', SIDE)
OLD_DIR = os.environ.get('AIF_OLD_DIR', '/tmp/aiflavor')
_cache = {}

OLD_HINT = '这是大人写的资料。跟人说的时候用你自己的话，像小孩子转述听来的，挑一两点最好懂的说，别照着念数字、百分比和专业词。'
NEW_HINT = '这是大人写的资料。人家问什么你就答什么，用你自己的话一两句说完：只挑最要紧的那一样，别把查到的名字、菜名、地址、时间、型号一串列出来，人家想知道更多会接着问。别照着念数字、百分比和专业词（人家就要一个数、一个电话的除外），也不用每句都加“我看到说”“大家说”。'


def system(ctx):
    preset = ctx.get('preset') or 'qq-chat-v2'
    if preset not in _cache:
        yml = (os.path.join(OLD_DIR, preset + '.before.yml') if SIDE == 'old'
               else os.path.join(ROOT, f'qq-bridge/dsh/agent-presets/{preset}/agent.cordis.yml'))
        rows = yaml.safe_load(open(yml, encoding='utf-8'))
        prefix = next(r for r in rows if r.get('id') == 'persona')['config']['prefix']
        card = open(os.path.join(DATA, f'card-{CARD}.md'), encoding='utf-8').read().strip()
        _cache[preset] = prefix.replace('{{qq_role_card}}', card)
    return _cache[preset]


def tool_result(name, inp, text, ctx):
    hint = OLD_HINT if CARD == 'old' else NEW_HINT
    if name not in ('web_search', 'web_fetch'):
        return text
    if OLD_HINT in text or NEW_HINT in text:
        return text.replace(OLD_HINT, hint).replace(NEW_HINT, hint)
    try:
        v = json.loads(text)
    except Exception:
        return text
    if isinstance(v, dict):
        v['hint'] = hint
        return json.dumps(v, ensure_ascii=False, indent=2)
    return text
