import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import {
  ONLINE_RESUME_IFRAME_WAIT_MAX_MS,
  selectAllModifierKey,
  sleepRandom,
  snapshotBossPageViewport,
} from '../browser/index.js';
import { isBossChatIndexUrl } from '../common/auth.js';
import {
  closeBossPaywallPopupIfPresent,
  describeBossPaywallPopupIfPresent,
  waitForCResumeIframeOrPaywall,
} from '../common/boss_paywall_popup.js';
import {
  captureCResumeIframeToFile,
  closeCResumePanel,
  safeResumeScreenshotFileBase,
  waitForVisibleCResumeIframeReady,
} from '../common/c_resume_capture.js';
import { ensureAppDataLayout, RESUME_ATTACHMENTS_DIR, RESUME_SCREENSHOTS_DIR } from '../config.js';
import { isResumeOcrEnabled, ocrResumePngToTextFile } from '../ocr/index.js';
import { runGetCommunicationHistory } from './chat.js';

/** 文件名时间戳：2026-08-04 17-08-09（与 preview.ts 在线简历截图命名对齐） */
function formatFileTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

type IncomingCardBtn = 'agree' | 'refuse';

function ensureInCandidateChat(page: Page, actionLabel: string): Promise<void> {
  return (async () => {
    const currentUrl = page.url();
    if (!isBossChatIndexUrl(currentUrl)) {
      throw new Error('请先进入聊天列表页（/web/chat/index）并打开候选人聊天。');
    }
    const inCandidateChat = await page.$('.base-info-single-container');
    if (!inCandidateChat) {
      throw new Error(`请先打开候选人聊天详情页，再执行“${actionLabel}”操作。`);
    }
  })();
}

/**
 * 在聊天页右侧操作区执行「不合适」：该入口依赖 hover 后才响应真实点击，先派发 hover 再点一次。
 */
async function markCandidateNotFitWithoutReason(page: Page): Promise<string> {
  await ensureInCandidateChat(page, '不合适');

  const hovered = (await page.evaluate(`(() => {
    const norm = (v) => (v ?? "").replace(/\\s+/g, "").trim();
    function fireHover(el) {
      if (!(el instanceof HTMLElement)) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      ["mouseover", "mouseenter", "mousemove"].forEach((type) => {
        el.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }),
        );
      });
    }
    const roots = Array.from(document.querySelectorAll(".operate-exchange-right .operate-icon-item, .operate-icon-item"));
    const target = roots.find((el) => {
      const t = norm(el.querySelector(".operate-btn")?.textContent || el.textContent || "");
      return t.includes("不合适");
    });
    if (!target) return false;
    target.scrollIntoView({ block: "center", inline: "nearest" });
    fireHover(target);
    const btn = target.querySelector(".operate-btn");
    if (btn instanceof HTMLElement) fireHover(btn);
    return true;
  })()`)) as boolean;
  if (!hovered) {
    throw new Error('未找到“不合适”按钮，无法执行操作。');
  }

  await sleepRandom(200, 450);

  const clicked = (await page.evaluate(`(() => {
    const norm = (v) => (v ?? "").replace(/\\s+/g, "").trim();
    const roots = Array.from(document.querySelectorAll(".operate-exchange-right .operate-icon-item, .operate-icon-item"));
    const target = roots.find((el) => {
      const t = norm(el.querySelector(".operate-btn")?.textContent || el.textContent || "");
      return t.includes("不合适");
    });
    if (!target) return false;
    const btn = target.querySelector(".operate-btn");
    const host = btn instanceof HTMLElement ? btn : target;
    host.scrollIntoView({ block: "center", inline: "nearest" });
    host.click();
    return true;
  })()`)) as boolean;
  if (!clicked) {
    throw new Error('未找到“不合适”按钮，无法执行点击。');
  }

  await sleepRandom(320, 780);
  return '已点击「不合适」。';
}

