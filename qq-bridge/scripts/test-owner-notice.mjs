// qqbot_agent：系统提示只发给主人。2026-10-28 爸爸说以后不私聊了、有事都在小群说，
// 他的私聊从白名单拿掉以后，系统提示改发到家里的第一个群；私聊还在白名单里时照旧私聊发。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

async function notice(allow) {
  const h = await bridgeHarness({ config: { ownerQQ: '42', homeGroups: ['456'], allow } });
  try {
    await h.notifyOwnerOnly('group:789', '⚠️ agent 处理出错：x');
    await new Promise((resolve) => setTimeout(resolve, 50));
    return JSON.parse(JSON.stringify(h.calls.sent));
  } finally { await h.close(); }
}

await test('主人私聊在白名单里：私聊发给主人', async () => {
  const sent = await notice({ private: ['42'], groups: ['456', '789'] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'private');
  assert.equal(String(sent[0].id), '42');
  assert.match(sent[0].text, /来自会话 group:789/);
});

await test('主人私聊不在白名单里：发到家里的小群', async () => {
  const sent = await notice({ private: ['43'], groups: ['456', '789'] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'group');
  assert.equal(String(sent[0].id), '456');
});

if (failures) { console.error(`${failures} 个测试失败`); process.exit(1); }
