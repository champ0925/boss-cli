import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { scrollChatListOnce } from './chat-scroll.js';

const initial = { top: 0, height: 5000, viewport: 500, signature: '甲|乙', x: 200, y: 350 };

function mockPage(before: typeof initial, after: typeof initial, waitError?: Error) {
  let reads = 0;
  const moves: number[][] = [];
  const wheels: number[] = [];
  const page = {
    evaluate: async () => reads++ === 0 ? before : after,
    mouse: {
      move: async (x: number, y: number) => { moves.push([x, y]); },
      wheel: async ({ deltaY }: { deltaY: number }) => { wheels.push(deltaY); },
    },
    waitForFunction: async () => {
      if (waitError) throw waitError;
      return { dispose: async () => {} };
    },
  } as unknown as Page;
  return { page, moves, wheels };
}

function timeout() {
  const error = new Error('等待列表变化超时');
  error.name = 'TimeoutError';
  return error;
}

test('记录数和 ID 未变化，只要容器滚动就继续查找', async () => {
  const { page, moves, wheels } = mockPage(initial, { ...initial, top: 400 });
  assert.equal(await scrollChatListOnce(page), true);
  assert.deepEqual(moves, [[200, 350]]);
  assert.equal(wheels[0], 400);
});

test('到底后异步加载出新记录时继续查找', async () => {
  const bottom = { ...initial, top: 4500 };
  const { page } = mockPage(bottom, { ...bottom, height: 6000, signature: '甲|乙|丙' });
  assert.equal(await scrollChatListOnce(page), true);
});

test('虚拟列表中行数不变但行 ID 改变时继续查找', async () => {
  const { page } = mockPage(initial, { ...initial, signature: '丙|丁' });
  assert.equal(await scrollChatListOnce(page), true);
});

test('只有到达底部且等待后仍无变化才停止', async () => {
  const bottom = { ...initial, top: 4500 };
  const { page } = mockPage(bottom, bottom, timeout());
  assert.equal(await scrollChatListOnce(page), false);
});

test('未到底但滚轮未生效时明确报错，不能当作找不到候选人', async () => {
  const { page } = mockPage(initial, initial, timeout());
  await assert.rejects(scrollChatListOnce(page), /尚未到底/);
});

test('页面断开等异常不会被当作正常到底', async () => {
  const { page } = mockPage(initial, initial, new Error('页面连接断开'));
  await assert.rejects(scrollChatListOnce(page), /页面连接断开/);
});