/** 在聊天页右侧操作区点击「换微信」。 */
async function runExchangeWechat(page: Page): Promise<string> {
  await ensureInCandidateChat(page, '换微信');

  const availability = (await page.evaluate(`(() => {
    const norm = (v) => (v ?? "").replace(/\\s+/g, "");
    const items = Array.from(
      document.querySelectorAll(".operate-exchange-left .operate-icon-item, .operate-icon-item"),
    );
    const target = items.find((el) => norm(el.querySelector(".operate-btn")?.textContent).includes("换微信"));
    if (!target) return { found: false, available: false };
    const btn = target.querySelector(".operate-btn");
    const className = [target.className ?? "", btn?.className ?? ""].join(" ");
    const disabled = /disabled|forbid|ban/i.test(className) || btn?.getAttribute("disabled") !== null;
    return { found: true, available: !disabled };
  })()`)) as { found: boolean; available: boolean };
  if (!availability.found) {
    throw new Error('未找到“换微信”按钮，当前页面可能不支持该操作。');
  }
  if (!availability.available) {
    throw new Error('当前“换微信”按钮不可用，请先确认会话状态是否满足交换条件。');
  }

  await sleepRandom(220, 620);

  const clicked = (await page.evaluate(`(() => {
    const norm = (v) => (v ?? "").replace(/\\s+/g, "");
    const items = Array.from(
      document.querySelectorAll(".operate-exchange-left .operate-icon-item, .operate-icon-item"),
    );
    const target = items.find((el) => norm(el.querySelector(".operate-btn")?.textContent).includes("换微信"));
    if (!target) return false;
    const btn = target.querySelector(".operate-btn");
    const host = btn instanceof HTMLElement ? btn : target;
    host.scrollIntoView({ block: "center", inline: "nearest" });
    host.click();
    return true;
  })()`)) as boolean;
  if (!clicked) {
    throw new Error('点击“换微信”失败，请确认当前会话是否仍处于可操作状态。');
  }

  await sleepRandom(280, 520);

  await page.waitForFunction(
    `(() => {
      function isVisible(el) {
        if (!(el instanceof HTMLElement)) return false;
        const st = window.getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      const tips = Array.from(document.querySelectorAll(".exchange-tooltip"));
      for (const tip of tips) {
        if (!isVisible(tip)) continue;
        const raw = (tip.textContent ?? "").replace(/\\s+/g, "");
        if (!raw.includes("交换微信")) continue;
        const primary = tip.querySelector(".btn-box .boss-btn-primary");
        return primary instanceof HTMLElement;
      }
      return false;
    })()`,
    { timeout: 12_000 },
  );

  const confirmed = (await page.evaluate(`(() => {
    function isVisible(el) {
      if (!(el instanceof HTMLElement)) return false;
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function norm(v) {
      return (v ?? "").replace(/\\s+/g, "").trim();
    }
    const tips = Array.from(document.querySelectorAll(".exchange-tooltip"));
    for (const tip of tips) {
      if (!isVisible(tip)) continue;
      if (!norm(tip.textContent).includes("交换微信")) continue;
      const primary = tip.querySelector(".btn-box .boss-btn-primary.boss-btn, .btn-box .boss-btn-primary");
      if (!(primary instanceof HTMLElement)) continue;
      if (!norm(primary.textContent).includes("确定")) continue;
      primary.scrollIntoView({ block: "center", inline: "nearest" });
      primary.click();
      return true;
    }
    return false;
  })()`)) as boolean;
  if (!confirmed) {
    throw new Error('已弹出交换微信确认框，但未点到「确定」按钮。');
  }

  await sleepRandom(320, 780);
  return '已点击「换微信」并在弹窗中确认。';
}

/**
 * 在聊天页左侧工具栏点击「求简历」，并在确认弹窗中点「确定」。
 * 平台规则：双方需各至少发送一条消息后该入口才可点；否则按钮为禁用态。
 */
