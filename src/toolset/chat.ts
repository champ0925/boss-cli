import type { Page } from 'puppeteer-core';
import {
  CHAT_HISTORY_DIALOG_WAIT_MS,
  CHAT_HISTORY_TAB_SWITCH_MS,
  OPEN_CHAT_AFTER_ROW_CLICK_MS,
  OPEN_CHAT_SCROLL_GAP_MS,
  sleepRandom,
} from '../browser/index.js';
import { isBossChatIndexUrl } from '../common/auth.js';
import { ensureChatListReady } from './list.js';
import { fetchBossChatIdentities, parseBossChatUniqueId, type BossChatIdentity } from './chat-identity.js';
import { scrollChatListOnce } from './chat-scroll.js';

type ChatFrom = 'friend' | 'myself' | 'system' | 'unknown';

function chatRoleTag(from: ChatFrom): string {
  switch (from) {
    case 'friend':
      return '[candidate]';
    case 'myself':
      return '[you]';
    case 'system':
      return '[system]';
    default:
      return '[unknown]';
  }
}

async function waitForChatHistoryPanelReady(page: Page, selectedTab?: string): Promise<void> {
  const selectedTabLiteral = JSON.stringify(selectedTab ?? null);
  await page.waitForFunction(
    `(() => {
      const tabLabel = ${selectedTabLiteral};
      function norm(v) {
        return (v ?? "").replace(/\\s+/g, " ").trim();
      }
      function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }
      const root = document.querySelector(".chat-history-process");
      if (!isVisible(root)) return false;
      if (tabLabel) {
        const selected = root.querySelector(".tab-hd span.selected");
        if (norm(selected?.textContent) !== tabLabel) return false;
      }
      return !!root.querySelector(".record");
    })()`,
    { timeout: 10_000 },
  );
}

/**
 * 打开「沟通记录」弹窗，依次读取「同事沟通」「我的沟通」列表，关闭弹窗。
 * 未找到入口时返回 null（视为暂无同事沟通记录，不输出该段）。
 */
async function fetchColleagueChatHistorySection(page: Page): Promise<string | null> {
  const clicked = (await page.evaluate(`(() => {
    function norm(v) {
      return (v ?? "").replace(/\\s+/g, " ").trim();
    }
    const tooltips = Array.from(document.querySelectorAll(".chat-tooltip-custom"));
    for (const el of tooltips) {
      if (!norm(el.textContent).includes("沟通记录")) continue;
      const host = el.closest("span.icon") ?? el.closest("span") ?? el.parentElement;
      if (host) {
        host.click();
        return true;
      }
      el.click();
      return true;
    }
    const uses = Array.from(document.querySelectorAll("use"));
    for (const u of uses) {
      const h =
        u.getAttribute("href") ||
        u.getAttributeNS("http://www.w3.org/1999/xlink", "href") ||
        "";
      if (h.includes("icon-chat-history")) {
        const p = u.closest("span.icon") ?? u.parentElement?.parentElement;
        if (p) {
          p.click();
          return true;
        }
      }
    }
    return false;
  })()`)) as boolean;

  if (!clicked) {
    return null;
  }

  await sleepRandom(CHAT_HISTORY_DIALOG_WAIT_MS.min, CHAT_HISTORY_DIALOG_WAIT_MS.max);

  try {
    await waitForChatHistoryPanelReady(page);
  } catch {
    return '(已点击「沟通记录」，但弹窗未在预期时间内出现。)';
  }

  const scrapeRows = () =>
    page.evaluate(`(() => {
      function norm(v) {
        return (v ?? "").replace(/\\s+/g, " ").trim();
      }
      const root = document.querySelector(".chat-history-process");
      if (!root) return [];
      return Array.from(root.querySelectorAll(".record li"))
        .map((li) => ({
          action: norm(li.querySelector(".action")?.textContent),
          operat: norm(li.querySelector(".operat")?.textContent),
        }))
        .filter((x) => x.action || x.operat);
    })()`) as Promise<Array<{ action: string; operat: string }>>;

  const clickTab = (label: string) => {
    const labelLiteral = JSON.stringify(label);
    return page.evaluate(
      `(() => {
        const lab = ${labelLiteral};
        function norm(v) {
          return (v ?? "").replace(/\\s+/g, " ").trim();
        }
        const root = document.querySelector(".chat-history-process");
        if (!root) return;
        const spans = Array.from(root.querySelectorAll(".tab-hd span"));
        const sp = spans.find((s) => norm(s.textContent) === lab);
        if (sp && !sp.classList.contains("selected")) {
          sp.click();
        }
      })()`,
    );
  };

  await clickTab('同事沟通');
  await sleepRandom(CHAT_HISTORY_TAB_SWITCH_MS.min, CHAT_HISTORY_TAB_SWITCH_MS.max);
  await waitForChatHistoryPanelReady(page, '同事沟通');
  const rowsColleague = await scrapeRows();

  await clickTab('我的沟通');
  await sleepRandom(CHAT_HISTORY_TAB_SWITCH_MS.min, CHAT_HISTORY_TAB_SWITCH_MS.max);
  await waitForChatHistoryPanelReady(page, '我的沟通');
  const rowsMine = await scrapeRows();

  const fmt = (label: string, rows: Array<{ action: string; operat: string }>): string[] => {
    const lines = [`[${label}]`];
    if (rows.length === 0) {
      lines.push('(暂无)');
      return lines;
    }
    rows.forEach((r, i) => {
      const line = [r.action, r.operat].filter(Boolean).join(' ｜ ');
      lines.push(`${i + 1}. ${line}`);
    });
    return lines;
  };

  const parts: string[] = [];
  parts.push(...fmt('同事沟通', rowsColleague));
  parts.push('');
  parts.push(...fmt('我的沟通', rowsMine));

  await closeChatHistoryPopup(page);

  return parts.join('\n');
}

