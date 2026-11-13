"""架构调整第 3 步（2026-11-08）：qq-play 的 7 个 QQ 工具换成 DSH 原生工具（不填 key、token，发去哪写在 to 里）。

- 系统提示：qq-play 用工作区的 dsh/agent-presets/qq-play/agent.cordis.yml（STEP3_OLD=1 用 git HEAD 的那份当对照）；
- 工具表：去掉 mcp__snowluma__ 的那 7 个，换成 src/qq-capabilities.js 生成的原生工具（用 node 导出 schema）；
- tool_check 照插件的 checkArgs 查参数，填了 key/token、to 写错都当失败（线上就是这样退回的）。
聊天场景（qq-chat-v2）不动，和 baseline 一样。
"""
import json
import os
import re
import subprocess

import yaml

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..')
QB = os.path.join(ROOT, 'qq-bridge')
OLD = os.environ.get('STEP3_OLD') == '1'
YML = 'qq-bridge/dsh/agent-presets/qq-play/agent.cordis.yml'

_cache = {}


def _prefix():
    if 'prefix' not in _cache:
        text = (subprocess.run(['git', 'show', f'HEAD:{YML}'], cwd=ROOT, capture_output=True, text=True, check=True).stdout
                if OLD else open(os.path.join(ROOT, YML), encoding='utf-8').read())
        rows = yaml.safe_load(text)
        _cache['prefix'] = next(r for r in rows if r.get('id') == 'persona')['config']['prefix']
    return _cache['prefix']


def _native():
    if 'native' not in _cache:
        js = ("import fs from 'node:fs';import {capabilitiesFor,parametersOf} from './src/qq-capabilities.js';"
              "let cfg={};try{cfg=JSON.parse(fs.readFileSync('../config/qq-bridge/config.json','utf8'))}catch{};"
              "process.stdout.write(JSON.stringify(capabilitiesFor('play').map(c=>({name:c.name,description:c.description(cfg),input_schema:parametersOf(c)}))))")
        out = subprocess.run(['node', '--input-type=module', '-e', js], cwd=QB, capture_output=True, text=True, check=True).stdout
        _cache['native'] = json.loads(out)
    return _cache['native']


def _play(ctx):
    return ctx.get('preset') == 'qq-play' or ctx['key'] == 'play:main'


def system(ctx):
    if not _play(ctx):
        return None
    return _prefix().replace('{{qq_role_card}}', ctx['role_card'].strip())


def tools(tools, ctx):
    if not _play(ctx) or OLD:
        return tools
    names = {t['name'] for t in _native()}
    return [t for t in tools if t['name'].split('__')[-1] not in names or not t['name'].startswith('mcp__snowluma__')] + _native()


def tool_check(full_name, inp, ctx):
    if not _play(ctx) or OLD:
        return None
    if full_name.startswith('mcp__snowluma__') and full_name.split('__')[-1] in {t['name'] for t in _native()}:
        # 线上这些 MCP 版藏了（hideTools），调了守卫告诉她新名字（qq-tool-restrict.mjs）
        bare = full_name.split('__')[-1]
        return f'Error: {full_name} 改名了，现在叫 {bare}（前面不带 mcp__snowluma__，不用填 key 和 token，别的参数照旧），用 {bare} 再调一次'
    if full_name.startswith('mcp__'):
        return None
    t = next((t for t in _native() if t['name'] == full_name), None)
    if not t:
        return None
    props, req = t['input_schema']['properties'], t['input_schema']['required']
    for k in inp:
        if k not in props:
            return f"{full_name} 不用填 {k}{'，发到哪个聊天写在 to 里' if 'to' in props else ''}" if k in ('key', 'token') else f'{full_name} 没有参数 {k}'
    for k in req:
        if inp.get(k) is None:
            return f'缺参数 {k}'
    if 'to' in props and not re.fullmatch(r'(group|private):\d+', str(inp.get('to'))):
        return 'to 要写成 group:群号 或 private:QQ号'
    return None
