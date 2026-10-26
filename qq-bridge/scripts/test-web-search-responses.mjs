// qqbot_agent：provider=responses（OpenAI Responses API 的服务端 web_search）的离线测试
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSearchConfig, mapResponsesOutput, responsesSearch, webSearch } from '../src/web-search.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const SAMPLE = {
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'web_search_call', status: 'completed', action: { type: 'search', query: '边缘行者 第二季 口碑' } },
    {
      type: 'message',
      content: [{
        type: 'output_text',
        text: '媒体偏正面，观众分化，豆瓣开分 5.9。',
        annotations: [
          { type: 'url_citation', url: 'https://www.gamesradar.com/review/?utm_source=openai', title: 'GamesRadar 评测' },
          { type: 'url_citation', url: 'https://www.gamesradar.com/review/', title: '重复的来源' },
          { type: 'url_citation', url: 'https://www.gamersky.com/news/1.shtml', title: '' },
          { type: 'url_citation', url: 'javascript:alert(1)', title: '坏链接' }
        ]
      }]
    }
  ]
};

await test('mapResponsesOutput 取回答文本、去重引用、去掉 utm_source、丢掉非 http 链接', () => {
  const { answer, results } = mapResponsesOutput(SAMPLE, 8);
  assert.equal(answer, '媒体偏正面，观众分化，豆瓣开分 5.9。');
  assert.deepEqual(results, [
    { title: 'GamesRadar 评测', url: 'https://www.gamesradar.com/review/' },
    { title: 'https://www.gamersky.com/news/1.shtml', url: 'https://www.gamersky.com/news/1.shtml' }
  ]);
});

await test('mapResponsesOutput 遵守 maxResults', () => {
  assert.equal(mapResponsesOutput(SAMPLE, 1).results.length, 1);
});

await test('mapResponsesOutput 没触发搜索时报 NO_RESULT_BLOCK（不能把模型凭记忆的回答当搜索结果）', () => {
  const noSearch = { output: SAMPLE.output.filter((o) => o.type !== 'web_search_call') };
  assert.throws(() => mapResponsesOutput(noSearch), (e) => e.code === 'NO_RESULT_BLOCK');
});

await test('mapResponsesOutput 回答过长时截断', () => {
  const long = structuredClone(SAMPLE);
  long.output[2].content[0].text = '字'.repeat(5000);
  assert.equal(mapResponsesOutput(long).answer.length, 1500);
});

await test('loadSearchConfig 认 provider=responses 和 reasoningEffort', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-resp-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      webSearch: { provider: 'responses', baseURL: 'https://api.example.com/v1/', model: 'gpt-x', reasoningEffort: 'medium' }
    }));
    const cfg = loadSearchConfig(dir);
    assert.equal(cfg.provider, 'responses');
    assert.equal(cfg.baseURL, 'https://api.example.com/v1');
    assert.equal(cfg.reasoningEffort, 'medium');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webSearch: { reasoningEffort: 'bogus' } }));
    assert.equal(loadSearchConfig(dir).reasoningEffort, 'low');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('responsesSearch 缺 key / baseURL / model 时直接报错，不发请求', async () => {
  const env = 'QQBOT_TEST_RESPONSES_KEY';
  delete process.env[env];
  await assert.rejects(responsesSearch('x', { apiKeyEnv: env, baseURL: 'https://api.example.com/v1', model: 'gpt-x' }), (e) => e.code === 'NO_KEY');
  process.env[env] = 'k';
  try {
    await assert.rejects(responsesSearch('x', { apiKeyEnv: env, baseURL: '', model: 'gpt-x' }), /baseURL/);
    await assert.rejects(responsesSearch('x', { apiKeyEnv: env, baseURL: 'https://api.example.com/v1', model: '' }), /model/);
    await assert.rejects(responsesSearch('x', { apiKeyEnv: env, baseURL: 'http://api.example.com/v1', model: 'gpt-x' }), /https/);
  } finally {
    delete process.env[env];
  }
});

await test('webSearch provider=responses 失败时不回退 Bing', async () => {
  const env = 'QQBOT_TEST_RESPONSES_KEY';
  delete process.env[env];
  await assert.rejects(
    webSearch('不回退测试', { provider: 'responses', config: { apiKeyEnv: env, baseURL: 'https://api.example.com/v1', model: 'gpt-x' } }),
    (e) => e.code === 'NO_KEY'
  );
});

// ── provider=anthropic（Anthropic Messages + web_search_20250305，例如中转站的 Claude Haiku）──
const ANTHROPIC_SAMPLE = {
  content: [
    { type: 'server_tool_use', name: 'web_search', input: { query: 'a' } },
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://bangumi.tv/x', title: '无关' }] },
    { type: 'text', text: '信息不足，让我再搜一次。' },
    { type: 'server_tool_use', name: 'web_search', input: { query: 'b' } },
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://www.rottentomatoes.com/tv/s02', title: '烂番茄' }] },
    { type: 'text', text: '**总体评价**：偏正面。' },
    { type: 'text', text: '## 争议\n叙事散。' }
  ]
};

await test('mapAnthropicAnswer 只取最后一次搜索之后的文本，并去掉 Markdown', async () => {
  const { mapAnthropicAnswer } = await import('../src/web-search.js');
  assert.equal(mapAnthropicAnswer(ANTHROPIC_SAMPLE), '总体评价：偏正面。\n争议\n叙事散。');
});

await test('loadSearchConfig 认 provider=anthropic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-anth-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webSearch: { provider: 'anthropic' } }));
    assert.equal(loadSearchConfig(dir).provider, 'anthropic');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('provider=anthropic 缺 baseURL / model 时报错，失败不回退 Bing', async () => {
  const env = 'QQBOT_TEST_ANTHROPIC_KEY';
  process.env[env] = 'k';
  try {
    await assert.rejects(webSearch('x1', { provider: 'anthropic', config: { apiKeyEnv: env, baseURL: '', model: 'claude-x' } }), /baseURL/);
    await assert.rejects(webSearch('x2', { provider: 'anthropic', config: { apiKeyEnv: env, baseURL: 'https://api.example.com/v1', model: '' } }), /model/);
  } finally {
    delete process.env[env];
  }
  await assert.rejects(
    webSearch('x3', { provider: 'anthropic', config: { apiKeyEnv: env, baseURL: 'https://api.example.com/v1', model: 'claude-x' } }),
    (e) => e.code === 'NO_KEY'
  );
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