export async function runGetCommunicationHistory(page: Page): Promise<string> {
  const currentUrl = page.url();
  if (!isBossChatIndexUrl(currentUrl)) {
    throw new Error('请先进入聊天列表页（/web/chat/index）并打开候选人聊天。');
  }
  const inCandidateChat = await page.$('.base-info-single-container');
  if (!inCandidateChat) {
    throw new Error('请先打开候选人聊天详情页，再执行“沟通记录”操作。');
  }

  let historyBlock: string | null = null;
  historyBlock = await fetchColleagueChatHistorySection(page);
  if (historyBlock === null) {
    return '未找到「沟通记录」入口，或当前候选人暂无可读取记录。';
  }
  return ['同事/我的沟通记录：', '', historyBlock].join('\n');
}

/** 关闭「沟通记录」弹层（优先点 Boss 提供的 popup 关闭钮） */
async function closeChatHistoryPopup(page: Page): Promise<void> {
  try {
    const selectors = [
      '.boss-popup__wrapper.chat-history .boss-popup__close',
      '.boss-dialog__wrapper.chat-history .boss-popup__close',
      '.boss-popup__wrapper.boss-dialog.chat-history .boss-popup__close',
    ];
    let btn = null as Awaited<ReturnType<typeof page.$>>;
    for (const sel of selectors) {
      btn = await page.$(sel);
      if (btn) break;
    }
    if (btn) {
      await btn.click();
    } else {
      await page.evaluate(`(() => {
        const root =
          document.querySelector(".boss-popup__wrapper.chat-history") ||
          document.querySelector(".boss-dialog__wrapper.chat-history");
        const c = root?.querySelector(".boss-popup__close") ?? document.querySelector(".boss-popup__close");
        if (c) {
          c.click();
        }
      })()`);
    }
    await page.waitForFunction(
      `(() => {
        const roots = Array.from(document.querySelectorAll(".boss-popup__wrapper.chat-history, .boss-dialog__wrapper.chat-history"));
        return roots.every((el) => {
          if (!(el instanceof HTMLElement)) return true;
          const st = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return st.display === "none" || st.visibility === "hidden" || r.width <= 0 || r.height <= 0;
        });
      })()`,
      { timeout: 3_000 },
    ).catch(() => {});
    const popupWrap = await page.$('.boss-popup__wrapper.chat-history, .boss-dialog__wrapper.chat-history');
    if (popupWrap) {
      await page.evaluate(`(() => {
        const root =
          document.querySelector(".boss-popup__wrapper.chat-history") ||
          document.querySelector(".boss-dialog__wrapper.chat-history");
        const c = root?.querySelector(".boss-popup__close") ?? document.querySelector(".boss-popup__close");
        c?.click();
      })()`);
      await page.waitForFunction(
        `(() => {
          const roots = Array.from(document.querySelectorAll(".boss-popup__wrapper.chat-history, .boss-dialog__wrapper.chat-history"));
          return roots.every((el) => {
            if (!(el instanceof HTMLElement)) return true;
            const st = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return st.display === "none" || st.visibility === "hidden" || r.width <= 0 || r.height <= 0;
          });
        })()`,
        { timeout: 2_500 },
      ).catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`关闭「沟通记录」弹层失败：${msg}`);
  }
}

type CandidateSummary = {
  name: string;
  active: string;
  basicFacts: string[];
  recentExperience: string[];
  communicationPosition: string;
  expectation: string;
  remark: string;
};

/** 结构化聊天消息（供 --json 输出 / messages 表写入）。 */
export type BossChatMessage = {
  time: string;                       // 消息时间（页面原始文本，如 "昨天 16:30" / "12:04"）
  direction: 'in' | 'out' | 'system'; // in=候选人发来，out=我方发出，system=系统
  content: string;                    // 消息内容
};

/** 结构化聊天详情（供 --json 输出 / messages 表写入）。 */
export type BossChatDetail = {
  encryptUid?: string;                // BOSS 沟通身份标识（会轮换，仅用于定位会话）
  uniqueId?: string;                  // 沟通列表行稳定标识（friendId-friendSource）
  friendId?: number;                  // BOSS 稳定联系人 ID（候选人主认人键）
  friendSource?: number;              // 好友来源（与 friendId 组成 uniqueId）
  securityId?: string;                // 平台安全 ID
  name: string;                       // 候选人姓名
  job: string;                        // 沟通职位
  active: string;                     // 活跃状态
  basicFacts: string[];               // 基本信息（年龄/年限/学历等）
  expectation: string;                // 期望
  recentExperience: string[];         // 近期经历
  remark: string;                     // 备注
  hasResumeAttachment: boolean;       // 是否有附件简历
  messages: BossChatMessage[];        // 消息列表
  scrapedAt: string;                  // 抓取时间 ISO
};

type ChatMessageSnapshot = {
  messages: Array<{
    time: string;
    from: 'friend' | 'myself' | 'system' | 'unknown';
    text: string;
  }>;
  hasFriendResumeAttachment: boolean;
};

