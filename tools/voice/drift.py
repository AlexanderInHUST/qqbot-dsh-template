#!/usr/bin/env python3
"""每月看一次她最近说的话还像不像她（2026-11-10，“她的声音换了模型也是她”）。

  python3 tools/voice/drift.py run       # 拷会话记录 → 挑她最近 30 天说的话 → 拿主人勾过的样例打分 → 写状态
  python3 tools/voice/drift.py status    # 一行：上次看的结果（scripts/yumei-power.sh status 也带着）
  python3 tools/voice/drift.py install   # 装 systemd 用户定时器 yumei-voice-drift（每月 1 号 06:10，Persistent）

只记日志和状态，不往群里说、不告诉她。平均分掉到 WARN_MEAN 以下、或者 ≤2 分的超过 WARN_LOW，状态写“注意”，
主人看到了再用 replay.py voice / ab 细看。会话记录拷在 ~/.cache/yumei-voice（有聊天内容，600 权限），
状态和每月的分数在 ~/.config/yumei-voice/{status,history.jsonl}。还没有样例（主人没打勾）就只记“还没有样例”。
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CONF = os.path.expanduser('~/.config/yumei-voice')
CACHE = os.path.expanduser('~/.cache/yumei-voice')
STATUS = os.path.join(CONF, 'status')
HISTORY = os.path.join(CONF, 'history.jsonl')
DAYS = 30
WARN_MEAN = 3.6
WARN_LOW = 0.15

sys.path.insert(0, HERE)
import judge as J  # noqa: E402


def write_status(state, note, **extra):
    os.makedirs(CONF, exist_ok=True)
    line = {'state': state, 'at': time.strftime('%Y-%m-%d %H:%M'), 'note': note, **extra}
    with open(STATUS, 'w', encoding='utf-8') as f:
        json.dump(line, f, ensure_ascii=False)
    print(f'[说话像不像她] {state} {note}')


def run():
    os.makedirs(CACHE, mode=0o700, exist_ok=True)
    os.chmod(CACHE, 0o700)
    sess = os.path.join(CACHE, 'sessions')
    samples = J.load_samples(os.environ.get('VOICE_SAMPLES'))  # 试的时候指到本地的一份
    if not samples or not samples.get('samples'):
        write_status('skip', '还没有说话样例（主人在 鱼妹-打勾.html 打完勾再跑 tools/voice/apply_review.py）')
        return 0
    r = subprocess.run([os.path.join(ROOT, 'tools/replay-eval/fetch.sh')], env={**os.environ, 'OUT': sess},
                       cwd=ROOT, capture_output=True, text=True)
    if r.returncode:
        write_status('fail', '会话记录没拷出来：' + (r.stderr or r.stdout).strip()[-200:])
        return 1
    r = subprocess.run([sys.executable, os.path.join(HERE, 'extract.py'), '--dir', sess, '--since-days', str(DAYS), '--no-odd'],
                       env={**os.environ, 'REPLAY_DATA': CACHE}, capture_output=True, text=True)
    if r.returncode:
        write_status('fail', '没挑出她说的话：' + r.stderr.strip()[-200:])
        return 1
    items = []
    ruler_lines = {tuple(J.clean_lines(s['lines'])) for s in samples['samples']}  # 样例本身不拿来评，不然自己比自己
    for s in json.loads(r.stdout):
        lines = J.clean_lines(s['lines'])
        if lines and tuple(lines) not in ruler_lines:
            items.append({**s, 'lines': lines})
    if len(items) < 8:
        write_status('skip', f'最近 {DAYS} 天她说的话太少（{len(items)} 回），这次不看')
        return 0
    card_path = os.path.join(CACHE, 'role-card-v2.md')
    card = open(card_path, encoding='utf-8').read() if os.path.exists(card_path) else ''
    try:
        scores = J.judge(items, samples, card)
    except Exception as e:  # noqa: BLE001
        write_status('fail', f'评分没跑成：{str(e)[:200]}')
        return 1
    sm = J.summary(scores)
    if not sm.get('n'):
        write_status('fail', '评分一条也没给出来')
        return 1
    day = time.strftime('%Y%m%d')
    detail = os.path.join(CACHE, f'drift-{day}.json')
    fd = os.open(detail, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump({'items': items, 'scores': scores, 'summary': sm}, f, ensure_ascii=False, indent=1)
    prev = None
    if os.path.exists(HISTORY):
        rows = [json.loads(x) for x in open(HISTORY, encoding='utf-8') if x.strip()]
        prev = rows[-1] if rows else None
    with open(HISTORY, 'a', encoding='utf-8') as f:
        f.write(json.dumps({'at': time.strftime('%Y-%m-%d'), **sm, 'samples': len(samples['samples'])}, ensure_ascii=False) + '\n')
    low_share = sm['low'] / sm['n']
    warn = sm['mean'] < WARN_MEAN or low_share > WARN_LOW or (prev and prev.get('mean') and sm['mean'] < prev['mean'] - 0.4)
    trend = f'，上次 {prev["mean"]}' if prev and prev.get('mean') else ''
    write_status('warn' if warn else 'ok', f'平均 {sm["mean"]} 分{trend}，≤2 分的 {sm["low"]}/{sm["n"]}；细看 {detail}',
                 mean=sm['mean'], low=sm['low'], n=sm['n'])
    # 最不像的几条只进日志（journalctl），不往哪儿发
    by = {x['id']: x for x in items}
    for sid, v in sorted(scores.items(), key=lambda kv: kv[1]['score'])[:5]:
        print(f"  [{v['score']}] {by[sid]['place']} {by[sid]['date']}：{' / '.join(by[sid]['lines'])[:100]} —— {v['why']}")
    return 0


def status():
    if not os.path.exists(STATUS):
        print('说话像不像她：还没看过')
        return 0
    s = json.load(open(STATUS, encoding='utf-8'))
    mark = {'ok': '', 'warn': '（注意）', 'fail': '（失败）', 'skip': '（没看）'}.get(s.get('state'), '')
    print(f'说话像不像她{mark}：{s.get("at")}  {s.get("note")}')
    return 0


def install():
    unit = os.path.expanduser('~/.config/systemd/user')
    os.makedirs(unit, exist_ok=True)
    open(os.path.join(unit, 'yumei-voice-drift.service'), 'w').write(
        f'[Unit]\nDescription=看看鱼妹说话还像不像她\n[Service]\nType=oneshot\nWorkingDirectory={ROOT}\n'
        f'ExecStart=/usr/bin/python3 {HERE}/drift.py run\nNice=10\n')  # 拷记录、读样例各自走 sg docker
    # 每月 1 号 06:10（凌晨备份之后）；Persistent：WSL 关着错过了下次开机补跑
    open(os.path.join(unit, 'yumei-voice-drift.timer'), 'w').write(
        '[Unit]\nDescription=每月看一次鱼妹说话还像不像她\n[Timer]\nOnCalendar=*-*-01 06:10\nPersistent=true\n'
        'RandomizedDelaySec=600\n[Install]\nWantedBy=timers.target\n')
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', 'yumei-voice-drift.timer'], check=True)
    subprocess.run(['systemctl', '--user', 'list-timers', 'yumei-voice-drift*', '--no-pager'])
    return 0


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd not in ('run', 'status', 'install'):
        sys.exit('用法：python3 tools/voice/drift.py run|status|install')
    sys.exit({'run': run, 'status': status, 'install': install}[cmd]())