export async function runRequestAttachmentResume(page: Page): Promise<string> {
  await ensureInCandidateChat(page, '求简历');

  const availability = (await page.evaluate(`(() => {
    const norm = (v) => (v ?? "").replace(/\\s+/g, "");
    const items = Array.from(
      document.querySelectorAll(".operate-exchange-left .operate-icon-item, .operate-icon-item"),
    );
    const target = items.find((el) => norm(el.querySelector(".operate-btn")?.textContent).includes("求简历"));
    if (!target) return { found: false, available: false };
    const btn = target.querySelector(".operate-btn");
    const className = [target.className ?? "", btn?.className ?? ""].join(" ");
    const disabled = /disabled|forbid|ban/i.test(className) || btn?.getAttribute("disabled") !== null;
    return { found: true, available: !disabled };
  })()`)) as { found: boolean; available: boolean };
  if (!availability.found) {
    throw new Error('未找到「求简历」按钮，当前页面可能不支持该操作。');
  }
  if (!availability.available) {
    throw new Error(
      '当前「求简历」不可用。Boss 要求双方各至少发送一条消息后才可以向对方请求附件简历，请先与对方互发消息后再试。',
    );
  }

  await sleepRandom(220, 620);

  const clicked = (await page.evaluate(`(() => {
    const norm = (v) => (v ?? "").replace(/\\s+/g, "");
    const items = Array.from(
      document.querySelectorAll(".operate-exchange-left .operate-icon-item, .operate-icon-item"),
    );
    const target = items.find((el) => norm(el.querySelector(".operate-btn")?.textContent).includes("求简历"));
    if (!target) return false;
    const btn = target.querySelector(".operate-btn");
    const host = btn instanceof HTMLElement ? btn : target;
    host.scrollIntoView({ block: "center", inline: "nearest" });
    host.click();
    return true;
  })()`)) as boolean;
  if (!clicked) {
    throw new Error('点击「求简历」失败，请确认当前会话是否仍处于可操作状态。');
  }

  await sleepRandom(280, 520);

  await page.waitForFunction(
    `(() => {
      function isVisible(el) {
        if (!(el instanceof HTMLElement)) return false;
        const st = window.getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      const tips = Array.from(document.querySelectorAll(".exchange-tooltip"));
      for (const tip of tips) {
        if (!isVisible(tip)) continue;
        const raw = (tip.textContent ?? "").replace(/\\s+/g, "");
        if (!raw.includes("索取简历")) continue;
        const primary = tip.querySelector(".btn-box .boss-btn-primary");
        return primary instanceof HTMLElement;
      }
      return false;
    })()`,
    { timeout: 12_000 },
  );

  const confirmed = (await page.evaluate(`(() => {
    function isVisible(el) {
      if (!(el instanceof HTMLElement)) return false;
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function norm(v) {
      return (v ?? "").replace(/\\s+/g, "").trim();
    }
    const tips = Array.from(document.querySelectorAll(".exchange-tooltip"));
    for (const tip of tips) {
      if (!isVisible(tip)) continue;
      if (!norm(tip.textContent).includes("索取简历")) continue;
      const primary = tip.querySelector(".btn-box .boss-btn-primary.boss-btn, .btn-box .boss-btn-primary");
      if (!(primary instanceof HTMLElement)) continue;
      if (!norm(primary.textContent).includes("确定")) continue;
      primary.scrollIntoView({ block: "center", inline: "nearest" });
      primary.click();
      return true;
    }
    return false;
  })()`)) as boolean;
  if (!confirmed) {
    throw new Error('已弹出求简历确认框，但未点到「确定」按钮。');
  }

  await sleepRandom(320, 780);
  return '已点击「求简历」并在弹窗中确认（将发送默认话术「方便发一份你的简历过来吗？」）。';
}

/**
 * 在聊天页通过「更多 -> 备注」更新候选人备注，并点击确认保存。
 */
