# boss-cli 项目分析与扩展点指南

> 本文件基于 `joohw/boss-cli` 的完整源码阅读整理，用于指导后续新增 CLI 功能。

---

## 1. 项目定位与技术栈

**`boss-cli`** 是一个基于 Node.js + TypeScript 的命令行工具，通过 Chrome DevTools Protocol（CDP）连接/控制本机 Chrome 浏览器，实现对 BOSS 直聘 Web 端招聘流程的自动化操作。

- **运行环境**：Node.js（`>= 22` 推荐）、本机已安装 Chrome/Edge
- **核心依赖**：`puppeteer-core`（不自带 Chromium）、`ssh2`、`commander`（未显式引入，路由为手写解析）
- **构建方式**：`tsc` 编译 `src/` → `dist/`，入口 `dist/cli/index.js`
- **全局命令**：`npm run build` 后 `npm link`，即可在任意目录执行 `boss ...`

---

## 2. 目录结构总览

```
boss-cli/
├── src/
│   ├── cli/
│   │   ├── index.ts          # CLI 入口，解析 argv、调用 cliRouter
│   │   ├── cliRouter.ts      # 命令路由与分发中心
│   │   ├── banner.ts         # 启动横幅
│   │   └── version.ts        # 版本与更新检查
│   ├── browser/
│   │   ├── cdp_browser.ts    # 探测/启动 Chrome，固定端口 53470 复用
│   │   ├── browser_session.ts # Browser/Page 单例与会话管理
│   │   ├── human_delay.ts    # 操作延迟常量与人工输入模拟
│   │   ├── timing.ts         # sleep / sleepRandom 工具
│   │   └── viewport_temp.ts  # 临时拉高视口以截图更多内容
│   ├── common/
│   │   ├── auth.ts           # BOSS URL 判断与登录态探测
│   │   ├── boss_session_page.ts   # 会话页封装（withBossSessionPage）
│   │   ├── boss_page_guards.ts    # 反风控、请求拦截、自动化特征隐藏
│   │   ├── boss_session_lock.ts   # 文件锁，防止并发操作
│   │   ├── boss_sidebar_nav.ts    # 左侧菜单导航
│   │   ├── boss_modal.ts          # 通用弹层关闭
│   │   ├── boss_paywall_popup.ts  # VIP/付费弹层检测
│   │   ├── boss_availability.ts   # 线上 JS 版本基线校验
│   │   ├── c_resume_capture.ts    # 在线简历 iframe 检测与截图
│   │   ├── ensure_page.ts         # 页面导航辅助
│   │   └── baidu_user_env.ts      # 百度 OCR 密钥写入环境
│   ├── toolset/
│   │   ├── index.ts          # 业务聚合出口，导出 impl* 函数
│   │   ├── login.ts          # boss login
│   │   ├── list.ts           # boss list / --unread
│   │   ├── chat.ts           # boss chat <姓名>
│   │   ├── send.ts           # boss send --text "..."
│   │   ├── action.ts         # boss action <操作>
│   │   ├── recommend.ts      # boss recommend [岗位]
│   │   ├── deep-search.ts    # boss deep-search
│   │   ├── normal-search.ts  # boss search [关键词]
│   │   ├── greet.ts          # boss greet <姓名>
│   │   ├── preview.ts        # boss preview <姓名>
│   │   └── jd.ts             # boss positions / boss jd <name>
│   ├── ocr/
│   │   ├── baidu_ocr.ts     # 百度 OAuth + accurate_basic OCR
│   │   ├── resume_ocr.ts    # 简历截图 OCR 流程
│   │   └── index.ts         # OCR 模块出口
│   ├── config.ts            # 应用目录与缓存路径
│   └── types/
│       └── ...              # 类型定义（如有）
├── package.json
├── tsconfig.json
└── README.md
```

---

## 3. 核心运行机制

### 3.1 浏览器复用：固定端口 + 单例

- `src/browser/cdp_browser.ts` 通过 `puppeteer.connect()` 或 `puppeteer.launch()` 管理 Chrome。
- 默认调试端口 `53470`，可通过环境变量 `BOSS_BROWSER_REMOTE_DEBUGGING_PORT` 修改。
- 若端口已有 Chrome 实例，则直接连接复用；否则启动新实例。
- `src/browser/browser_session.ts` 维护单例 `Browser` 和 `Page`，支持重连、选页、断开。

### 3.2 会话页封装：确保命令执行在正确页面

