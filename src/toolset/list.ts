import type { Page } from 'puppeteer-core';
import {
  LIST_FILTER_GAP_MS,
  LIST_MIN_BEFORE_EMPTY_OK_MS,
  LIST_POLL_MS,
  sleepRandom,
} from '../browser/index.js';
import { BOSS_CHAT_INDEX_URL, isBossChatIndexUrl } from '../common/auth.js';
import { ensurePage } from '../common/ensure_page.js';
import { withBossSessionPage } from '../common/boss_session_page.js';

type CandidateItem = {
  name: string;
  job: string;
  time: string;
  message: string;
  unreadCount: number;
};

async function waitForCandidateListSettled(
  page: Page,
  opts: { timeoutMs: number; pollMsMin: number; pollMsMax: number; minMsBeforeEmptyOk: number },
): Promise<void> {
  const start = Date.now();
  let prev = -1;
  let stable = 0;
  while (Date.now() - start < opts.timeoutMs) {
    const n = (await page.evaluate(
      `(() => document.querySelectorAll(".geek-item").length)()`,
    )) as number;
    const elapsed = Date.now() - start;
    if (n === prev) {
      stable++;
    } else {
      prev = n;
      stable = 1;
    }
    if (stable >= 2) {
      if (n > 0) {
        return;
      }
      if (n === 0 && elapsed >= opts.minMsBeforeEmptyOk) {
        return;
      }
    }
    await sleepRandom(opts.pollMsMin, opts.pollMsMax);
  }
}

// 「已获取简历」分类位于 .chat-label 容器（chat-label-item），
// 与 .chat-message-filter-left（全部/未读）不同
const FILTER_CONTAINERS = ['.chat-message-filter-left', '.chat-label'];

async function findFilterEl(page: Page, label: string): Promise<boolean> {
  const labelLiteral = JSON.stringify(label);
  return (await page.evaluate(
    `(() => {
      const targetText = ${labelLiteral};
      const containers = ${JSON.stringify(FILTER_CONTAINERS)};
      const norm = (v) => (v ?? "").replace(/\\s+/g, "");
      for (const sel of containers) {
        const container = document.querySelector(sel);
        if (!container) continue;
        // 优先匹配子元素；.chat-message-filter-left 用 span，.chat-label 用 .chat-label-item
        const candidates = Array.from(container.querySelectorAll("span, .chat-label-item"));
        const target = candidates.find((el) => norm(el.textContent).includes(targetText));
        if (target) {
          target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          target.click();
          return true;
        }
      }
      return false;
    })()`,
  )) as boolean;
}

async function clickChatFilterTab(page: Page, label: string): Promise<void> {
  const ok = await findFilterEl(page, label);
  if (!ok) {
    const labels = (await page.evaluate(`(() => {
      const norm = (v) => (v ?? "").replace(/\\s+/g, "");
      const out = [];
      for (const sel of ${JSON.stringify(FILTER_CONTAINERS)}) {
        const container = document.querySelector(sel);
        if (!container) continue;
        Array.from(container.querySelectorAll("span, .chat-label-item")).forEach((el) => {
          const t = norm(el.textContent);
          if (t) out.push(t);
        });
      }
      return out.join(",");
    })()`)) as string;
    throw new Error(`未找到聊天筛选项：${label}；当前筛选项：${labels || '空'}`);
  }
}

async function waitForChatFilterTabSelected(page: Page, label: string): Promise<void> {
  const labelLiteral = JSON.stringify(label);
  await page.waitForFunction(
    `(() => {
      const targetText = ${labelLiteral};
      const norm = (v) => (v ?? "").replace(/\\s+/g, "");
      for (const sel of ${JSON.stringify(FILTER_CONTAINERS)}) {
        const container = document.querySelector(sel);
        if (!container) continue;
        const candidates = Array.from(container.querySelectorAll("span, .chat-label-item"));
        const tab = candidates.find((el) => norm(el.textContent).includes(targetText));
        if (!tab) continue;
        const cls = String(tab.className || "");
        const selectedByClass = /active|selected|current|checked/.test(cls);
        const selectedByAria = tab.getAttribute("aria-selected") === "true";
        const selectedByAncestor = !!tab.closest(".active, .selected, .current, .checked");
        if (selectedByClass || selectedByAria || selectedByAncestor) return true;
      }
      return false;
    })()`,
    { timeout: 8_000 },
  );
}

