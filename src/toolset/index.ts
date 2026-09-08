/** 业务实现聚合出口：impl* 供 CLI 与其它模块调用 */
import { runLogin } from './login.js';
import { runGetCandidateList, runGetCandidateListJson } from './list.js';
import { runListOpenPositions } from './jd.js';
import { runOpenCandidateChat, runOpenCandidateChatByIndex, runOpenCandidateChatByUid, runGetCurrentChatJson, type BossChatDetail } from './chat.js';
import {
  runChatActionOnCurrentConversation,
  type ChatPageAction,
} from './action.js';
import { runSendChatMessage } from './send.js';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { runBossSearch, runBossSearchSet } from './deep-search.js';
import { runNormalSearch } from './normal-search.js';
import { runRecommend, runRecommendJson, type RecommendFilterOptions } from './recommend.js';
import { runPreview } from './preview.js';
import { runRecommendGreet } from './greet.js';
import { runCheckLoginStatus, type BossLoginStatus } from './status.js';
export type { ChatPageAction };
export type { BossChatDetail } from './chat.js';
export type { DeepSearchGeekItem } from './deep-search.js';
export type { BossLoginStatus };

export async function implLogin(): Promise<string> {
  return runLogin();
}

export async function implCheckLoginStatus(): Promise<BossLoginStatus> {
  return runCheckLoginStatus();
}

export async function implListCandidates(): Promise<string> {
  return runGetCandidateList();
}

export async function implListUnreadCandidates(): Promise<string> {
  return runGetCandidateList({ unreadOnly: true });
}

export async function implListResumeCandidates(): Promise<string> {
  return runGetCandidateList({ resumeOnly: true });
}

export async function implListCandidatesByCategory(category: string): Promise<string> {
  return runGetCandidateList({ category });
}

export async function implListCandidatesJson(opts: {
  unreadOnly?: boolean;
  resumeOnly?: boolean;
  category?: string;
} = {}): Promise<string> {
  return JSON.stringify(await runGetCandidateListJson(opts), null, 2);
}

export async function implOpenChat(
  candidateName: string,
  exact: boolean,
): Promise<string> {
  return withBossSessionPage(async (page) => {
    const { text } = await runOpenCandidateChat(page, candidateName, exact);
    return text;
  });
}

/** 打开候选人聊天并返回结构化聊天详情（供 --json / messages 表写入）。 */
export async function implOpenChatJson(
  candidateName: string,
  exact: boolean,
): Promise<BossChatDetail> {
  return withBossSessionPage(async (page) => {
    // 复用现有打开逻辑；抓取阶段使用打开时实际命中的姓名（模糊匹配下与入参不同）
    const { foundName } = await runOpenCandidateChat(page, candidateName, exact);
    return runGetCurrentChatJson(page, foundName);
  });
}

export async function implOpenChatByIndex(params: {
  index: number;
  unreadOnly?: boolean;
  expectedName?: string;
  exact?: boolean;
}): Promise<string> {
  return withBossSessionPage(async (page) =>
    runOpenCandidateChatByIndex(page, {
      index: params.index,
      filter: params.unreadOnly ? 'unread' : 'all',
      expectedName: params.expectedName,
      exact: params.exact,
    }),
  );
}

export function implOpenChatByUid(encryptUid: string, json: true, filter?: string): Promise<BossChatDetail>;
export function implOpenChatByUid(encryptUid: string, json?: false, filter?: string): Promise<string>;
export async function implOpenChatByUid(
  encryptUid: string,
  json = false,
  filter?: string,
): Promise<string | BossChatDetail> {
  return withBossSessionPage(async (page) => {
    const opened = await runOpenCandidateChatByUid(page, encryptUid, filter);
    if (!json) return opened.text;
    return runGetCurrentChatJson(page, opened.foundName, { uniqueId: opened.uniqueId });
  });
}

export async function implChatAction(params: {
  action: ChatPageAction;
  remark?: string;
  outDir?: string;
  encryptUid?: string;
}): Promise<string> {
  return withBossSessionPage(async (page) => {
    if (params.encryptUid) {
      await runOpenCandidateChatByUid(page, params.encryptUid);
    }
    return runChatActionOnCurrentConversation(page, params);
  });
}

export async function implSendMessage(params: {
  text: string;
  requestResume?: boolean;
  encryptUid?: string;
}): Promise<string> {
  return runSendChatMessage({
    text: params.text || undefined,
    requestResume: params.requestResume,
    encryptUid: params.encryptUid,
  });
}

export async function implListPositions(): Promise<string> {
  return runListOpenPositions();
}

export async function implListPositionsWithOptions(opts: {
  detail?: boolean;
  name?: string;
}): Promise<string> {
  return runListOpenPositions({
    detail: opts.detail,
    detailName: opts.name,
  });
}

export async function implBossSearch(
  opts: {
    jobKeyword?: string;
    coreRequirements?: string[];
    bonusRequirements?: string[];
    match?: boolean;
  } = {},
): Promise<string> {
  return runBossSearch(opts);
}

export async function implNormalSearch(keyword?: string): Promise<string> {
  return runNormalSearch(keyword);
}

export async function implBossSearchSet(opts: {
  jobKeyword?: string;
  coreRequirements?: string[];
  bonusRequirements?: string[];
}): Promise<string> {
  return runBossSearchSet(opts);
}

export async function implRecommend(jobKeyword?: string, filters?: RecommendFilterOptions): Promise<string> {
  return runRecommend(jobKeyword, filters);
}

export async function implRecommendJson(jobKeyword?: string, filters?: RecommendFilterOptions): Promise<string> {
  const data = await runRecommendJson(jobKeyword, filters);
  return JSON.stringify(data, null, 2);
}

export async function implPreview(opts: {
  candidateTarget: string;
  candidateGeekId?: string;
  jobKeyword?: string;
}): Promise<string> {
  return runPreview(opts);
}

export async function implRecommendGreet(opts: {
  candidateGeekId: string;
  jobKeyword?: string;
  chatContext?: {
    encryptJobId: string;
    expectId: string;
    lid: string;
    securityId: string;
  };
}): Promise<string> {
  return runRecommendGreet(opts);
}

export { implSetBaiduCredentials } from './baidu_credentials.js';
