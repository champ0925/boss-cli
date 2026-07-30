/**
 * 主动检查 BOSS 登录态，输出结构化结果（供 Worker 健康检查 / login_check 动作）。
 * 与其它命令不同：登录失效时不抛错，而是返回 { ok:false, needLogin:true }。
 */
import { existsSync, statSync } from 'node:fs';
import { BROWSER_USER_DATA_DIR } from '../config.js';
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
  };

  try {
    return await withBossSessionPage(
      async (page) => {
        const url = page.url();
        const { loggedIn } = await probeLoggedInFromPage(page);
        const account = loggedIn
          ? ((await page.evaluate(`(() => {
              const sels = [".user-name", "span.user-name", "[class*='user-name']", ".label-name", ".nav-user .name"];
              for (const s of sels) {
                const el = document.querySelector(s);
                const t = (el?.textContent || "").trim();
                if (t && t.length >= 2 && t.length <= 64 && !/登录|注册/.test(t)) return t;
              }
              return "";
            })()`)) as string)
          : '';
        return {
          ...base,
          loggedIn,
          needLogin: !loggedIn,
          account,
          currentUrl: url,
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
