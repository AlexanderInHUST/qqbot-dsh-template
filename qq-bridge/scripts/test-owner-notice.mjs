// qqbot_agent：系统提示只私聊发给主人。2026-11-19 主人：“所有的报错信息，都私聊发给我，不要发在小群里”，
// 以前私聊不在白名单或在 noReachOut 里时改发到家里的小群，现在不改发了。
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

await test('noReachOut 里也照样私聊；私聊不在白名单里就不发，也不改发到小群', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: '42', homeGroups: ['456'], allow: { private: ['42'], groups: ['456'] }, socialV2: { noReachOut: ['private:42'] } } });
  try {
    assert.equal(h.ownerNoticeKey(), 'private:42');
    await h.notifyOwnerOnly('group:456', '⚠️ agent 处理出错：y');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sent = JSON.parse(JSON.stringify(h.calls.sent));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'private');
  } finally { await h.close(); }
  const sent = await notice({ private: ['43'], groups: ['456', '789'] });
  assert.equal(sent.length, 0);
});

if (failures) { console.error(`${failures} 个测试失败`); process.exit(1); }
