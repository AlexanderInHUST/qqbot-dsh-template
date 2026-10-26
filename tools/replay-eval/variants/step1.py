"""第一步（系统提示和记忆）：
- 系统提示换成新的 preset prefix，最前面是新人格卡（{{qq_role_card}}），不带 DSH 默认那些写代码的说明；
- 唤醒提示里去掉【当前角色】那行和“请先调用 qq_get_prompt 查看角色”；
- 主人标记从“管理员（主人 QQ …）”换成“主人（你的爸爸）”这种写法（快照、历史和工具结果里都换）。

环境变量：
  QB_WORK    qq-bridge 源码目录（读 dsh/agent-presets/<preset>/agent.cordis.yml），默认本仓库的 qq-bridge/
  STEP1_CARD 新人格卡（bridge 处理过的二代版本），默认 $REPLAY_DATA/role-card-v2.step1.md
"""
import os
import re

import yaml

QB = os.environ.get('QB_WORK', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'qq-bridge'))
DATA = os.environ.get('REPLAY_DATA', '/tmp/replay-eval')
CARD = os.environ.get('STEP1_CARD', os.path.join(DATA, 'role-card-v2.step1.md'))

_prefix_cache = {}


def _prefix(preset):
    if preset not in _prefix_cache:
        rows = yaml.safe_load(open(os.path.join(QB, 'dsh/agent-presets', preset, 'agent.cordis.yml'), encoding='utf-8'))
        persona = next(r for r in rows if r.get('id') == 'persona')
        _prefix_cache[preset] = persona['config']['prefix']
    return _prefix_cache[preset]


def system(ctx):
    preset = ctx.get('preset') or ('qq-play' if ctx['key'] == 'play:main' else 'qq-chat-v2')
    card = open(CARD, encoding='utf-8').read().strip()
    return _prefix(preset).replace('{{qq_role_card}}', card)


_ADMIN = re.compile(r'管理员（主人 QQ \d+(?:；这个群里叫他的名字，不叫(\S+?)，也别提他是你\S+?|，你的(\S+?))?）')


def _owner(text):
    def sub(m):
        if m.group(1):
            t = m.group(1)
            return f'主人（这个群里叫他的名字，不叫{t}，也别提他是你{t}）'
        if m.group(2):
            return f'主人（你的{m.group(2)}）'
        return '主人'
    return _ADMIN.sub(sub, text)


_ROLE_LINE = re.compile(r'【当前角色】[^\n]*\n\n?')
_BOOT = '请先调用 qq_get_prompt 查看角色、推荐值、可用工具和状态；'


def wake(text, ctx):
    text = _ROLE_LINE.sub('', text)
    text = text.replace(_BOOT, '需要推荐值、可用工具、表情和黑话时再调用 qq_get_prompt；')
    return _owner(text)


def history(msgs, ctx):
    for m in msgs:
        for b in m['content']:
            if b.get('type') == 'text':
                b['text'] = _owner(b['text'])
            elif b.get('type') == 'tool_result':
                for c in b.get('content') or []:
                    if c.get('type') == 'text':
                        c['text'] = _owner(c['text'])
    return msgs


def tool_result(name, inp, text, ctx):
    return _owner(text)


# extras 的 memory.maxLogChars（config/extras.json 里是 80）：见闻太长会被退回去
NOTE_MAX_CHARS = 80

_NOTE_DOC_ADD = ('\n见闻一条就一句话（最多 80 字）：看了什么、哪里好玩、你觉得怎样，像过几天还记得的样子；'
                 '\n不抄播放量、分数、时长、BV 号这些数字，不从头复述。太长会被退回来重记。')


def tools(tools, ctx):
    for t in tools:
        if t['name'].endswith('memory_note'):
            d = t.get('description', '').replace('聊完之后后台还会自动把聊天整理进长期记忆', '聊完之后聊天还会自动整理进长期记忆')
            t['description'] = d + _NOTE_DOC_ADD
    return tools