- `src/common/boss_session_page.ts` 提供 `withBossSessionPage(fn, opts)`。
- 每次命令执行前会做三件事：
  1. 连接/复用 Browser 和 Page；
  2. 确保页面位于 BOSS 主壳页（`/web/chat/*`），否则跳转；
  3. 等待左侧 `.menu-list` 侧栏加载完成。
- 处理 SPA 跳转导致的 `Execution context was destroyed` 异常，支持一次重试。

### 3.3 反风控：请求拦截 + 页面脚本注入

- `src/common/boss_page_guards.ts` 在页面启用 CDP `Fetch.enable`：
  - 拦截安全风控脚本（`sec*`、`security*` 等）；
  - 拦截日志、上报、风险导航请求；
  - 注入页面脚本覆盖 `navigator.webdriver`、`window.close`、Location 导航、console 方法等自动化特征。

### 3.4 业务页都在 iframe 内

- 推荐页：`iframe[name="recommendFrame"]`（`src/toolset/recommend.ts`）
- 普通搜索页：`iframe[name="searchFrame"]`（`src/toolset/normal-search.ts`）
- 在线简历：`iframe[src*="c-resume"]`（`src/common/c_resume_capture.ts`）
- 操作逻辑：先 `page.waitForSelector(...)`，再 `frame = page.frames().find(...)`，最后对 `frame` 执行 DOM 操作或 `evaluate`。

### 3.5 字符串形式 evaluate

- `src/AGENTS.md`（如有）约束：所有 `page.evaluate` 必须写成**字符串脚本**注入。
- 原因：构建后若直接传入函数，会出现 `__name is not defined` 等运行时错误。
- 典型写法：

```ts
const html = await frame.evaluate(() => {
  // ❌ 不要直接写函数
}) as string;

const html = await frame.evaluate(`
  () => {
    return document.documentElement.outerHTML;
  }
`) as string; // ✅ 字符串形式
```

### 3.6 并发控制：会话锁

- `src/common/boss_session_lock.ts` 在 `~/.boss-cli/.cache/session.lock` 上加文件锁。
- 防止两个 `boss` 命令同时操作同一个浏览器实例。

### 3.7 可用性基线校验

- `src/common/boss_availability.ts` 校验 BOSS 线上 JS 版本与本地 SHA-256 基线。
- 若不一致，抛出 `BossAvailabilityError`，提示用户重新归档基线。

---

## 4. 命令注册与扩展流程

当前新增一个 `boss <command>` 的标准流程如下：

### 4.1 第一步：实现业务逻辑（src/toolset/xxx.ts）

新建一个业务模块，例如 `src/toolset/batch-greet.ts`：

```ts
import type { Page } from 'puppeteer-core';

export interface BatchGreetOptions {
  job?: string;
  limit?: number;
}

export async function batchGreet(page: Page, opts: BatchGreetOptions) {
  // 1. 进入推荐页或搜索页
  // 2. 获取 iframe
  // 3. 循环候选人卡片
  // 4. 对每个候选人点击「打招呼」
  // 5. 使用 human_delay.ts 中的延迟避免风控
}
```

### 4.2 第二步：在 src/toolset/index.ts 导出 impl* 包装函数

所有 CLI 命令都通过 `withBossSessionPage` 包装，确保浏览器/会话页可用。

```ts
import { batchGreet, type BatchGreetOptions } from './batch-greet';

export async function implBatchGreet(opts: BatchGreetOptions) {
  return withBossSessionPage(async (page) => {
    return batchGreet(page, opts);
  }, opts);
}
```

### 4.3 第三步：在 src/cli/cliRouter.ts 注册命令

在 `executeCommand` 函数中增加分支：

```ts
case 'batch-greet': {
  const job = opts.job as string | undefined;
  const limit = opts.limit ? Number(opts.limit) : 10;
  await implBatchGreet({ job, limit });
  break;
}
```

### 4.4 第四步：在 printHelp() 中补充帮助文本

```ts
function printHelp() {
  console.log(`
  ...
  batch-greet [options]      批量对推荐/搜索列表候选人打招呼
    --job <name>             指定岗位名称
    --limit <n>              最多打招呼人数（默认 10）
  ...
`);
}
```

### 4.5 第五步：重新构建并测试

```bash
npm run build
boss batch-greet --job "Java 工程师" --limit 5
```

---

## 5. 可复用的公共工具清单

