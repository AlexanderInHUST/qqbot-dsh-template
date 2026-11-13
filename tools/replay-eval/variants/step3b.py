"""架构调整第 3 步 B（2026-11-08）：qq-chat-v2 的 34 个 QQ 工具换成 DSH 原生工具（只管调用它的这个聊天，不填 key、token）。

- 系统提示：qq-chat-v2 用工作区的 dsh/agent-presets/qq-chat-v2/agent.cordis.yml（STEP3_OLD=1 用 git HEAD 的那份当对照）；
- 工具表：去掉 mcp__snowluma__ 的同名工具，换成 src/qq-capabilities.js 生成的聊天那边的原生工具；
- tool_check 照插件：照填的 key、token 拿掉，key 不是这里就失败；其余参数按 schema 查。
自由时间场景（qq-play）不动，和 baseline 一样。
"""
import json
import os
import re
import subprocess

import yaml

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..')
QB = os.path.join(ROOT, 'qq-bridge')
OLD = os.environ.get('STEP3_OLD') == '1'
YML = 'qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml'

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
        js = ("import fs from 'node:fs';import {capabilitiesFor,capabilityEnabled,parametersOf} from './src/qq-capabilities.js';"
              "let cfg={};try{cfg=JSON.parse(fs.readFileSync('../config/qq-bridge/config.json','utf8'))}catch{};"
              "process.stdout.write(JSON.stringify(capabilitiesFor('chat').filter(c=>capabilityEnabled(c,cfg))"
              ".map(c=>({name:c.name,description:c.description(cfg),input_schema:parametersOf(c,cfg)}))))")
        out = subprocess.run(['node', '--input-type=module', '-e', js], cwd=QB, capture_output=True, text=True, check=True).stdout
        _cache['native'] = json.loads(out)
    return _cache['native']


def _chat(ctx):
    return ctx.get('preset') == 'qq-chat-v2' and ctx['key'] != 'play:main'


def system(ctx):
    if not _chat(ctx):
        return None
    return _prefix().replace('{{qq_role_card}}', ctx['role_card'].strip())


def tools(tools, ctx):
    if not _chat(ctx) or OLD:
        return tools
    names = {t['name'] for t in _native()}
    return [t for t in tools if not (t['name'].startswith('mcp__snowluma__') and t['name'].split('__')[-1] in names)] + _native()


def tool_check(full_name, inp, ctx):
    if not _chat(ctx) or OLD:
        return None
    names = {t['name'] for t in _native()}
    if full_name.startswith('mcp__snowluma__') and full_name.split('__')[-1] in names:
        # 线上这些 MCP 版藏了（hideTools），调了守卫告诉她新名字（qq-tool-restrict.mjs）
        bare = full_name.split('__')[-1]
        return f'Error: {full_name} 改名了，现在叫 {bare}（前面不带 mcp__snowluma__，不用填 key 和 token，别的参数照旧），用 {bare} 再调一次'
    t = next((t for t in _native() if t['name'] == full_name), None)
    if not t:
        return None
    if not isinstance(inp, dict):
        return '参数要是一个对象'
    claimed = inp.get('key')
    inp = {k: v for k, v in inp.items() if k not in ('key', 'token')}
    if claimed not in (None, '') and str(claimed) != ctx['key']:
        return (f"{full_name} 只管这个聊天（{ctx['key']}），不用填 key；要现在去别处说一句用 qq_send_elsewhere，"
                '要别处的你以后去做用 qq_tell_myself，这里都做不到就照实说')
    props, req = t['input_schema']['properties'], t['input_schema'].get('required', [])
    for k in inp:
        if k not in props:
            return f'{full_name} 没有参数 {k}'
    for k in req:
        if inp.get(k) is None:
            return f'缺参数 {k}'
    if full_name == 'qq_send_elsewhere' and not re.fullmatch(r'(group|private):\d+', str(inp.get('to'))):
        return 'to 要写成 group:群号 或 private:QQ号'
    return None
