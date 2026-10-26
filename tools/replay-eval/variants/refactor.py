"""整体重构（2026-10-24）：
- 系统提示换成重构后的 qq-chat-v2 / qq-play（唤醒里的规矩挪进去了），最前面是现在的人格卡；
- 唤醒提示去掉挪走、删掉的段落（参与、表情包策略、首回复节奏、此刻状态、当前唤醒、参与度参考、沉睡前强制等待、
  行动前、引用、结尾那句“决定潜水前必须…”），原因换成重构版 wakeReasonTextV2 的说法，
  大群和 技术群的【这个群】换成“只在有人找你的时候说话”；快照后面那段说明也换成新的；
- 工具：snowluma 的按重构版 mcp-snowluma-safe.js 的名单和说明（hideTools 那 10 个藏起来），
  聊天会话看不到 play 的浏览器和 bili_watch，play 看不到聊天浏览器，所有 browser_run_code_unsafe 都藏；
- 主人标记沿用 step1 的写法。

环境变量：
  REFACTOR_CARD  人格卡（bridge 处理过的二代版本），默认 $REPLAY_DATA/role-card-v2.refactor.md
  REFACTOR_TOOLS 重构版工具名单，默认 $REPLAY_DATA/refactor-tools.json（{chat, play, snowluma:{name:{description,input_schema}}}）
"""
import importlib.util
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('REPLAY_DATA', '/tmp/replay-eval')
os.environ.setdefault('STEP1_CARD', os.environ.get('REFACTOR_CARD', os.path.join(DATA, 'role-card-v2.refactor.md')))

_spec = importlib.util.spec_from_file_location('step1', os.path.join(HERE, 'step1.py'))
step1 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(step1)

TOOLS = json.load(open(os.environ.get('REFACTOR_TOOLS', os.path.join(DATA, 'refactor-tools.json')), encoding='utf-8'))
REPLY_ONLY = {'group:800000002', 'group:1100000003'}
HOME = {'group:1100000001'}
NOTE_MAX_CHARS = step1.NOTE_MAX_CHARS

system = step1.system
history = step1.history
tool_result = step1.tool_result

REASON = {
    'private': '对方给你发了消息。',
    'atMention': '有人 @ 你或引用了你的消息，是在找你。',
    'nameMention': '有人叫到了你（可能是在找你，也可能只是提到你）。',
    'talkBack': '你刚才接了话的人又说话了，可能是在回你，也可能已经在跟别人聊。是在回你、问你，就接着聊（一般一条就够）；在跟别人说、在约游戏喊人上号、在发图斗图、或者话说完了，就 qq_mark_read 走开，别插进去。',
    'replyGate': '没人叫你，是这几句你可能想接（接你刚才的话、聊到你感兴趣的、有人在问）。想接、接得上，就像群友一样说一句（最多两条）；接不上、不感兴趣、话题过去了，就 qq_mark_read 走开。',
    'poke': '有人拍了一拍（看 [拍一拍] 事件，可能是你，也可能是别人）。拍你的可以回一句，或 qq_send_poke 拍回去；不想接就收尾。',
    'timeout': '你设的潜水时间到了，没别的事。想说就说，不想就重新设唤醒或 qq_mark_read。',
}
# 重构后不再有的唤醒原因：群里换成回复门控叫来的那种
GATE_LIKE = {'probability', 'question', 'keyword', 'groupHot', 'groupConfused', 'anyMessage'}

THIS_GROUP_REPLY_ONLY = ('【这个群】普通群，不是家里那个小群：这里你只在有人找你的时候说话（@你、引用你、叫你名字、接着回你的话），'
                         '不主动开话题、不插别人的话。大家在约游戏、喊人上号、自己聊、连着发图时，没人叫你就别凑进去，看完 qq_mark_read 就好；称呼按人格卡里大群的叫法。')

DROP_SECTIONS = ('【当前角色】', '【参与】', '【表情包策略', '【首回复节奏】', '【此刻状态】', '【当前唤醒】', '【参与度参考】',
                 '【沉睡前强制等待】', '【行动前】', '【引用：只在必要时用】', '【这个群】')
DROP_LINES = re.compile(r'^(?:你可以调用工具查看未读消息.*|这个群里只回找你的人；没人找你就安静。|如果群聊正热但没人叫你.*|原因：.*)$', re.M)

OLD_SNAP_TAIL = re.compile(r'以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages\(afterSeq=readThroughSeq\) 继续读取。[^\n]*')
NEW_SNAP_TAIL = '这就是这次的消息，不用再查（partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 接着读）。收尾时把 readThroughSeq 传给 qq_mark_read / qq_set_wake_config 的 throughSeq。'


def _sections(text):
    """按行首的【…】切段：[(标题, 段落文字)]，第一段可能没有标题。"""
    parts = re.split(r'(?m)^(?=【)', text)
    return [(re.match(r'【[^】]*】?', p).group(0) if p.startswith('【') else '', p) for p in parts]


def wake(text, ctx):
    key = ctx['key']
    reason = (re.search(r'^原因：(\S+)', text, re.M) or [None, ''])[1]
    out = []
    for head, body in _sections(text):
        if any(head.startswith(d) for d in DROP_SECTIONS):
            continue
        if head in ('【唤醒】', '【回复检查】'):  # 回复检查重构后没有了，按普通唤醒给
            base = reason.split(':')[0]
            if base in GATE_LIKE:
                base = 'replyGate'
            say = REASON.get(base) or ('看看这里在聊什么；这个群里只回找你的人，没人找你就 qq_mark_read。' if key in REPLY_ONLY
                                       else '看看这里在聊什么，有想说的就说，没有就 qq_mark_read。')
            body = DROP_LINES.sub('', body).rstrip('\n') if head == '【唤醒】' else f'【唤醒】{key}'
            body = f'{body}\n{say}\n\n'
            if key in REPLY_ONLY:
                out.append(THIS_GROUP_REPLY_ONLY + '\n\n')
        elif head == '【会话令牌】':
            body = re.sub(r'（调用二代状态工具时请在参数中带上此令牌）', '（工具都带上它）', body)
        out.append(body)
    text = ''.join(out)
    text = OLD_SNAP_TAIL.sub(NEW_SNAP_TAIL, text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return step1.wake(text, ctx)


def tools(tools, ctx):
    play = ctx['key'] == 'play:main'
    allowed = set(TOOLS['play' if play else 'chat'])
    out = []
    for t in tools:
        n = t['name']
        if n.endswith('browser_run_code_unsafe') or n == 'mcp__snowluma-host__snowluma_status':
            continue
        if n.startswith('mcp__snowluma__'):
            if n not in allowed:
                continue
            new = TOOLS['snowluma'].get(n[len('mcp__snowluma__'):])
            if new:
                t = {**t, 'description': new['description'], 'input_schema': new['input_schema']}
        elif play and n.startswith('mcp__sandbox-browser-chat__'):
            continue
        elif not play and (n.startswith('mcp__sandbox-browser__') or n.startswith('mcp__sandbox-desktop__') or n.endswith('__bili_watch')):
            continue
        out.append(t)
    return step1.tools(out, ctx)