async function updateCandidateRemark(page: Page, remarkText: string): Promise<string> {
  const nextRemark = remarkText.trim();
  if (!nextRemark) {
    throw new Error('备注内容不能为空。');
  }
  if (nextRemark.length > 120) {
    throw new Error(`备注内容过长（${nextRemark.length}/120），请缩短后重试。`);
  }

  await ensureInCandidateChat(page, '备注');

  const openedMoreMenu = (await page.evaluate(`(() => {
    function isVisible(el) {
      if (!(el instanceof HTMLElement)) return false;
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    const popovers = Array.from(document.querySelectorAll(".rightbar-item .popover"))
      .filter((el) => !!el.querySelector(".popover-wrap.rightbar-more-tooltip"));
    if (popovers.length === 0) return false;
    const popover = popovers[popovers.length - 1];
    const host = popover.querySelector(".icon") || popover;
    host.scrollIntoView({ block: "center", inline: "nearest" });
    host.click();
    const wrap = popover.querySelector(".popover-wrap.rightbar-more-tooltip");
    return !!wrap && isVisible(wrap);
  })()`)) as boolean;
  if (!openedMoreMenu) {
    throw new Error('未找到右侧“更多”按钮（rightbar-more），无法打开备注菜单。');
  }

  await sleepRandom(120, 300);

  const clickedRemarkItem = (await page.evaluate(`(() => {
    function norm(v) {
      return (v ?? "").replace(/\\s+/g, "").trim();
    }
    function isVisible(el) {
      if (!(el instanceof HTMLElement)) return false;
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    const wraps = Array.from(document.querySelectorAll(".popover-wrap.rightbar-more-tooltip"))
      .filter((el) => isVisible(el));
    if (wraps.length === 0) return false;
    const wrap = wraps[wraps.length - 1];
    const items = Array.from(wrap.querySelectorAll(".more-list .item"))
      .filter((el) => isVisible(el));
    const remark = items.find((el) => norm(el.textContent).includes("备注"));
    if (!remark) return false;
    remark.scrollIntoView({ block: "center", inline: "nearest" });
    remark.click();
    return true;
  })()`)) as boolean;
  if (!clickedRemarkItem) {
    throw new Error('未找到“备注”菜单项，无法打开备注弹窗。');
  }

  const textareaSel =
    '.boss-dialog__wrapper.dialog-default-v2 .dialog-geek-remark textarea.input, ' +
    '.boss-popup__wrapper.dialog-default-v2 .dialog-geek-remark textarea.input';
  const textarea = await page.waitForSelector(textareaSel, { timeout: 12_000 }).catch(() => null);
  if (!textarea) {
    throw new Error('已点击“备注”，但未出现备注输入弹窗。');
  }
  await sleepRandom(260, 520);

  await page.click(textareaSel);
  await sleepRandom(80, 180);
  const selectAllMod = selectAllModifierKey();
  await page.keyboard.down(selectAllMod);
  await page.keyboard.press('KeyA');
  await page.keyboard.up(selectAllMod);
  await sleepRandom(50, 140);
  await page.keyboard.press('Backspace');
  await sleepRandom(120, 260);
  await page.type(textareaSel, nextRemark, { delay: 24 });
  await sleepRandom(200, 360);

  const filledOk = (await page.evaluate(
    `((selector, expected) => {
      const el = document.querySelector(selector);
      if (!(el instanceof HTMLTextAreaElement)) return false;
      return (el.value ?? "").trim() === expected;
    })`,
    textareaSel,
    nextRemark,
  )) as boolean;
  if (!filledOk) {
    throw new Error('备注输入未生效，请重试。');
  }

  const confirmed = (await page.evaluate(`(() => {
    function norm(v) {
      return (v ?? "").replace(/\\s+/g, "").trim();
    }
    function isVisible(el) {
      if (!(el instanceof HTMLElement)) return false;
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    const wrappers = Array.from(document.querySelectorAll(".dialog-default-v2"))
      .filter((el) => isVisible(el) && !!el.querySelector(".dialog-geek-remark"));
    if (wrappers.length === 0) return false;
    const wrapper = wrappers[wrappers.length - 1];
    const buttons = Array.from(wrapper.querySelectorAll(".boss-dialog__footer .boss-dialog__button, .boss-btn"))
      .filter((el) => isVisible(el));
    const confirmBtn = buttons.find((el) => norm(el.textContent).includes("确认"));
    if (!confirmBtn) return false;
    confirmBtn.scrollIntoView({ block: "center", inline: "nearest" });
    confirmBtn.click();
    return true;
  })()`)) as boolean;
  if (!confirmed) {
    throw new Error('已填写备注，但未找到“确认”按钮。');
  }

  await sleepRandom(220, 580);
  return `已更新备注: ${nextRemark}`;
}

/**
 * 对方「附件简历」确认卡片上点击「同意」。
 * 对应按钮 disabled 时视为已处理。
 */
