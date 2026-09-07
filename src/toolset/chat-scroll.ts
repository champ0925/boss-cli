import type { Page } from 'puppeteer-core';

// BOSS 使用 overflow:hidden 的自定义滚动列表，内容通过位移滚动。
// 按实际 .user-list 容器定位滚轮，以内容坐标变化判断进展，不能依赖 scrollTop。
const READ_LIST_STATE = `(() => {
  const row = document.querySelector('.geek-item[data-id], .geek-item-wrap');
  if (!row) return null;
  const container = row.closest('.user-list');
  if (!container) throw new Error('未找到会话列表滚动容器');
  const rect = container.getBoundingClientRect();
  let content = row;
  while (content.parentElement && content.parentElement !== container) content = content.parentElement;
  const contentRect = content.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const right = Math.min(window.innerWidth, rect.right);
  const top = Math.max(0, rect.top);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right <= left || bottom <= top) throw new Error('会话列表滚动容器不在可见区域');
  const rows = Array.from(container.querySelectorAll('.geek-item[data-id]'));
  return {
    container: container.className,
    top: rect.top - contentRect.top,
    height: contentRect.height,
    viewport: container.clientHeight,
    signature: rows.map(el => el.getAttribute('data-id')).join('|'),
    x: (left + right) / 2,
    y: (top + bottom) / 2
  };
})()`;

type ListState = {
  container?: string;
  top: number;
  height: number;
  viewport: number;
  signature: string;
  x: number;
  y: number;
};

/** 滚动成功或加载新记录时继续；只有底部等待后仍无变化才停止。 */
export async function scrollChatListOnce(page: Page): Promise<boolean> {
  const before = await page.evaluate(READ_LIST_STATE) as ListState | null;
  if (!before) return false;
  if (process.env.BOSS_CHAT_SCROLL_DEBUG === '1') {
    console.error('会话滚动前：', JSON.stringify({ ...before, signature: before.signature.split('|').length }));
  }
  await page.mouse.move(before.x, before.y);
  // 保留部分重叠，兼容只渲染可见行的列表，避免跳过中间候选人。
  await page.mouse.wheel({ deltaY: Math.max(1, Math.floor(before.viewport * 0.8)) });
  try {
    const changed = await page.waitForFunction(`(() => {
      const previous = ${JSON.stringify(before)};
      const current = ${READ_LIST_STATE};
      return current && (
        Math.abs(current.top - previous.top) > 1 ||
        current.height !== previous.height ||
        current.signature !== previous.signature
      );
    })()`, { timeout: 5000, polling: 100 });
    await changed.dispose();
  } catch (error) {
    // 等待超时只意味着没有观察到变化；其它页面错误直接暴露。
    if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
  }
  const after = await page.evaluate(READ_LIST_STATE) as ListState | null;
  if (!after) throw new Error('滚动后会话列表消失，无法确认是否到底');
  if (process.env.BOSS_CHAT_SCROLL_DEBUG === '1') {
    console.error('会话滚动后：', JSON.stringify({ ...after, signature: after.signature.split('|').length }));
  }
  if (Math.abs(after.top - before.top) > 1 || after.height !== before.height || after.signature !== before.signature) {
    return true;
  }
  if (after.top + after.viewport >= after.height - 2) return false;
  throw new Error(`会话列表滚动未生效：位置 ${after.top}，可视高度 ${after.viewport}，总高度 ${after.height}；尚未到底`);
}