async function fetchCandidateSummary(
  page: Page,
  expectedName: string,
  exactMatch: boolean,
): Promise<CandidateSummary> {
  const targetNameLiteral = JSON.stringify(expectedName);
  const exactMatchLiteral = JSON.stringify(exactMatch);
  const scraped = (await page.evaluate(`(() => {
    const targetName = ${targetNameLiteral};
    const exact = ${exactMatchLiteral};
    const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
    const matches = (value) => exact ? value === targetName : value.includes(targetName);
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const roots = Array.from(document.querySelectorAll(".base-info-single-container")).filter(isVisible);
    const root = roots.find((el) => matches(norm(el.querySelector(".name-box")?.textContent)));
    if (!root) {
      const visibleNames = roots.map((el) => norm(el.querySelector(".name-box")?.textContent)).filter(Boolean).join(", ");
      throw new Error("未找到目标候选人详情容器：" + targetName + "；当前可见详情：" + (visibleNames || "空"));
    }
    const name = norm(root.querySelector(".name-box")?.textContent);
    const active = norm(root.querySelector(".high-light-orange.active-time span")?.textContent);
    const basicFacts = Array.from(root.querySelectorAll(".base-info-single-detial > div"))
      .filter((el) => !el.classList.contains("name-contet") && !el.classList.contains("active-time"))
      .map((el) => norm(el.textContent))
      .filter((v) => v.length > 0);
    // 经历时间列（.time-content li .time，如「2025.02-2025.12」）与内容列（.work-content li .value，如「聚博企业服务 · 法务专员/助理」）
    // 两个列表按索引一一对应（工作/教育经历都在里面），配对拼接成「时间 内容」；无时间列时回退为纯内容
    const timeItems = Array.from(
      root.querySelectorAll(".experience-content.time-list .time-content li .time"),
    ).map((el) => norm(el.textContent));
    const expItems = Array.from(
      root.querySelectorAll(".experience-content.detail-list .work-content li .value"),
    ).map((el) => norm(el.textContent));
    const recentExperience =
      timeItems.length > 0
        ? timeItems
            .map((t, i) => String(t + ' ' + (expItems[i] || '')).trim())
            .filter((v) => v.length > 0)
        : expItems.filter((v) => v.length > 0);
    const communicationPosition = norm(
      root.querySelector(".position-item .position-name")?.textContent,
    );
    const expectation = norm(root.querySelector(".position-item.expect .value.job")?.textContent);
    const remark = norm(
      root.querySelector(".label-remark-content .remark span:last-child")?.textContent,
    );
    return {
      name,
      active,
      basicFacts,
      recentExperience,
      communicationPosition,
      expectation,
      remark,
    };
  })()`)) as CandidateSummary;
  return scraped;
}

