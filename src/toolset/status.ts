/**
 * 主动检查 BOSS 登录态，输出结构化结果（供 Worker 健康检查 / login_check 动作）。
 * 与其它命令不同：登录失效时不抛错，而是返回 { ok:false, needLogin:true }。
 * 只读路径：浏览器未启动（调试端口探测不到）时直接返回，绝不拉起新的 Chrome 实例。
 */
import { existsSync, statSync } from 'node:fs';
import { BROWSER_USER_DATA_DIR } from '../config.js';
import {
  getBrowserRef,
  probeRemoteDebuggingWsEndpoint,
  REMOTE_DEBUGGING_PORT,
} from '../browser/index.js';
import { probeLoggedInFromPage } from '../common/auth.js';
import { withBossSessionPage } from '../common/boss_session_page.js';

export type BossLoginStatus = {
  ok: boolean;           // CLI 调用本身是否成功（不代表已登录）
  needLogin: boolean;    // 是否需要人工重新登录
  loggedIn: boolean;     // 当前登录态是否有效
  account: string;       // 检测到的账号昵称（未登录为空）
  userDataDir: string;   // 登录态存储目录
  userDataDirExists: boolean;
  lastLoginAt: string;   // 用户数据目录最后修改时间（近似最后登录时间）
  currentUrl: string;    // 当前页面 URL
  checkedAt: string;     // 检查时间 ISO
  platformAccountId: string;           // BOSS userId
  platformAccountIdSecondary: string;  // BOSS encryptUserId
  companyId: string;                    // BOSS encryptComId
  companyName: string;
  legalName: string;
  error?: string;        // 检查过程中的异常（如浏览器未启动）
};

export async function runCheckLoginStatus(): Promise<BossLoginStatus> {
  const checkedAt = new Date().toISOString();
  const dirExists = existsSync(BROWSER_USER_DATA_DIR);
  const lastLoginAt = dirExists ? statSync(BROWSER_USER_DATA_DIR).mtime.toISOString() : '';

  const base: BossLoginStatus = {
    ok: true,
    needLogin: false,
    loggedIn: false,
    account: '',
    userDataDir: BROWSER_USER_DATA_DIR,
    userDataDirExists: dirExists,
    lastLoginAt,
    currentUrl: '',
    checkedAt,
    platformAccountId: '',
    platformAccountIdSecondary: '',
    companyId: '',
    companyName: '',
    legalName: '',
  };

  try {
    // 只读检查：先探测调试端口，浏览器未启动时直接返回，不拉起新 Chrome（与 help 宣称的只读行为一致）。
    // getBrowserRef() 覆盖同进程内已连接会话（如交互模式 / npm run dev）。
    const wsEndpoint = await probeRemoteDebuggingWsEndpoint(REMOTE_DEBUGGING_PORT, 800);
    if (!wsEndpoint && !getBrowserRef()) {
      return {
        ...base,
        ok: false,
        needLogin: true,
        error: `浏览器未启动：未在 127.0.0.1:${REMOTE_DEBUGGING_PORT} 检测到调试端口。请先运行 boss login 启动浏览器并完成登录。`,
      };
    }
    return await withBossSessionPage(
      async (page) => {
        const url = page.url();
        const { loggedIn } = await probeLoggedInFromPage(page);
        if (!loggedIn) {
          return { ...base, loggedIn: false, needLogin: true, currentUrl: url };
        }
        const identity = (await page.evaluate(`(async () => {
          const response = await fetch("/wapi/zpuser/wap/getUserInfo.json", {
            credentials: "include"
          });
          if (!response.ok) throw new Error("BOSS 当前账号接口 HTTP " + response.status);
          const result = await response.json();
          if (result?.code !== 0 || !result?.zpData) {
            throw new Error(result?.message || "BOSS 当前账号接口返回异常");
          }
          const data = result.zpData;
          return {
            platformAccountId: String(data.userId || ""),
            platformAccountIdSecondary: String(data.encryptUserId || ""),
            account: String(data.showName || ""),
            legalName: String(data.name || ""),
            companyId: String(data.encryptComId || ""),
            companyName: String(data.brandName || "")
          };
        })()`)) as {
          platformAccountId: string;
          platformAccountIdSecondary: string;
          account: string;
          legalName: string;
          companyId: string;
          companyName: string;
        };
        if (!identity.platformAccountId || !identity.platformAccountIdSecondary) {
          throw new Error('BOSS 当前账号接口缺少 userId 或 encryptUserId');
        }
        return {
          ...base,
          loggedIn: true,
          needLogin: false,
          currentUrl: url,
          ...identity,
        };
      },
      // status 只读检查：不强制跳聊天主页、不强制校验 menu-list，避免副作用
      { ensureChatShell: false, ensureMenuList: false },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 浏览器未启动 / CDP 连不上 / 页面加载失败等，视为需要人工介入（可能需要先 boss login 启动浏览器）
    return {
      ...base,
      ok: false,
      needLogin: true,
      error: msg,
    };
  }
}
