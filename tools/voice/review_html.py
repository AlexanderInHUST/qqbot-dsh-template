#!/usr/bin/env python3
"""给主人打勾的网页：一页两栏，“说话样例”（像她 / 不像她 / 跳过 + 备注）和“成长记录补挑”（勾上的存进成长记录）。

用法：
  python3 tools/voice/review_html.py [输出路径]      # 默认 鱼妹-打勾.html
读 /tmp/replay-eval/review/voice-candidates.json（extract.py 出的）、milestone-candidates.json 和 img/ 里的画。
打的勾存在浏览器的 localStorage 里，关了再开还在；打完点“导出”下载 鱼妹-打勾结果.json，
再用 tools/voice/apply_review.py 存进 extras。网页里有聊天原文，别放进仓库。
"""
import base64
import io
import json
import os
import sys

DATA = os.environ.get('REPLAY_DATA', '/tmp/replay-eval')
REVIEW = os.path.join(DATA, 'review')
OUT = sys.argv[1] if len(sys.argv) > 1 else '鱼妹-打勾.html'


def thumb(path, size=520):
    try:
        from PIL import Image
        im = Image.open(path).convert('RGB')
        im.thumbnail((size, size))
        buf = io.BytesIO()
        im.save(buf, 'JPEG', quality=80)
        data = buf.getvalue()
    except Exception:
        data = open(path, 'rb').read()
    return 'data:image/jpeg;base64,' + base64.b64encode(data).decode()


voice = json.load(open(os.path.join(REVIEW, 'voice-candidates.json'), encoding='utf-8'))
miles = json.load(open(os.path.join(REVIEW, 'milestone-candidates.json'), encoding='utf-8'))
imgs = {}
for m in miles:
    for f in m.get('images') or []:
        p = os.path.join(REVIEW, 'img', f)
        if os.path.exists(p) and f not in imgs:
            imgs[f] = thumb(p)

payload = json.dumps({
    'voice': [{k: s[k] for k in ('id', 'date', 'place', 'context', 'lines')} for s in voice],
    'miles': [{k: m.get(k) for k in ('cid', 'date', 'kind', 'title', 'text', 'images', 'seen')} for m in miles],
    'imgs': imgs,
}, ensure_ascii=False).replace('</', '<\\/')