| 工具 | 位置 | 用途 |
|------|------|------|
| `withBossSessionPage` | `src/common/boss_session_page.ts` | 每个命令必包，确保会话页可用 |
| `ensurePage` | `src/common/ensure_page.ts` | 确保页面跳转到指定 URL |
| `isBossChatShellUrl` / `isBossChatIndexUrl` | `src/common/auth.ts` | URL 判断 |
| `probeLoggedInFromPage` | `src/common/auth.ts` | 页面内探测登录态 |
| `closeModals` | `src/common/boss_modal.ts` | 关闭通用弹层 |
| `detectAndClosePaywallPopup` | `src/common/boss_paywall_popup.ts` | 检测并关闭 VIP 弹层 |
| `clickSidebarMenu` | `src/common/boss_sidebar_nav.ts` | 点击左侧菜单 |
| `acquireSessionLock` / `releaseSessionLock` | `src/common/boss_session_lock.ts` | 并发锁 |
| `typeTextWithRandomKeyDelay` | `src/browser/human_delay.ts` | 模拟人工输入 |
| `sleep` / `sleepRandom` | `src/browser/timing.ts` | 延迟等待 |
| `withTempViewport` | `src/browser/viewport_temp.ts` | 临时拉高视口截图 |
| `captureCResumeIframe` | `src/common/c_resume_capture.ts` | 在线简历截图 |
| `ocrResumeScreenshots` | `src/ocr/resume_ocr.ts` | 简历 OCR 识别 |

---

## 6. 推荐的新功能扩展方向

基于现有代码结构，以下功能可以较快实现：

### 6.1 批量打招呼（batch-greet）

- 在推荐页或搜索页循环候选人卡片，自动点击「打招呼」。
- 可复用 `greet.ts` 中的单条打招呼逻辑，加上循环与限流。

### 6.2 批量发送消息（batch-send）

- 结合 `list.ts` 获取沟通列表，对未读或指定候选人批量发送消息。
- 可复用 `send.ts` 中的输入框模拟输入逻辑。

### 6.3 自动简历筛选（auto-screen）

- 在推荐页/搜索页循环候选人，调用 `preview.ts` 截图 + OCR，根据关键词（如学历、工作年限、技能栈）自动判断是否合适。
- 可复用 `c_resume_capture.ts` 和 `resume_ocr.ts`。

### 6.4 职位发布/刷新（post-jd / refresh-jd）

- 在 `jd.ts` 基础上扩展，进入职位管理页，实现职位刷新、下架、复制发布。

### 6.5 消息自动回复（auto-reply）

- 监听 `list.ts` 的未读列表，识别候选人消息，调用 LLM 生成回复，再调用 `send.ts` 发送。

### 6.6 数据导出（export）

- 将 `list.ts`、`recommend.ts`、`deep-search.ts` 读到的候选人数据导出为 CSV/JSON/Excel。
- 可在 `src/toolset/export.ts` 中实现，复用现有列表读取函数。

---

## 7. 注意事项与约束

1. **所有 `page.evaluate` 必须写字符串脚本**，避免构建后运行时错误。
2. **BOSS 业务页大多在 iframe 内**，操作前需先定位到对应 `Frame`。
3. **操作间隔需模拟人工延迟**，使用 `human_delay.ts` 中的常量或 `sleepRandom`。
4. **VIP/付费弹层会阻断 DOM 操作**，需调用 `detectAndClosePaywallPopup` 处理。
5. **线上 JS 版本可能变更**，若出现 `BossAvailabilityError` 需要重新跑基线归档流程。
6. **新增命令后务必补充 help 文本**，否则用户看不到用法。
7. **建议每个新命令都写独立的 `src/toolset/<command>.ts`**，再在 `index.ts` 导出 `impl*` 包装函数，保持与现有代码风格一致。

---

## 8. 最小新增命令模板

```ts
// src/toolset/my-command.ts
import type { Page } from 'puppeteer-core';

export interface MyCommandOptions {
  // 命令参数
}

export async function myCommand(page: Page, opts: MyCommandOptions) {
  // 业务逻辑
}
```

```ts
// src/toolset/index.ts
import { myCommand, type MyCommandOptions } from './my-command';

export async function implMyCommand(opts: MyCommandOptions) {
  return withBossSessionPage(async (page) => {
    return myCommand(page, opts);
  }, opts);
}
```

```ts
// src/cli/cliRouter.ts
import { implMyCommand } from '../toolset';

case 'my-command': {
  await implMyCommand({ ... });
  break;
}
```

---

*文档更新时间：2026-07-21*