export type ChatListFilter = 'all' | 'unread' | 'resume';

export async function ensureChatListReady(
  page: Page,
  filter: ChatListFilter = 'all',
): Promise<void> {
  await ensurePage(page, {
    name: '沟通列表页',
    targetUrl: BOSS_CHAT_INDEX_URL,
    matches: isBossChatIndexUrl,
  });

  await page.waitForFunction(
    `(() => {
      const filter = document.querySelector(".chat-message-filter-left");
      if (!filter) return false;
      const tabs = Array.from(filter.querySelectorAll("span"));
      return tabs.length >= 2;
    })()`,
    { timeout: 15_000 },
  );

  const filterLabel = filter === 'unread' ? '未读' : filter === 'resume' ? '已获取简历' : '全部';
  await clickChatFilterTab(page, filterLabel);
  await sleepRandom(LIST_FILTER_GAP_MS.min, LIST_FILTER_GAP_MS.max);
  await waitForChatFilterTabSelected(page, filterLabel);
  await waitForCandidateListSettled(page, {
    timeoutMs: 18_000,
    pollMsMin: LIST_POLL_MS.min,
    pollMsMax: LIST_POLL_MS.max,
    minMsBeforeEmptyOk: LIST_MIN_BEFORE_EMPTY_OK_MS,
  });
}

export async function runGetCandidateList(
  opts: { unreadOnly?: boolean; resumeOnly?: boolean } = {},
): Promise<string> {
  const unreadOnly = opts.unreadOnly === true;
  const resumeOnly = opts.resumeOnly === true;
  const filter: ChatListFilter = unreadOnly ? 'unread' : resumeOnly ? 'resume' : 'all';

  try {
    return await withBossSessionPage(async (page) => {
      await ensureChatListReady(page, filter);

      const items = (await page.evaluate(
        `(() => {
          const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
          return Array.from(document.querySelectorAll(".geek-item")).map((el) => {
            const name = norm(el.querySelector(".geek-name")?.textContent);
            const job = norm(el.querySelector(".source-job")?.textContent);
            const time = norm(el.querySelector(".time")?.textContent);
            const message = norm(el.querySelector(".push-text")?.textContent);
            const badge = el.querySelector(".badge-count");
            let unreadCount = 0;
            if (badge) {
              const digits = norm(badge.textContent).replace(/\\D/g, "");
              if (digits) unreadCount = parseInt(digits, 10) || 0;
            }
            return { name, job, time, message, unreadCount };
          });
        })()`,
      )) as CandidateItem[];

      const candidates = items.filter((it) => it.name) as CandidateItem[];
      const withUnread = candidates.filter((it) => it.unreadCount > 0).length;
      const lines = candidates.map((it, idx) => {
        const base = `${idx + 1}. ${it.name}${it.job ? `｜${it.job}` : ''}`;
        const meta = [
          it.unreadCount > 0 ? `未读:${it.unreadCount}` : '',
          it.time ? `时间:${it.time}` : '',
          it.message ? `消息:${it.message}` : '',
        ]
          .filter(Boolean)
          .join('｜');
        return meta ? `${base}｜${meta}` : base;
      });
      const previewText =
        lines.length > 0 ? `候选人明细：\n${lines.join('\n')}` : '候选人明细：暂无。';

      const head =
        unreadOnly
          ? `未读筛选：共 ${candidates.length} 人（已切换页面「未读」筛选）。`
          : resumeOnly
            ? `已获取简历筛选：共 ${candidates.length} 人（已切换页面「已获取简历」分类）。`
            : `沟通列表共 ${candidates.length} 人，其中 ${withUnread} 人有未读消息。`;

      return [head, previewText].filter(Boolean).join('\n');
    });
  } catch (e) {
    if (e instanceof Error) {
      throw e;
    }
    throw new Error(`获取候选人列表失败：${String(e)}`);
  }
}