HTML = r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>鱼妹 · 打勾</title>
<style>
body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;margin:0;background:#f4f1ea;color:#333}
header{position:sticky;top:0;background:#fffaf0;border-bottom:1px solid #e3d9c6;padding:10px 18px;z-index:5;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
header h1{font-size:18px;margin:0 12px 0 0}
.tab{border:1px solid #c9b994;background:#fff;border-radius:16px;padding:5px 14px;cursor:pointer;font-size:14px}
.tab.on{background:#e9a23b;color:#fff;border-color:#e9a23b}
.count{font-size:13px;color:#888}
button.export{margin-left:auto;background:#3b8a5a;color:#fff;border:0;border-radius:6px;padding:7px 16px;font-size:14px;cursor:pointer}
main{max-width:860px;margin:0 auto;padding:16px}
.intro{background:#fff;border-radius:10px;padding:12px 16px;margin-bottom:14px;font-size:14px;line-height:1.7}
.card{background:#fff;border-radius:10px;padding:12px 16px;margin-bottom:12px;box-shadow:0 1px 2px #0001;border-left:5px solid #ddd}
.card.yes{border-left-color:#3b8a5a}.card.no{border-left-color:#c0504d}.card.skip{border-left-color:#aaa;opacity:.75}
.meta{font-size:12px;color:#999;margin-bottom:6px}
.ctx{font-size:13px;color:#888;margin:2px 0;line-height:1.5}
.ctx b{color:#777;font-weight:normal}
.me{background:#fff3d6;border-radius:10px;padding:5px 10px;margin:4px 0 4px 40px;font-size:15px;line-height:1.55;white-space:pre-wrap}
.btns{margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btns label{border:1px solid #ccc;border-radius:14px;padding:3px 12px;cursor:pointer;font-size:14px;user-select:none}
.btns input[type=radio]{display:none}
.btns input:checked+span{font-weight:bold}
label.y:has(input:checked){background:#3b8a5a;color:#fff;border-color:#3b8a5a}
label.n:has(input:checked){background:#c0504d;color:#fff;border-color:#c0504d}
label.s:has(input:checked){background:#999;color:#fff;border-color:#999}
input.note{flex:1;min-width:200px;border:1px solid #ddd;border-radius:6px;padding:5px 8px;font-size:13px}
.mt{font-size:16px;font-weight:bold;margin:2px 0 6px}
.mtext{font-size:14px;line-height:1.7;width:100%;box-sizing:border-box;border:1px solid #eee;border-radius:6px;padding:6px 8px;font-family:inherit;resize:vertical}
.mimg{max-width:260px;border-radius:8px;margin:6px 6px 0 0}
.mrow{display:flex;gap:10px;align-items:center;margin:2px 0 6px}
.tick{font-size:14px;cursor:pointer;user-select:none;white-space:nowrap;border:1px solid #ccc;border-radius:14px;padding:3px 12px}
.tick input[type=checkbox]{transform:scale(1.4);margin:0 8px 0 2px;vertical-align:middle;cursor:pointer}
.card.yes .tick{background:#3b8a5a;color:#fff;border-color:#3b8a5a}
textarea.general{width:100%;box-sizing:border-box;min-height:70px;border:1px solid #ddd;border-radius:6px;padding:6px 8px;font-family:inherit;font-size:14px}
.hidden{display:none}
</style></head><body>
<header>
<h1>🐟 鱼妹 · 打勾</h1>
<span class="tab on" data-tab="voice">说话样例</span>
<span class="tab" data-tab="miles">成长记录补挑</span>
<span class="count" id="count"></span>
<button class="export" id="export">导出结果</button>
</header>
<main>
<section id="voice">
<div class="intro">这些是她以前在各处说过的话（灰字是当时前面的几句，黄底是她说的）。
看着<b>像她</b>就点“像她”，<b>不像她</b>（太像大人、太像机器、啰嗦、不是她会说的）就点“不像她”，拿不准就“跳过”。
备注随便写，比如“这句太老成”“这个口气对”。以后换模型、改提示词，就拿“像她”的当样子、“不像她”的当反例，看她说话变没变。<br>
打的勾浏览器会记着，关了再开还在。打完点右上角“导出结果”，把下载的文件告诉我就行。</div>
<div class="intro">总的来说，你觉得她说话应该是什么样（可以不写）：<br><textarea class="general" id="general"></textarea></div>
<div id="vlist"></div>
</section>
<section id="miles" class="hidden">
<div class="intro">这些是我从她 10-21 到 11-09 的日记、记忆和画里挑出来的“长大路上的事”。
<b>勾上的</b>存进她的成长记录（她自己能翻、聊天时偶尔想起来说“我第一次画画的时候……”）；不勾的就不存。
字可以直接改。以后每晚她自己会挑，你们觉得不对的在控制台删。<br>
“只在家里”的那几条，大群里她看不到、也不会说。</div>
<div id="mlist"></div>
</section>
</main>
<script id="data" type="application/json">__DATA__</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const KEY = 'yumei-review-v1';
const S = Object.assign({voice:{}, miles:{}, general:''}, JSON.parse(localStorage.getItem(KEY) || '{}'));
const save = () => { localStorage.setItem(KEY, JSON.stringify(S)); count(); };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const KINDS = {birthday:'生日', first:'第一次', family:'和家里人', owner:'爸爸妈妈说的', growth:'长大了', art:'作品', other:'其他'};

function count() {
  const v = Object.values(S.voice); const m = D.miles.filter(x => (S.miles[x.cid] || {}).tick);
  document.getElementById('count').textContent =
    `说话：像 ${v.filter(x => x.v === 'yes').length} · 不像 ${v.filter(x => x.v === 'no').length} · 看过 ${v.filter(x => x.v).length}/${D.voice.length}　成长记录：勾了 ${m.length}/${D.miles.length}`;
}

const vlist = document.getElementById('vlist');
for (const s of D.voice) {
  const st = S.voice[s.id] || (S.voice[s.id] = {});
  const c = el('div', 'card ' + (st.v || ''));
  c.appendChild(el('div', 'meta', `${s.id} · ${s.date} · ${s.place}`));
  for (const x of s.context) { const p = el('div', 'ctx'); p.appendChild(el('b', '', x.who + '：')); p.appendChild(document.createTextNode(x.text)); c.appendChild(p); }
  for (const l of s.lines) c.appendChild(el('div', 'me', l));
  const b = el('div', 'btns');
  for (const [v, cls, t] of [['yes', 'y', '像她'], ['no', 'n', '不像她'], ['skip', 's', '跳过']]) {
    const lab = el('label', cls); const r = el('input'); r.type = 'radio'; r.name = 'v-' + s.id; r.checked = st.v === v;
    r.onchange = () => { st.v = v; c.className = 'card ' + v; save(); };
    lab.appendChild(r); lab.appendChild(el('span', '', t)); b.appendChild(lab);
  }
  const n = el('input', 'note'); n.placeholder = '备注（可以不写）'; n.value = st.note || '';
  n.oninput = () => { st.note = n.value; save(); };
  b.appendChild(n); c.appendChild(b); vlist.appendChild(c);
}
const g = document.getElementById('general'); g.value = S.general || ''; g.oninput = () => { S.general = g.value; save(); };

const mlist = document.getElementById('mlist');
for (const m of D.miles) {
  const st = S.miles[m.cid] || (S.miles[m.cid] = {});
  const c = el('div', 'card ' + (st.tick ? 'yes' : ''));
  const homeOnly = !(m.seen || []).some(x => x && x !== '?' && !/^private:|^group:1100000001$/.test(x));
  c.appendChild(el('div', 'meta', `${m.date} · ${KINDS[m.kind] || m.kind || ''}${homeOnly ? ' · 只在家里' : ''}`));
  // 勾选框单独一个 label，标题框放在旁边（以前标题框也在 label 里、被一起放大，盖住了勾选框）
  const row = el('div', 'mrow');
  const tl = el('label', 'tick'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!st.tick;
  cb.onchange = () => { st.tick = cb.checked; c.className = 'card ' + (cb.checked ? 'yes' : ''); save(); };
  tl.appendChild(cb); tl.appendChild(document.createTextNode('存进去'));
  const title = el('input', 'note'); title.value = st.title ?? m.title; title.style.fontWeight = 'bold'; title.style.fontSize = '15px';
  title.oninput = () => { st.title = title.value; save(); };
  row.appendChild(tl); row.appendChild(title); c.appendChild(row);
  const ta = el('textarea', 'mtext'); ta.rows = 3; ta.value = st.text ?? m.text;
  ta.oninput = () => { st.text = ta.value; save(); };
  c.appendChild(ta);
  for (const f of m.images || []) if (D.imgs[f]) { const im = el('img', 'mimg'); im.src = D.imgs[f]; im.title = f; c.appendChild(im); }
  mlist.appendChild(c);
}

for (const t of document.querySelectorAll('.tab')) t.onclick = () => {
  for (const x of document.querySelectorAll('.tab')) x.classList.toggle('on', x === t);
  document.getElementById('voice').classList.toggle('hidden', t.dataset.tab !== 'voice');
  document.getElementById('miles').classList.toggle('hidden', t.dataset.tab !== 'miles');
  window.scrollTo(0, 0);
};

document.getElementById('export').onclick = () => {
  const out = {
    exportedAt: new Date().toISOString(), general: S.general || '',
    voice: D.voice.filter(s => (S.voice[s.id] || {}).v).map(s => ({id: s.id, verdict: S.voice[s.id].v, note: S.voice[s.id].note || ''})),
    miles: D.miles.map(m => { const st = S.miles[m.cid] || {}; return {cid: m.cid, tick: !!st.tick,
      ...(st.title != null && st.title !== m.title ? {title: st.title} : {}), ...(st.text != null && st.text !== m.text ? {text: st.text} : {})}; }),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], {type: 'application/json'}));
  a.download = '鱼妹-打勾结果.json'; a.click();
};
count();
</script></body></html>
'''

open(OUT, 'w', encoding='utf-8').write(HTML.replace('__DATA__', payload))
print(f'写好了：{OUT}（说话 {len(voice)} 条、成长记录 {len(miles)} 条、画 {len(imgs)} 张）')
