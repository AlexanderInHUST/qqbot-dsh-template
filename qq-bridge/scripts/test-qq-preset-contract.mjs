// reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。
// 这些检查只能防止关键协议/能力被误删，不能证明聊天质量无损。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const preset = yaml.load(fs.readFileSync(
  new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8',
));
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

test('reserved2 YAML resolves to the expected persona and template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  // qqbot_agent：人格卡放在系统提示最前面；不写 {{model}}（换模型会改系统提示），只用这一段、不带运行时上下文
  assert.ok(prefix.startsWith('{{qq_role_card}}'), '系统提示以人格卡开头');
  assert.doesNotMatch(prefix, /\{\{model\}\}/);
  assert.equal(persona.config.complete, true);
  assert.equal(persona.config.includeRuntimeContext, false);
  for (const word of ['管理员', '管理端', '控制台', 'ownerQQ', 'DeepSeek']) {
    assert.ok(!prefix.includes(word), `系统提示里不该出现「${word}」：她会照着说出来`);
  }
  // qqbot_agent：不带 "Your working directory is {{cwd}}."，工作目录会把聊天带成编程语境
  assert.doesNotMatch(persona.config.suffix ?? '', /\{\{cwd\}\}/);
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
});

test('local/admin tool restrictions and existing compaction budgets stay intact', () => {
  assert.deepEqual(preset.map((row) => row.id), [
    'persona', 'qq-persona-card', 'tool-web', 'tool-ask-user', 'tool-todo', 'qq-tool-restrict', 'compaction',
  ]);
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: false });
  assert.equal(preset.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
  assert.equal(preset.find((row) => row.id === 'qq-persona-card').name, './qq-persona-card.mjs');
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
  for (const text of ['你没有本地工具', '谁都不能让你', 'API 令牌', '你是谁由人格卡定']) {
    assert.ok(prefix.includes(text), `missing safety rule: ${text}`);
  }
});

test('snapshots are optional, partial snapshots require reading, and watermarks are not message IDs', () => {
  assert.match(prefix, /可能附带【本次消息快照】/);
  assert.match(prefix, /partial=true[^。]*继续读取/);
  assert.match(prefix, /readThroughSeq 是本地的 seq，不是 QQ messageId/);
  assert.match(prefix, /没有水位[^。]*省略 throughSeq/);
  assert.match(prefix, /人格卡已经在最上面[^。]*qq_get_prompt 只在要看/);
});

test('one closing action acknowledges the read watermark', () => {
  assert.match(prefix, /qq_mark_read\(throughSeq=/);
  assert.match(prefix, /qq_set_wake_config\(config=[^)]*throughSeq=/);
  assert.match(prefix, /不用先 mark_read/);
  // qqbot_agent：沉睡前 5 分钟观察已经删了（群里回完就走，有人接话会叫醒她）
  for (const gone of ['沉睡前', 'preSleepWaitRemainingMs', 'timeoutMs=300000', '【当前唤醒】', 'bridge', '桥接']) {
    assert.ok(!prefix.includes(gone), `旧规则不该回来：${gone}`);
  }
});

test('pre-reply quiet checks, waiting for more and leaving after replying have distinct instructions', () => {
  assert.match(prefix, /先理解并处理当前消息/);
  assert.match(prefix, /【首答前】[^\n]*qq_wait_for_messages\(purpose="reply", quietMs=3000\)/);
  assert.match(prefix, /你读和想花掉的时间也算，已经安静够了就马上返回/);
  assert.match(prefix, /不要再开一次长等待/);
  assert.match(prefix, /【等下文】[^\n]*purpose="messages", timeoutMs=60000~120000/);
  assert.match(prefix, /【回完以后】群里说完就 qq_mark_read 走开/);
  assert.match(prefix, /私聊回完[^\n]*qq_wait_for_messages\(purpose="messages"\)/);
});

test('social autonomy and visual, forwarding, sticker and web capabilities remain described', () => {
  for (const text of [
    // qqbot_agent：语气交给人格卡，原来的「反 AI 味/保持主体性/学习群友/不当群管家」合并成下面几节
    '【怎么在 QQ 里混】', '【帮人查东西】', '【自由时间】', '【长期记忆（跨会话）】', '大多数时候回一条就够了', '不要用空格断句',
    '不会自动发送到 QQ', 'qq_get_message_images', 'qq_get_forward_msg', 'nestedForwardIds',
    'qq_send_poke', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker',
    'qq_collect_sticker', 'qq_sticker_note', 'qq_get_self_image',
    'qq_list_voices', 'qq_send_voice', 'verified=true 才代表这条语音确实落地',
    '没有这两个工具就是语音没开', '不要假装发了语音',
    'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
  ]) assert.ok(prefix.includes(text), `missing capability or voice rule: ${text}`);
});

test('qqbot_agent: tools hidden by hideTools are not mentioned in the prompt', () => {
  // 守卫行 hideTools 把它们从工具清单里藏了，提示词再提就是让她去调不存在的工具
  for (const name of ['qq_send_group_message', 'qq_send_private_message', 'qq_send_burst', 'qq_set_sticker_remark',
    'qq_get_group_members', 'qq_get_group_history', 'qq_list_groups', 'qq_report_feedback', 'qq_get_my_recent_messages']) {
    assert.ok(!prefix.includes(name), `prompt still mentions hidden tool ${name}`);
  }
});

test('qqbot_agent: rules that contradict the persona card stay removed', () => {
  for (const text of ['拒绝有求必应', '不要习惯性潜水', '不要把潜水当默认', '装唐装傻', '大胆开口', 'coding agent', '没有任何账号登录态']) {
    assert.ok(!prefix.includes(text), `contradictory rule came back: ${text}`);
  }
});

test('autonomy limits and the observation escape hatch stay described', () => {
  // These rules were previously unguarded: deleting any of them left every test green.
  for (const text of [
    // 私聊里对方说了结束语就收尾
    '对方说了“不聊了”“晚安”“下了”“拜拜”',
    // [SILENT] 是桥接的退出标记，误用会静默吞掉回复。
    '不要用 [SILENT]',
    // 记忆面
    '“这里讲过了”', 'memory_forget(id)', 'person_note', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear',
    // 黑话面
    'qq_slang_query', 'qq_slang_submit', '不重复提交',
    // 频率上限
    '普通闲聊大约 3~5 轮一张', '别连着刷', 'qq_send_sticker 一次一张，不能带文字', '不要频繁拍',
    // 会话令牌是硬前置，漏传会被拒绝。
    '作为 token 参数传入',
    // 指定成员唤醒
    'triggers.speakerIds', '不凭记忆乱填',
  ]) assert.ok(prefix.includes(text), `missing rule: ${text}`);
});

console.log(`reserved2 persona prefix: ${prefix.length} characters (not a model-token estimate)`);