async function runIncomingResumeCardAction(page: Page, which: IncomingCardBtn): Promise<string> {
  await ensureInCandidateChat(page, '附件简历处理');
  await sleepRandom(200, 550);

  const result = (await page.evaluate((w: 'agree' | 'refuse') => {
    function norm(v: string | null | undefined) {
      return (v ?? "").replace(/\\s+/g, " ").trim();
    }
    function isDisabledBtn(el: Element) {
      const cls = el.className ?? "";
      if (/disabled|forbid|ban/i.test(cls)) return true;
      if (el.getAttribute("disabled") !== null) return true;
      const st = window.getComputedStyle(el);
      return st.pointerEvents === "none" || Number(st.opacity) < 0.35;
    }
    function matchesLabel(t: string, mode: string) {
      if (mode === "agree") {
        return t === "同意" || t.indexOf("同意") === 0;
      }
      return t === "拒绝" || t.indexOf("拒绝") === 0;
    }
    const items = Array.from(document.querySelectorAll(".chat-message-list .message-item"));
    for (let i = items.length - 1; i >= 0; i--) {
      const friend = items[i].querySelector(".item-friend");
      if (!friend) continue;
      const title = norm(friend.querySelector(".message-card-top-title")?.textContent);
      if (!title || title.indexOf("附件简历") === -1) continue;
      const buttons = friend.querySelectorAll(".message-card-buttons .card-btn");
      for (let j = 0; j < buttons.length; j++) {
        const btn = buttons[j];
        const t = norm(btn.textContent);
        if (!matchesLabel(t, w)) continue;
        if (isDisabledBtn(btn)) {
          return { kind: "already_handled", which: w };
        }
        (btn as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
        (btn as HTMLElement).click();
        return { kind: "clicked", which: w };
      }
    }
    return { kind: "not_found", which: w };
  }, which)) as
    | { kind: 'clicked'; which: IncomingCardBtn }
    | { kind: 'already_handled'; which: IncomingCardBtn }
    | { kind: 'not_found'; which: IncomingCardBtn };

  if (result.kind === 'not_found') {
    throw new Error('未找到待处理的「对方发送附件简历」确认卡片（标题需含「附件简历」）。');
  }
  if (result.kind === 'already_handled') {
    return result.which === 'agree'
      ? '对方发来的附件简历请求已处理（同意按钮已禁用）。'
      : '对方发来的附件简历请求已处理（拒绝按钮已禁用）。';
  }
  await sleepRandom(350, 900);
  return result.which === 'agree'
    ? '已点击「同意」，接受对方发送的附件简历。'
    : '已点击「拒绝」，拒绝接收对方附件简历。';
}

async function getCandidateInfoForResumeShot(page: Page): Promise<{ name: string; job: string }> {
  const info = (await page.evaluate(`(() => {
    const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
    const name = norm(document.querySelector(".base-info-single-container .name-box")?.textContent);
    const job = norm(document.querySelector(".position-item .position-name")?.textContent);
    return { name, job };
  })()`)) as { name: string; job: string };
  return { name: info.name || 'candidate', job: info.job || '' };
}

/** 简历文件名片段：岗位-姓名（岗位缺省时只姓名），均已做文件名安全处理 */
function buildResumeNamePart(info: { name: string; job: string }): string {
  const name = safeResumeScreenshotFileBase(info.name);
  const job = info.job.trim() ? `${safeResumeScreenshotFileBase(info.job)}-` : '';
  return `${job}${name}`;
}

/**
 * 点击「在线简历」，对 `iframe` 元素整框截图（含视口外部分，见 `captureBeyondViewport`）。
 * 不依赖 `contentFrame()`，与内页是否 canvas / 跨域无关。
 *
 * 进入前记录视口（`snapshotBossPageViewport`，见 {@link captureCResumeIframeToFile}）。
 */
async function captureOnlineResumeScreenshot(page: Page, candidateInfo: { name: string; job: string }): Promise<string | null> {
  ensureAppDataLayout();

  const savedViewport = await snapshotBossPageViewport(page);

  const opened = await page.evaluate(() => {
    const a = document.querySelector('a.resume-btn-online') as HTMLAnchorElement | null;
    if (!a || a.classList.contains('disabled')) return false;
    a.scrollIntoView({ block: 'center', inline: 'nearest' });
    a.click();
    return true;
  });
  if (!opened) {
    return null;
  }

  const outcome = await waitForCResumeIframeOrPaywall(page, ONLINE_RESUME_IFRAME_WAIT_MAX_MS);
  if (outcome !== 'iframe') {
    const paywall = await describeBossPaywallPopupIfPresent(page);
    await closeBossPaywallPopupIfPresent(page);
    if (paywall) {
      throw new Error(paywall);
    }
    return null;
  }

  const ready = await waitForVisibleCResumeIframeReady(page);
  if (!ready) {
    await closeCResumePanel(page);
    return null;
  }

  const fileName = `BOSS-在线简历-${buildResumeNamePart(candidateInfo)}-${formatFileTimestamp(new Date())}.png`;
  const absPath = join(RESUME_SCREENSHOTS_DIR, fileName);

  const ok = await captureCResumeIframeToFile(page, savedViewport, absPath);
  if (!ok) {
    await closeCResumePanel(page);
    return null;
  }
  return absPath;
}

/**
 * 下载聊天中对方已发送且我方已同意的「附件简历」。
 *
 * 流程：在消息列表找到附件简历卡片 → 点击「点击预览附件简历」→ 等待
 * `.attachment-iframe`（pdf-viewer-b）出现 → 从 iframe `src` 的 `url=` 参数解出
 * 真实文件地址（`/wflow/zpgeek/download/preview4boss/...`）→ 页面内
 * `fetch(url, { credentials: 'include' })` 取回二进制 → 写盘。
 *
 * @param outDir 保存目录；未提供时默认 `RESUME_ATTACHMENTS_DIR`（`resumes/<日期>/attachments/`）。
 */
export async function runDownloadAttachmentResume(page: Page, outDir?: string): Promise<string> {
  await ensureInCandidateChat(page, '下载附件简历');
  await sleepRandom(200, 550);

  // 1) 找到附件简历卡片并点击「点击预览附件简历」
  const clicked = (await page.evaluate(`(() => {
    function norm(v) { return (v ?? "").replace(/\\s+/g, " ").trim(); }
    function isVisible(el) {
      if (!(el instanceof HTMLElement)) return false;
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    const items = Array.from(document.querySelectorAll(".chat-message-list .message-item"));
    for (let i = items.length - 1; i >= 0; i--) {
      const friend = items[i].querySelector(".item-friend");
      if (!friend) continue;
      if (!friend.querySelector(".resume-icon")) continue;
      const btn = friend.querySelector(".message-card-buttons .card-btn");
      if (!(btn instanceof HTMLElement)) continue;
      const label = norm(btn.textContent);
      if (!label.includes("预览附件简历")) continue;
      if (!isVisible(btn)) continue;
      btn.scrollIntoView({ block: "center", inline: "nearest" });
      btn.click();
      return true;
    }
    return false;
  })()`)) as boolean;

  if (!clicked) {
    throw new Error(
      '未找到可预览的附件简历卡片。请确认对方已发送附件简历，且我方已点击「同意」接收。',
    );
  }

  // 2) 等待附件预览 iframe 出现（取最后一个：历史弹层可能未关闭而残留多个）
  const iframeSel = 'iframe.attachment-iframe';
  await page.waitForSelector(iframeSel, { timeout: 15_000 }).catch(() => null);
  const src = (await page.evaluate((sel: string) => {
    const list = Array.from(document.querySelectorAll(sel)) as HTMLIFrameElement[];
    if (list.length === 0) return '';
    const el = list[list.length - 1];
    return el?.src ?? '';
  }, iframeSel)) as string;

  if (!src) {
    throw new Error('已点击「点击预览附件简历」，但附件预览弹层未出现。');
  }

  await sleepRandom(400, 900);

  // 3) 从 iframe src 解析真实文件 URL
  const urlMatch = src.match(/[?&]url=([^&]+)/);
  if (!urlMatch) {
    throw new Error(`附件预览 iframe 缺少 url 参数，无法解析真实文件地址。src=${src}`);
  }
  const decoded = decodeURIComponent(urlMatch[1]);
  const fullUrl = decoded.startsWith('http') ? decoded : `https://www.zhipin.com${decoded}`;

  // 4) 页面内带 cookie fetch，拿回 base64
  const result = (await page.evaluate(async (u: string) => {
    const resp = await fetch(u, { credentials: 'include' });
    if (!resp.ok) {
      return { ok: false as const, status: resp.status, statusText: resp.statusText };
    }
    const blob = await resp.blob();
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(
        null,
        Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[],
      );
    }
    return {
      ok: true as const,
      contentType: blob.type || 'application/octet-stream',
      size: bytes.length,
      base64: btoa(binary),
    };
  }, fullUrl)) as
    | { ok: false; status: number; statusText: string }
    | { ok: true; contentType: string; size: number; base64: string };

  if (!result.ok) {
    throw new Error(`附件下载失败：HTTP ${result.status} ${result.statusText}`);
  }

  // 5) 关闭附件预览弹层，避免遮挡后续操作（关闭按钮 class 为 .close-btn）
  await page.evaluate(`(() => {
    const wraps = Array.from(document.querySelectorAll(".boss-popup__wrapper[class*=resume]"));
    for (const w of wraps) {
      const btn = w.querySelector(".close-btn");
      if (btn instanceof HTMLElement) btn.click();
    }
  })()`).catch(() => undefined);

  // 6) 写盘
  const candidateInfo = await getCandidateInfoForResumeShot(page);
  const ext = result.contentType.includes('pdf')
    ? '.pdf'
    : result.contentType.includes('word') || result.contentType.includes('officedocument')
      ? '.docx'
      : '.bin';
  // 文件名统一为：BOSS-附件简历-岗位-姓名-时间.ext（与在线简历截图命名规则对齐）
  const fileName = `BOSS-附件简历-${buildResumeNamePart(candidateInfo)}-${formatFileTimestamp(new Date())}${ext}`;
  const dir = outDir?.trim() || RESUME_ATTACHMENTS_DIR;
  const absPath = join(dir, fileName);
  await writeFile(absPath, Buffer.from(result.base64, 'base64'));

  return `附件简历下载成功：${absPath}（${result.size} bytes, ${result.contentType}）`;
}