async function waitForOpenedCandidateChat(page: Page, expectedName: string): Promise<void> {
  const expectedNameLiteral = JSON.stringify(expectedName);
  await page.waitForFunction(
    `(() => {
      const name = ${expectedNameLiteral};
      const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const selected = Array.from(document.querySelectorAll(".geek-item.selected")).find(isVisible);
      const selectedName = norm(selected?.querySelector(".geek-name")?.textContent);
      const root = Array.from(document.querySelectorAll(".base-info-single-container")).find(isVisible);
      const detailName = norm(root?.querySelector(".name-box")?.textContent);
      return selectedName === name && detailName === name;
    })()`,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const lists = Array.from(document.querySelectorAll(".chat-message-list")).filter(isVisible);
      const list = lists[lists.length - 1];
      if (!list) return false;
      const items = list.querySelectorAll(".message-item");
      if (!items || items.length === 0) return false;
      return Array.from(items).some((item) => {
        const txt =
          item.querySelector(".item-friend .text span")?.textContent ??
          item.querySelector(".item-myself .text span")?.textContent ??
          item.querySelector(".item-system .message-card-top-title")?.textContent ??
          "";
        return txt.replace(/\\s+/g, " ").trim().length > 0;
      });
    })()`,
    { timeout: 20_000 },
  );
}

async function scrapeCurrentChatMessages(page: Page): Promise<ChatMessageSnapshot> {
  return (await page.evaluate(`(() => {
    const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    function isBossPriorityUpsellSystemText(text) {
      return norm(text).indexOf("优先提醒") !== -1;
    }
    const lists = Array.from(document.querySelectorAll(".chat-message-list")).filter(isVisible);
    const list = lists[lists.length - 1];
    if (!list) {
      throw new Error("未找到可见聊天消息列表（.chat-message-list）。");
    }
    const items = Array.from(list.querySelectorAll(".message-item"));
    let currentTime = "";
    const messages = [];
    let hasFriendResumeAttachment = false;
    for (const item of items) {
      const timeNode = item.querySelector(".message-time .time");
      if (timeNode) {
        const t = norm(timeNode.textContent);
        if (t) currentTime = t;
      }
      const friendRoot = item.querySelector(".item-friend");
      let friendText = "";
      if (friendRoot) {
        friendText = norm(friendRoot.querySelector(".text > span")?.textContent);
        if (!friendText) {
          const resumeIcon = friendRoot.querySelector(".resume-icon");
          const title = norm(friendRoot.querySelector(".message-card-top-title")?.textContent);
          const cardBtn = norm(friendRoot.querySelector(".message-card-buttons .card-btn")?.textContent);
          if (resumeIcon) hasFriendResumeAttachment = true;
          if (title || cardBtn) {
            const parts = [];
            if (title) parts.push(title);
            if (cardBtn) parts.push(cardBtn);
            friendText = parts.length ? parts.join(" · ") : "";
          }
          if (!friendText) friendText = norm(friendRoot.querySelector(".text")?.textContent);
        }
      }
      const myselfText = norm(item.querySelector(".item-myself .text span")?.textContent);
      const systemText =
        norm(item.querySelector(".item-system .message-card-top-title")?.textContent) ||
        norm(item.querySelector(".item-system .text span")?.textContent);
      if (friendText) {
        messages.push({ text: friendText, time: currentTime, from: "friend" });
      } else if (myselfText) {
        messages.push({ text: myselfText, time: currentTime, from: "myself" });
      } else if (systemText) {
        if (!isBossPriorityUpsellSystemText(systemText)) {
          messages.push({ text: systemText, time: currentTime, from: "system" });
        }
      }
    }
    return { messages, hasFriendResumeAttachment };
  })()`)) as ChatMessageSnapshot;
}

async function renderOpenedCandidateChat(page: Page, foundName: string): Promise<string> {
  await waitForOpenedCandidateChat(page, foundName);
  const scraped = await scrapeCurrentChatMessages(page);
  const detailLines = scraped.messages.map((m) => {
    const tag = chatRoleTag(m.from);
    const timePart = m.time ? ` ${m.time}` : '';
    return `${tag}${timePart} ${m.text}`.trimEnd();
  });

  const resumeStatus = scraped.hasFriendResumeAttachment ? '已获取' : '未获取';
  const summary = await fetchCandidateSummary(page, foundName, true);

  const out: string[] = [
    `成功进入候选人聊天：${foundName}`,
    `简历获取状态: ${resumeStatus}`,
  ];
  const summaryLines: string[] = [];
  const summaryName = summary.name || foundName;
  summaryLines.push(`姓名: ${summaryName}`);
  if (summary.active) {
    summaryLines.push(`活跃状态: ${summary.active}`);
  }
  if (summary.basicFacts.length > 0) {
    summaryLines.push(`基本信息: ${summary.basicFacts.join(' / ')}`);
  }
  if (summary.communicationPosition) {
    summaryLines.push(`沟通职位: ${summary.communicationPosition}`);
  }
  if (summary.expectation) {
    summaryLines.push(`期望: ${summary.expectation}`);
  }
  if (summary.recentExperience.length > 0) {
    summaryLines.push('近期经历:');
    summary.recentExperience.forEach((it, idx) => {
      summaryLines.push(`${idx + 1}. ${it}`);
    });
  }
  if (summaryLines.length > 0) {
    out.push('', '人才摘要：', '', ...summaryLines);
  }
  if (summary.remark) {
    out.push('', `备注: ${summary.remark}`);
  }
  out.push('', '完整聊天消息：');
  if (detailLines.length > 0) {
    out.push('', ...detailLines);
  } else {
    out.push('', '(暂无)');
  }
  return out.join('\n');
}

export async function runOpenCandidateChatByIndex(
  page: Page,
  params: {
    index: number;
    filter?: 'all' | 'unread';
    expectedName?: string;
    exact?: boolean;
  },
): Promise<string> {
  if (!Number.isInteger(params.index) || params.index < 1) {
    throw new Error(`聊天列表序号必须是从 1 开始的整数，当前值：${params.index}`);
  }
  const filter = params.filter ?? 'all';
  const expectedName = params.expectedName?.trim() ?? '';
  const exact = params.exact === true;

  await ensureChatListReady(page, filter);
  if (!isBossChatIndexUrl(page.url())) {
    throw new Error('当前不在沟通列表页（/web/chat/index），无法打开候选人聊天。');
  }

  const rowInfo = (await page.evaluate(`((rowIndex) => {
    const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
    const wraps = Array.from(document.querySelectorAll(".geek-item[data-id], .geek-item-wrap"));
    const total = wraps.length;
    const wrap = wraps[rowIndex - 1];
    if (!wrap) return { total, name: "", job: "", message: "", time: "", x: 0, y: 0 };
    const row = wrap.querySelector(".geek-item") || wrap;
    row.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
    const rect = row.getBoundingClientRect();
    return {
      total,
      name: norm(wrap.querySelector(".geek-name")?.textContent),
      job: norm(wrap.querySelector(".source-job")?.textContent),
      message: norm(wrap.querySelector(".push-text")?.textContent),
      time: norm(wrap.querySelector(".time")?.textContent),
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  })(${JSON.stringify(params.index)})`)) as {
    total: number;
    name: string;
    job: string;
    message: string;
    time: string;
    x: number;
    y: number;
  };

  if (!rowInfo.name) {
    throw new Error(
      `聊天列表序号 ${params.index} 不存在；当前${filter === 'unread' ? '未读' : '全部'}列表共 ${rowInfo.total} 条。`,
    );
  }
  if (expectedName) {
    const matched = exact ? rowInfo.name === expectedName : rowInfo.name.includes(expectedName);
    if (!matched) {
      throw new Error(
        `聊天列表序号 ${params.index} 的候选人是「${rowInfo.name}」，与指定姓名「${expectedName}」不匹配。`,
      );
    }
  }

  await page.mouse.click(rowInfo.x, rowInfo.y, { delay: 40 });
  await sleepRandom(OPEN_CHAT_AFTER_ROW_CLICK_MS.min, OPEN_CHAT_AFTER_ROW_CLICK_MS.max);
  return renderOpenedCandidateChat(page, rowInfo.name);
}

/**
 * 打开候选人聊天并渲染文本结果。
 * 返回实际命中的候选人姓名（foundName）：模糊匹配（exact=false）时可能与入参不同，
 * 供 --json 等后续抓取复用同一姓名，避免打开阶段包含匹配成功而摘要阶段精确匹配失败。
 */
export async function runOpenCandidateChat(
  page: Page,
  candidateName: string,
  exact = true,
): Promise<{ text: string; foundName: string }> {
  const targetName = candidateName.trim();

  try {
    await ensureChatListReady(page);
    if (!isBossChatIndexUrl(page.url())) {
      throw new Error('当前不在沟通列表页（/web/chat/index），无法打开候选人聊天。');
    }

    // 如果当前已打开的目标聊天就是目标候选人，直接复用，不再重复点击列表
    const alreadyOpenName = (await page.evaluate(`(() => {
      const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
      const targetName = ${JSON.stringify(targetName)};
      const exactMatch = ${JSON.stringify(exact)};
      const matches = (value) => exactMatch ? value === targetName : value.includes(targetName);
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const root = Array.from(document.querySelectorAll(".base-info-single-container")).find(isVisible);
      const detailName = norm(root?.querySelector(".name-box")?.textContent);
      return matches(detailName) ? detailName : "";
    })()`)) as string;

    if (alreadyOpenName) {
      return { text: await renderOpenedCandidateChat(page, alreadyOpenName), foundName: alreadyOpenName };
    }

    // 聊天页 DOM 可能因消息实时更新而卡住，先刷新页面确保点击有效
    const chatListHasItems = (await page.evaluate(`(() => {
      const list = document.querySelector(".chat-message-list");
      if (!list) return false;
      const items = list.querySelectorAll(".message-item");
      return items && items.length > 0;
    })()`)) as boolean;
    if (!chatListHasItems) {
      await page.reload({ waitUntil: 'load', timeout: 60_000 });
      await ensureChatListReady(page);
    }

    const norm = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();
    const matcher = (value: string) =>
      exact ? value === targetName : value.includes(targetName);
    let targetWrap: Awaited<ReturnType<typeof page.$>> | null = null;
    let foundName = '';

    const maxScrollRounds = 40;
    for (let round = 0; round < maxScrollRounds && !targetWrap; round++) {
      const wraps = await page.$$('.geek-item[data-id], .geek-item-wrap');
      for (const wrap of wraps) {
        const nameText = await wrap
          .$eval('.geek-name', (el) => (el.textContent ?? '').trim())
          .catch(() => '');
        const candidate = norm(nameText);
        if (!candidate) continue;
        if (matcher(candidate)) {
          targetWrap = wrap;
          foundName = candidate;
          break;
        }
      }
      if (targetWrap) break;

      const moved = await scrollChatListOnce(page);
      if (!moved) {
        break;
      }
      await sleepRandom(OPEN_CHAT_SCROLL_GAP_MS.min, OPEN_CHAT_SCROLL_GAP_MS.max);
    }

    if (!targetWrap) {
      throw new Error(`未在聊天列表中找到候选人：${targetName}`);
    }

    // 找到目标候选人后，先滚动到可见区域，再获取坐标点击
    const clickNameLiteral = JSON.stringify(foundName || targetName);
    const clickExactLiteral = JSON.stringify(exact);
    const scrolledToTarget = (await page.evaluate(`(() => {
      const targetName = ${clickNameLiteral};
      const exactMatch = ${clickExactLiteral};
      const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
      const matches = (value) => exactMatch ? value === targetName : value.includes(targetName);
      const wraps = Array.from(document.querySelectorAll(".geek-item[data-id], .geek-item-wrap"));
      const wrap = wraps.find((el) => matches(norm(el.querySelector(".geek-name")?.textContent)));
      if (!wrap) return false;
      const row = wrap.querySelector(".geek-item") || wrap;
      let node = row.parentElement;
      let scroller = null;
      while (node) {
        const style = window.getComputedStyle(node);
        const overflowY = style.overflowY;
        const canScroll =
          (overflowY === "auto" || overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight;
        if (canScroll) {
          scroller = node;
          break;
        }
        node = node.parentElement;
      }
      if (scroller) {
        const rowRect = row.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        scroller.scrollTop += rowRect.top - scrollerRect.top - (scroller.clientHeight - rowRect.height) / 2;
      } else {
        row.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
      }
      return true;
    })()`)) as boolean;
    if (!scrolledToTarget) {
      throw new Error(`未能重新定位候选人行：${foundName || targetName}`);
    }
    await sleepRandom(120, 220);
    const clickPoint = (await page.evaluate(`(() => {
      const targetName = ${clickNameLiteral};
      const exactMatch = ${clickExactLiteral};
      const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
      const matches = (value) => exactMatch ? value === targetName : value.includes(targetName);
      const wraps = Array.from(document.querySelectorAll(".geek-item[data-id], .geek-item-wrap"));
      const wrap = wraps.find((el) => matches(norm(el.querySelector(".geek-name")?.textContent)));
      if (!wrap) return null;
      const row = wrap.querySelector(".geek-item") || wrap;
      const rect = row.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    })()`)) as { x: number; y: number } | null;
    if (!clickPoint) {
      throw new Error(`未能重新定位候选人行：${foundName || targetName}`);
    }
    await page.mouse.click(clickPoint.x, clickPoint.y, { delay: 40 });

    // 点击后如果页面进入「右侧空白」异常状态（selected 已切换但详情面板未渲染），
    // 等待一小段时间后自动刷新页面恢复
    await sleepRandom(OPEN_CHAT_AFTER_ROW_CLICK_MS.min, OPEN_CHAT_AFTER_ROW_CLICK_MS.max);

    // 检测是否进入异常状态：selected 已切换但详情面板不存在或不可见
    const needRefresh = (await page.evaluate(`(() => {
      const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const selected = document.querySelector(".geek-item.selected");
      const selectedName = norm(selected?.querySelector(".geek-name")?.textContent);
      const detail = document.querySelector(".base-info-single-container");
      const detailVisible = isVisible(detail);
      // 如果 selected 有名字但详情面板不可见，说明页面卡住了
      return selectedName && !detailVisible;
    })()`)) as boolean;

    if (needRefresh) {
      await page.reload({ waitUntil: 'load', timeout: 60_000 });
      await ensureChatListReady(page);
      // 刷新后重新打开目标聊天
      await page.evaluate(`(() => {
        const targetName = ${clickNameLiteral};
        const exactMatch = ${clickExactLiteral};
        const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
        const matches = (value) => exactMatch ? value === targetName : value.includes(targetName);
        const wraps = Array.from(document.querySelectorAll(".geek-item[data-id], .geek-item-wrap"));
        const wrap = wraps.find((el) => matches(norm(el.querySelector(".geek-name")?.textContent)));
        if (!wrap) return;
        const row = wrap.querySelector(".geek-item") || wrap;
        row.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
      })()`);
      await sleepRandom(120, 220);
      const retryPoint = (await page.evaluate(`(() => {
        const targetName = ${clickNameLiteral};
        const exactMatch = ${clickExactLiteral};
        const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
        const matches = (value) => exactMatch ? value === targetName : value.includes(targetName);
        const wraps = Array.from(document.querySelectorAll(".geek-item[data-id], .geek-item-wrap"));
        const wrap = wraps.find((el) => matches(norm(el.querySelector(".geek-name")?.textContent)));
        if (!wrap) return null;
        const row = wrap.querySelector(".geek-item") || wrap;
        const rect = row.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`)) as { x: number; y: number } | null;
      if (retryPoint) {
        await page.mouse.click(retryPoint.x, retryPoint.y, { delay: 40 });
        await sleepRandom(OPEN_CHAT_AFTER_ROW_CLICK_MS.min, OPEN_CHAT_AFTER_ROW_CLICK_MS.max);
      }
    }

    try {
      const expectedNameLiteral = JSON.stringify(foundName || targetName);
      const exactLiteral = JSON.stringify(exact);
      await page.waitForFunction(
        `(() => {
          const name = ${expectedNameLiteral};
          const exactMatch = ${exactLiteral};
          const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
          const matches = (value) => exactMatch ? value === name : value.includes(name);
          const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const selected = Array.from(document.querySelectorAll(".geek-item.selected")).find(isVisible);
          const selectedName = norm(selected?.querySelector(".geek-name")?.textContent);
          const root = Array.from(document.querySelectorAll(".base-info-single-container")).find(isVisible);
          const detailName = norm(root?.querySelector(".name-box")?.textContent);
          return matches(selectedName) && matches(detailName);
        })()`,
        { timeout: 15_000 },
      );
      await page.waitForFunction(
        `(() => {
          const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const lists = Array.from(document.querySelectorAll(".chat-message-list")).filter(isVisible);
          const list = lists[lists.length - 1];
          if (!list) return false;
          const items = list.querySelectorAll(".message-item");
          if (!items || items.length === 0) return false;
          const hasText = Array.from(items).some((item) => {
            const txt =
              item.querySelector(".item-friend .text span")?.textContent ??
              item.querySelector(".item-myself .text span")?.textContent ??
              item.querySelector(".item-system .message-card-top-title")?.textContent ??
              "";
            return txt.replace(/\\s+/g, " ").trim().length > 0;
          });
          return hasText;
        })()`,
        { timeout: 20_000 },
      );
    } catch {
      const state = (await page.evaluate(`(() => {
        const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const selected = Array.from(document.querySelectorAll(".geek-item.selected")).find(isVisible);
        const root = Array.from(document.querySelectorAll(".base-info-single-container")).find(isVisible);
        return {
          selectedName: norm(selected?.querySelector(".geek-name")?.textContent),
          detailName: norm(root?.querySelector(".name-box")?.textContent),
        };
      })()`)) as { selectedName: string; detailName: string };
      throw new Error(
        `已尝试点击 ${foundName}，但未检测到对应聊天详情面板（selected=${state.selectedName || '空'}，detail=${state.detailName || '空'}）。`,
      );
    }

    let fullMessages: Array<{
      time: string;
      from: ChatFrom;
      text: string;
    }> = [];
    let hasFriendResumeAttachment = false;
    const scraped = (await page.evaluate(`(() => {
      const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      /** Boss 系统里的「消息优先提醒」增值服务条，对业务无意义，过滤掉 */
      function isBossPriorityUpsellSystemText(text) {
        return norm(text).indexOf("优先提醒") !== -1;
      }
      const lists = Array.from(document.querySelectorAll(".chat-message-list")).filter(isVisible);
      const list = lists[lists.length - 1];
      if (!list) {
        throw new Error("未找到可见聊天消息列表（.chat-message-list）。");
      }
      const items = Array.from(list.querySelectorAll(".message-item"));
      let currentTime = "";
      const messages = [];
      let hasFriendResumeAttachment = false;
      for (const item of items) {
        const timeNode = item.querySelector(".message-time .time");
        if (timeNode) {
          const t = norm(timeNode.textContent);
          if (t) currentTime = t;
        }
        const friendRoot = item.querySelector(".item-friend");
        let friendText = "";
        if (friendRoot) {
          friendText = norm(friendRoot.querySelector(".text > span")?.textContent);
          if (!friendText) {
            const resumeIcon = friendRoot.querySelector(".resume-icon");
            const title = norm(friendRoot.querySelector(".message-card-top-title")?.textContent);
            const cardBtn = norm(friendRoot.querySelector(".message-card-buttons .card-btn")?.textContent);
            if (resumeIcon) hasFriendResumeAttachment = true;
            if (title || cardBtn) {
              const parts = [];
              if (title) parts.push(title);
              if (cardBtn) parts.push(cardBtn);
              friendText = parts.length ? parts.join(" · ") : "";
            }
            if (!friendText) friendText = norm(friendRoot.querySelector(".text")?.textContent);
          }
        }
        const myselfText = norm(item.querySelector(".item-myself .text span")?.textContent);
        const systemText =
          norm(item.querySelector(".item-system .message-card-top-title")?.textContent) ||
          norm(item.querySelector(".item-system .text span")?.textContent);
        if (friendText) {
          messages.push({ text: friendText, time: currentTime, from: "friend" });
        } else if (myselfText) {
          messages.push({ text: myselfText, time: currentTime, from: "myself" });
        } else if (systemText) {
          if (!isBossPriorityUpsellSystemText(systemText)) {
            messages.push({ text: systemText, time: currentTime, from: "system" });
          }
        }
      }
      return { messages, hasFriendResumeAttachment };
    })()`)) as {
      messages: Array<{
        time: string;
        from: 'friend' | 'myself' | 'system' | 'unknown';
        text: string;
      }>;
      hasFriendResumeAttachment: boolean;
    };
    fullMessages = scraped.messages;
    hasFriendResumeAttachment = scraped.hasFriendResumeAttachment;

    const detailLines = fullMessages.map((m) => {
      const tag = chatRoleTag(m.from);
      const timePart = m.time ? ` ${m.time}` : '';
      return `${tag}${timePart} ${m.text}`.trimEnd();
    });

    const resumeStatus = hasFriendResumeAttachment ? '已获取' : '未获取';
    const summary = await fetchCandidateSummary(page, foundName || targetName, exact);

    const out: string[] = [
      `成功进入候选人聊天：${foundName}`,
      `简历获取状态: ${resumeStatus}`,
    ];
    const summaryLines: string[] = [];
    const summaryName = summary.name || foundName || targetName;
    summaryLines.push(`姓名: ${summaryName}`);
    if (summary.active) {
      summaryLines.push(`活跃状态: ${summary.active}`);
    }
    if (summary.basicFacts.length > 0) {
      summaryLines.push(`基本信息: ${summary.basicFacts.join(' / ')}`);
    }
    if (summary.communicationPosition) {
      summaryLines.push(`沟通职位: ${summary.communicationPosition}`);
    }
    if (summary.expectation) {
      summaryLines.push(`期望: ${summary.expectation}`);
    }
    if (summary.recentExperience.length > 0) {
      summaryLines.push('近期经历:');
      summary.recentExperience.forEach((it, idx) => {
        summaryLines.push(`${idx + 1}. ${it}`);
      });
    }
    if (summaryLines.length > 0) {
      out.push('', '人才摘要：', '', ...summaryLines);
    }
    if (summary.remark) {
      out.push('', `备注: ${summary.remark}`);
    }
    out.push('', '完整聊天消息：');
    if (detailLines.length > 0) {
      out.push('', ...detailLines);
    } else {
      out.push('', '(暂无)');
    }
    return { text: out.join('\n'), foundName: foundName || targetName };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof Error) {
      throw e;
    }
    throw new Error(`打开候选人聊天失败：${message}`);
  }
}

/** 按 BOSS 沟通身份精确打开会话，不使用姓名或列表序号。uid 支持 encryptUid / uniqueId / friendId 三种格式。 */
export async function runOpenCandidateChatByUid(
  page: Page,
  encryptUid: string,
  filter?: string,
): Promise<{ text: string; foundName: string; uniqueId: string }> {
  const targetUid = encryptUid.trim();
  if (!targetUid) {
    throw new Error('请提供候选人 encryptUid。');
  }
  // uniqueId（friendId-source）是行稳定标识，直接按 data-id 匹配；encryptUid 会轮换；
  // 裸 friendId 按 data-id 前缀匹配（friendId-source 中的 friendId 段）
  const targetIsUniqueId = /^\d+-\d+$/.test(targetUid);
  const targetIsFriendId = !targetIsUniqueId && /^\d+$/.test(targetUid);
  const targetKind: 'uniqueId' | 'friendId' | 'encryptUid' =
    targetIsUniqueId ? 'uniqueId' : targetIsFriendId ? 'friendId' : 'encryptUid';

  // 点击后确认偶发失败（批量操作时列表重排/未稳定即点击），整轮重试
  const maxAttempts = 3;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await openChatByUidOnce(page, { targetUid, targetKind, filter: filter || 'all' });
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      await sleepRandom(350, 700);
    }
  }
  throw (lastError ?? new Error(`按 encryptUid 打开候选人聊天失败：${targetUid}`));
}

/** 单次尝试：定位 uid 行 → 点击 → 确认目标会话；失败抛出（由上层整轮重试）。 */
async function openChatByUidOnce(
  page: Page,
  opts: { targetUid: string; targetKind: 'uniqueId' | 'friendId' | 'encryptUid'; filter: string },
): Promise<{ text: string; foundName: string; uniqueId: string }> {
  const { targetUid, targetKind, filter } = opts;

  // 与收集时保持同一分类视图：data-id 只在产生它的视图里稳定
  await ensureChatListReady(page, filter);
  if (!isBossChatIndexUrl(page.url())) {
    throw new Error('当前不在沟通列表页（/web/chat/index），无法按 encryptUid 打开候选人聊天。');
  }

  const seenUniqueIds = new Set<string>();
  let matchedUniqueId = '';
  let matchedName = '';
  const maxScrollRounds = 40;

  for (let round = 0; round < maxScrollRounds; round++) {
    const uniqueIds = (await page.evaluate(`(() =>
      Array.from(document.querySelectorAll(".geek-item[data-id]"))
        .map((el) => String(el.getAttribute("data-id") || "").trim())
        .filter(Boolean)
    )()`)) as string[];
    const pendingIds = uniqueIds.filter((id) => !seenUniqueIds.has(id));
    pendingIds.forEach((id) => seenUniqueIds.add(id));

    if (targetKind === 'uniqueId' || targetKind === 'friendId') {
      const rows = (await page.evaluate(`(() =>
        Array.from(document.querySelectorAll(".geek-item[data-id]")).map((el) => ({
          uid: String(el.getAttribute("data-id") || "").trim(),
          name: (el.querySelector(".geek-name")?.textContent ?? "").replace(/\s+/g, " ").trim(),
        })))()`)) as Array<{ uid: string; name: string }>;
      const hit = targetKind === 'uniqueId'
        ? rows.find((r) => r.uid === targetUid)
        : rows.find((r) => r.uid.startsWith(`${targetUid}-`));
      if (hit) {
        matchedUniqueId = hit.uid;
        matchedName = hit.name;
        break;
      }
    } else {
      for (let start = 0; start < pendingIds.length; start += 100) {
        const identities = await fetchBossChatIdentities(page, pendingIds.slice(start, start + 100));
        const matched = identities.find((item) => item.encryptUid === targetUid);
        if (matched) {
          matchedUniqueId = matched.uniqueId;
          matchedName = matched.name;
          break;
        }
      }
    }
    if (matchedUniqueId) break;

    const moved = await scrollChatListOnce(page);
    if (!moved) break;
    await sleepRandom(OPEN_CHAT_SCROLL_GAP_MS.min, OPEN_CHAT_SCROLL_GAP_MS.max);
  }

  if (!matchedUniqueId) {
    throw new Error(`沟通列表查找范围内未找到${targetKind}：${targetUid}；分类 ${filter}，已检查 ${seenUniqueIds.size} 条唯一记录，最多滚动 ${maxScrollRounds} 轮`);
  }

  const clickPoint = (await page.evaluate(`(() => {
    const uniqueId = ${JSON.stringify(matchedUniqueId)};
    const row = Array.from(document.querySelectorAll(".geek-item[data-id]"))
      .find((el) => el.getAttribute("data-id") === uniqueId);
    if (!row) return null;
    row.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
    const rect = row.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)) as { x: number; y: number } | null;
  if (!clickPoint) {
    throw new Error(`已解析 encryptUid，但对应沟通行不在页面中：${matchedUniqueId}`);
  }

  await page.mouse.click(clickPoint.x, clickPoint.y, { delay: 40 });
  await sleepRandom(OPEN_CHAT_AFTER_ROW_CLICK_MS.min, OPEN_CHAT_AFTER_ROW_CLICK_MS.max);
  let selected = { matched: false, name: '' };
  const confirmDeadline = Date.now() + 6_000;
  while (Date.now() < confirmDeadline) {
    selected = (await page.evaluate(`(() => {
      const expected = ${JSON.stringify(matchedUniqueId)};
      const row = document.querySelector(".geek-item.selected");
      const detail = document.querySelector(".base-info-single-container");
      const norm = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
      return {
        matched: row?.getAttribute("data-id") === expected && !!detail,
        name: norm(detail?.querySelector(".name-box")?.textContent)
      };
    })()`)) as { matched: boolean; name: string };
    if (selected.matched) break;
    await sleepRandom(220, 360);
  }
  if (!selected.matched) {
    throw new Error(`按 ${targetKind} 点击后未能确认目标会话：${targetUid}`);
  }

  const foundName = selected.name || matchedName || targetUid;
  return {
    text: await renderOpenedCandidateChat(page, foundName),
    foundName,
    uniqueId: matchedUniqueId,
  };
}

/**
 * 解析当前会话的 BOSS 沟通身份：
 * 优先使用打开阶段已确认的 uniqueId；未提供时读左侧列表选中行，
 * 选中行姓名与详情姓名不一致时返回 null（拒绝把身份绑到别人头上）。
 * 身份接口只用于富化 encryptUid/securityId；接口异常直接抛出不掩盖。
 */
async function resolveChatIdentityForJson(
  page: Page,
  candidateName: string,
  openedUniqueId?: string,
): Promise<BossChatIdentity | null> {
  let uniqueId = (openedUniqueId ?? '').trim();
  if (!uniqueId) {
    const selected = (await page.evaluate(`(() => {
      const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
      const row = document.querySelector(".geek-item.selected");
      if (!row) return null;
      return {
        uid: String(row.getAttribute("data-id") || "").trim(),
        name: norm(row.querySelector(".geek-name")?.textContent),
      };
    })()`)) as { uid: string; name: string } | null;
    if (!selected || !selected.uid) return null;
    const expected = candidateName.replace(/\s+/g, ' ').trim();
    if (!selected.name || selected.name !== expected) return null;
    uniqueId = selected.uid;
  }
  const parsed = parseBossChatUniqueId(uniqueId);
  if (!parsed) {
    throw new Error(`当前会话行 data-id 非法（应为 friendId-friendSource）：${uniqueId}`);
  }
  const identities = await fetchBossChatIdentities(page, [uniqueId]);
  const enriched = identities.find((item) => item.uniqueId === uniqueId);
  return {
    uniqueId,
    friendId: parsed.friendId,
    friendSource: parsed.friendSource,
    encryptUid: enriched?.encryptUid ?? '',
    encryptJobId: enriched?.encryptJobId ?? '',
    securityId: enriched?.securityId ?? '',
    name: enriched?.name ?? candidateName,
  };
}

/**
 * 在当前已打开的候选人聊天页抓取结构化聊天详情（供 --json / messages 表写入）。
 * 前置：已通过 {@link runOpenCandidateChat} 打开候选人聊天；
 * candidateName 应传打开阶段实际命中的姓名（其返回值的 foundName），此处按精确匹配定位详情容器。
 * identity.uniqueId 传打开阶段确认的沟通行标识；缺省时从列表选中行解析。
 */
export async function runGetCurrentChatJson(
  page: Page,
  candidateName: string,
  identity?: { uniqueId?: string },
): Promise<BossChatDetail> {
  const scraped = await scrapeCurrentChatMessages(page);
  const summary = await fetchCandidateSummary(page, candidateName, true);
  const chatIdentity = await resolveChatIdentityForJson(page, candidateName, identity?.uniqueId);

  const messages: BossChatMessage[] = scraped.messages.map((m) => ({
    time: m.time,
    direction: m.from === 'friend' ? 'in' : m.from === 'myself' ? 'out' : 'system',
    content: m.text,
  }));

  return {
    ...(chatIdentity?.encryptUid ? { encryptUid: chatIdentity.encryptUid } : {}),
    ...(chatIdentity ? { uniqueId: chatIdentity.uniqueId } : {}),
    ...(chatIdentity ? { friendId: chatIdentity.friendId } : {}),
    ...(chatIdentity ? { friendSource: chatIdentity.friendSource } : {}),
    ...(chatIdentity?.securityId ? { securityId: chatIdentity.securityId } : {}),
    name: summary.name || candidateName,
    job: summary.communicationPosition,
    active: summary.active,
    basicFacts: summary.basicFacts,
    expectation: summary.expectation,
    recentExperience: summary.recentExperience,
    remark: summary.remark,
    hasResumeAttachment: scraped.hasFriendResumeAttachment,
    messages,
    scrapedAt: new Date().toISOString(),
  };
}
