import {
  GREET_PAYWALL_WAIT_MAX_MS,
  resumeHeight,
  setTempHeight,
  sleepRandom,
  snapshotBossPageViewport,
} from '../browser/index.js';
import { closeBossModalIfPresent, waitAndCloseBossModalIfPresent } from '../common/boss_modal.js';
import {
  closeBossPaywallPopupIfPresent,
  describeBossPaywallPopupIfPresent,
  waitForBossPaywallPopup,
} from '../common/boss_paywall_popup.js';
import { withBossSessionPage } from '../common/boss_session_page.js';
import {
  isBossChatAiFormUrl,
} from './deep-search.js';
import {
  clickGreet,
  assertRecommendPageReady,
  markGreetProduced,
  readRecommendList,
  renderRecommendList,
  selectRecommendJob,
} from './recommend.js';
import type { Page } from 'puppeteer-core';

/** 打招呼前临时拉高父页视口，使 iframe 内更多卡片进入 DOM（与 recommend 列表读取已解耦）。 */
const RECOMMEND_GREET_EXPAND_HEIGHT_PX = 3000;
const RECOMMEND_GREET_EXPAND_SETTLE_MS = { min: 600, max: 1400 } as const;

/** 操作完成后等待并关闭延迟出现的提示弹层（如「当前职位尚未开放」）。 */
const GREET_MODAL_CLEANUP_WAIT_MAX_MS = 4000;

async function assertNoGreetPaywallPopup(page: Page): Promise<void> {
  if (await waitForBossPaywallPopup(page, GREET_PAYWALL_WAIT_MAX_MS)) {
    const paywall = await describeBossPaywallPopupIfPresent(page, 'greet');
    await closeBossPaywallPopupIfPresent(page);
    if (paywall) {
      throw new Error(paywall);
    }
    throw new Error('页面出现 VIP/付费购买弹层，打招呼可能需开通权益或充值直豆。');
  }
}

async function cleanupGreetModalIfPresent(page: Page): Promise<void> {
  await waitAndCloseBossModalIfPresent(page, GREET_MODAL_CLEANUP_WAIT_MAX_MS);
}

export type GreetOptions = {
  candidateGeekId: string;
  jobKeyword?: string;
  chatContext?: {
    encryptJobId: string;
    expectId: string;
    lid: string;
    securityId: string;
  };
};

export function buildChatStartBody(
  geekId: string,
  context: NonNullable<GreetOptions['chatContext']>,
): string {
  return new URLSearchParams({
    gid: geekId,
    suid: '',
    jid: context.encryptJobId,
    expectId: context.expectId,
    lid: context.lid,
    greet: '',
    from: '',
    securityId: context.securityId,
    customGreetingGuide: '-1',
  }).toString();
}

async function startChatByGeekId(
  page: Page,
  geekId: string,
  context: NonNullable<GreetOptions['chatContext']>,
): Promise<string> {
  const body = buildChatStartBody(geekId, context);
  const result = (await page.evaluate(`(async () => {
    const response = await fetch("/wapi/zpjob/chat/start", {
      method: "POST",
      credentials: "include",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded",
        "x-requested-with": "XMLHttpRequest"
      },
      body: ${JSON.stringify(body)}
    });
    return { status: response.status, text: await response.text() };
  })()`)) as { status: number; text: string };

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`BOSS 发起沟通接口返回 HTTP ${result.status}`);
  }
  let data: any;
  try {
    data = JSON.parse(result.text);
  } catch {
    throw new Error(`BOSS 发起沟通接口返回非 JSON：${result.text.slice(0, 120)}`);
  }
  if (typeof data?.code === 'number' && data.code !== 0) {
    throw new Error(data.message || data.msg || `BOSS 发起沟通失败（code=${data.code}）`);
  }
  return `已按 geekId=${geekId} 发起沟通。`;
}

export async function runRecommendGreet(options: GreetOptions): Promise<string> {
  const t = options.candidateGeekId.trim();
  const kw = (options.jobKeyword ?? '').trim();
  if (!t) {
    throw new Error('请提供候选人 geekId。');
  }
  try {
    return await withBossSessionPage(async (page) => {
      await closeBossModalIfPresent(page);
      if (options.chatContext) {
        const message = await startChatByGeekId(page, t, options.chatContext);
        await assertNoGreetPaywallPopup(page);
        await cleanupGreetModalIfPresent(page);
        return message;
      }
      const url = page.url();
      if (isBossChatAiFormUrl(url)) {
        throw new Error('深度搜索按 geekId 打招呼需要完整 chatContext，禁止按姓名定位。');
      }

      const frame = await assertRecommendPageReady(page, '打招呼');
      const selectedJob = await selectRecommendJob(frame, kw);
      const jobLine = selectedJob ? `当前岗位：${selectedJob}` : '当前岗位：默认';
      const savedViewport = await snapshotBossPageViewport(page);
      try {
        await setTempHeight(page, savedViewport, RECOMMEND_GREET_EXPAND_HEIGHT_PX);
        await sleepRandom(
          RECOMMEND_GREET_EXPAND_SETTLE_MS.min,
          RECOMMEND_GREET_EXPAND_SETTLE_MS.max,
        );
        const before = await readRecommendList(frame);
        const greetResult = await clickGreet(frame, t);
        await assertNoGreetPaywallPopup(page);
        await sleepRandom(380, 1000);
        const after = await readRecommendList(frame);
        markGreetProduced(before, after);
        await cleanupGreetModalIfPresent(page);
        return [jobLine, greetResult.message, '', '当前推荐列表（来源分组）：', renderRecommendList(after)].join('\n');
      } finally {
        await resumeHeight(page, savedViewport);
      }
    }, options.chatContext ? {} : { ensureChatShell: false, ensureMenuList: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`执行打招呼失败：${message}`);
  }
}
