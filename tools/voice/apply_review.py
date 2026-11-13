#!/usr/bin/env python3
"""把主人在 鱼妹-打勾.html 里打的勾存进 extras（2026-11-10）。

用法：
  python3 tools/voice/apply_review.py [结果文件]      # 默认 鱼妹-打勾结果.json
  加 --dry-run 只看会存什么

- 说话样例：像她 / 不像她 的连同上下文存成 extras 的 /data/voice-samples.json（跳过的不存），
  以后 tools/replay-eval 的 voice 评分拿“像她”的当样子、“不像她”的当反例；会跟着每天的备份走。
- 成长记录：勾上的（带主人改过的字）调 milestones.import_ticked 存进去，10-21~11-09 这些天都记成看过了，
  每晚挑的时候不再从这些天里挑。存之前先把 /data/milestones.json 备份成 .bak-日期-补挑。
"""
import json
import os
import subprocess
import sys
import time

DATA = os.environ.get('REPLAY_DATA', '/tmp/replay-eval')
REVIEW = os.path.join(DATA, 'review')
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
DRY = '--dry-run' in sys.argv
RESULT = args[0] if args else '鱼妹-打勾结果.json'

res = json.load(open(RESULT, encoding='utf-8'))
voice = {s['id']: s for s in json.load(open(os.path.join(REVIEW, 'voice-candidates.json'), encoding='utf-8'))}
miles = {m['cid']: m for m in json.load(open(os.path.join(REVIEW, 'milestone-candidates.json'), encoding='utf-8'))}

samples = []
for v in res.get('voice') or []:
    s = voice.get(v.get('id'))
    if not s or v.get('verdict') not in ('yes', 'no'):
        continue
    samples.append({'id': s['id'], 'verdict': 'like' if v['verdict'] == 'yes' else 'unlike', 'note': v.get('note') or '',
                    'date': s['date'], 'where': s['where'], 'place': s['place'], 'context': s['context'], 'lines': s['lines']})
voice_doc = {'updatedAt': time.strftime('%Y-%m-%d %H:%M'), 'general': res.get('general') or '', 'samples': samples}

items = []
for x in res.get('miles') or []:
    m = miles.get(x.get('cid'))
    if not m or not x.get('tick'):
        continue
    items.append({**{k: m.get(k) for k in ('date', 'kind', 'title', 'text', 'from', 'images', 'seen')},
                  **({'title': x['title']} if x.get('title') else {}), **({'text': x['text']} if x.get('text') else {})})
days = sorted({m['date'] for m in miles.values()} | {time.strftime('%Y-%m-%d', time.localtime(t)) for t in
                                                     range(int(time.mktime(time.strptime('2026-10-21', '%Y-%m-%d'))),
                                                           int(time.mktime(time.strptime('2026-11-09', '%Y-%m-%d'))) + 1, 86400)})

like = sum(s['verdict'] == 'like' for s in samples)
print(f'说话样例：像她 {like}、不像她 {len(samples) - like}（存 {len(samples)} 条）；总的说法：{"有" if voice_doc["general"] else "没写"}')
print(f'成长记录：勾了 {len(items)}/{len(miles)}，看过的日子 {days[0]}~{days[-1]}（{len(days)} 天）')
for it in items:
    print(f'  {it["date"]} {it["title"]}')
if DRY:
    sys.exit(0)

CODE = r'''
import json, os, shutil, sys, time
sys.path.insert(0, "/opt/extras")
import milestones
from store import save_json, state_path
p = json.loads(PAYLOAD)
stamp = time.strftime("%Y%m%d")
if os.path.exists(milestones.PATH):
    shutil.copy2(milestones.PATH, f"{milestones.PATH}.bak-{stamp}-补挑")
vp = state_path("voice-samples.json")
if os.path.exists(vp):
    shutil.copy2(vp, f"{vp}.bak-{stamp}")
save_json(vp, p["voice"])
r = milestones.import_ticked(p["items"], p["days"])
print(json.dumps(r, ensure_ascii=False))
'''
payload = json.dumps({'voice': voice_doc, 'items': items, 'days': days}, ensure_ascii=False)
# 代码和数据一起从标准输入喂给容器里的 python（走 sg 的 sh -c，不好带引号）
script = f'PAYLOAD = {payload!r}\n' + CODE
env = ' '.join(f'-e {k}={os.environ[k]}' for k in ('EXTRAS_DATA_DIR',) if os.environ.get(k))  # 试的时候指到别的目录
cmd = ['sg', 'docker', '-c', f'docker compose exec -T -w /opt/extras {env} extras venv/bin/python -']
out = subprocess.run(cmd, input=script, text=True, capture_output=True, cwd=ROOT)
print(out.stdout.strip() or out.stderr.strip())
sys.exit(out.returncode)
