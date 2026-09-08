import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatStartBody } from './greet.js';

test('chat/start 表单与 BOSS 页面实测参数一致', () => {
  const body = new URLSearchParams(
    buildChatStartBody('geek-id', {
      encryptJobId: 'job-id',
      expectId: 'expect-id',
      lid: 'lid-value',
      securityId: 'security-value',
    }),
  );

  assert.deepEqual(Object.fromEntries(body.entries()), {
    gid: 'geek-id',
    suid: '',
    jid: 'job-id',
    expectId: 'expect-id',
    lid: 'lid-value',
    greet: '',
    from: '',
    securityId: 'security-value',
    customGreetingGuide: '-1',
  });
});