export type ChatPageAction =
  | 'resume'
  | 'not-fit'
  | 'remark'
  | 'agree-resume'
  | 'request-attachment-resume'
  | 'download-resume'
  | 'history'
  | 'exchange-wechat';

export async function runChatActionOnCurrentConversation(
  page: Page,
  options: { action: ChatPageAction; remark?: string; outDir?: string },
): Promise<string> {
  const action = options.action;
  switch (action) {
    case 'not-fit':
      return markCandidateNotFitWithoutReason(page);
    case 'remark':
      return updateCandidateRemark(page, options.remark ?? '');
    case 'resume': {
      await ensureInCandidateChat(page, '在线简历');
      const candidateInfo = await getCandidateInfoForResumeShot(page);
      const resumeShotPath = await captureOnlineResumeScreenshot(page, candidateInfo);
      if (resumeShotPath === null) {
        throw new Error('未找到在线简历入口，或在线简历弹层未正常出现。');
      }
      if (!isResumeOcrEnabled()) {
        return `在线简历操作成功，截图文件：${resumeShotPath}`;
      }
      try {
        const ocr = await ocrResumePngToTextFile(resumeShotPath);
        return `在线简历操作成功，\n在线简历 OCR 正文：\n\n${ocr.text}`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`在线简历截图成功，但 OCR 失败：${msg}`);
      }
    }
    case 'agree-resume':
      return runIncomingResumeCardAction(page, 'agree');
    case 'request-attachment-resume':
      return runRequestAttachmentResume(page);
    case 'download-resume':
      return runDownloadAttachmentResume(page, options.outDir);
    case 'exchange-wechat':
      return runExchangeWechat(page);
    case 'history':
      return runGetCommunicationHistory(page);
    default: {
      const _x: never = action;
      throw new Error(`未知的 chat action: ${String(_x)}`);
    }
  }
}
