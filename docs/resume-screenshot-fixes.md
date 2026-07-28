# 在线简历截图功能 — 源码修改记录与踩坑点

> 记录日期：2026-07-28
> 修改人：WorkBuddy（AI 助手）
> 目标：让 `boss preview <姓名>` 稳定、完整地截取 BOSS 直聘在线简历（c-resume iframe），供批量脚本 `scripts/boss-batch-fetch-resume.mjs` 调用。

---

## 一、修改了哪些文件

| 文件 | 修改内容 |
|---|---|
| `src/common/c_resume_capture.ts` | 重写就绪判定 + 截图流程（核心） |
| `src/toolset/preview.ts` | preview 命令的就绪等待与失败处理 |
| `src/toolset/action.ts` | 聊天页「在线简历」截图沿用同一 capture 函数（被动受益，未直接改逻辑） |
| `src/config.ts` | （此前已改）简历截图/OCR 输出目录支持按日期分目录 + 环境变量覆盖 |
| `scripts/boss-batch-fetch-resume.mjs` | （项目脚本）调用时注入 `BOSS_RESUME_OCR=0` 关闭 OCR；间隔可配置 |

---

## 二、逐个问题的根因与修复

### 问题 1：截图整页空白（未加载就截）

**现象**：批量跑时部分截图是纯白色空白页。

**根因**：原 `waitForVisibleCResumeIframeReady` 的就绪判定只看 `document.readyState` 达到 `interactive` 且 `scrollHeight > 100`。但 BOSS 简历 iframe 是异步渲染的——骨架占位时高度已超 100，正文还是空白，此时截图自然全白。

**修复**：改为**内容稳定采样**。轮询 iframe 正文的「文本长度 + 内容高度」，连续两次采样一致（且文本 > 60 字符、高度 > 300px）才算渲染完成。

**踩坑点 1**：不要用 DOM 节点数（`getElementsByTagName('*').length`）做判据。BOSS 简历正文渲染在**嵌套子 frame** 里，外层 frame 只能采到个位数节点，会把所有正常简历误判为「未加载」。

**踩坑点 2**：`body.innerText` 在跨域 iframe 中可能返回空字符串，需退到 `textContent`。

### 问题 2：修复后批量跑全失败（判定过严）

**现象**：改完后所有 preview 都报「内容未在预期时间内渲染完成」。

**根因**：第一版修复要求「文本量 AND 节点数」同时达标，节点数在嵌套 frame 结构下永远不达标（见踩坑点 1）。

**修复**：加载判定改为「文本量 > 60 AND 内容高度 > 300」。实测加载完成时 textLen≈393、height≈2476，骨架屏远低于此，区分度足够。

### 问题 3：Chrome 手动看正常，程序截图却大量空白

**现象**：人在 Chrome 里打开同一份简历完全正常，但批量脚本截出来全是空白。

**根因（最关键）**：`captureCResumeIframeToFile` 入口第一件事就调 `setTempHeight` 把视口拉高到 5000px——**视口突变触发简历 iframe 的重新布局/懒加载重置**，内容被清空重新渲染。就绪判定刚好踩在「旧内容还没清、新内容还没来」的窗口期，误判为已加载。手动浏览没有视口突变，所以一直正常。

**修复**：调整时序——
1. 先在**原始视口**下等简历内容稳定（不调视口）
2. 再调视口到目标高度
3. 调完视口后**强制再等一次内容稳定**（这次等不到就是真空白，直接放弃）
4. 最后才截图

**踩坑点 3**：任何会触发页面重排的操作（`setViewport`、`scrollIntoView`）都可能重置异步渲染的 iframe 内容。做「等加载完成」判定时，要把这些操作纳入时序考虑，而不是假设「之前等过了现在就还是好的」。

### 问题 4：长简历只截到尾部一小段

**现象**：修复空白问题后，长简历只截到底部的「牛人分析器」和页脚，顶部个人信息、工作经历全丢了。

**根因**：`iframe.screenshot` 只截 iframe **当前可视区域**；`captureBeyondViewport: true` 是页面级 API，对**跨域 iframe 内部滚动内容无效**——iframe 内部超出可视高度的部分根本没渲染进位图。

**修复**（三步）：
1. 先把 iframe 内部 `window.scrollTo(0, 0)` 回顶（它可能停在之前的滚动位置）
2. 把 iframe 元素的 `style.height` 直接撑开到内容完整高度（`scrollHeight`），让它不再需要内部滚动、全部内容进入渲染树
3. 改用**页面级** `page.screenshot` + `clip` 裁剪到 iframe 区域（页面级 `captureBeyondViewport` 才生效）

**踩坑点 4**：Puppeteer 的 `captureBeyondViewport` 只对主页面有效。对 iframe 元素截图时，它不会帮你渲染 iframe 内部滚动区外的内容。要截完整 iframe，要么撑开 iframe 元素本身，要么用 CDP 的 `Page.captureScreenshot` 配合 `clip`。

### 问题 5：批量跑时「刷新推荐列表」卡 3-5 分钟

**现象**：脚本日志卡在「本轮名单用完，刷新推荐列表...」不动。

**根因**：脚本里 `SEARCH_INTERVAL_MS` 写死 3-5 分钟（最初为防风控设计），后来去间隔时漏改了它。

**修复**：间隔改为 0；本轮 0 新增候选人时直接结束该岗位（推荐列表刷不出新人时不再空等 3 轮）。

---

## 三、兜底机制（最后一道防线）

不管加载判定是否被绕过，截图落盘后立即读文件大小校验：

- **< 40KB** → 判定为空白/不完整图，**立即删除文件**、返回失败
- 上层（preview 命令 / 批量脚本）收到失败后记 WARN 跳下一份，不污染结果目录

阈值依据：实测正常简历截图 300KB-1MB+，空白图 < 25KB，40KB 留有充足安全边际。

---

## 四、完整的截图时序（最终实现）

```
1. 点击候选人 → 等 c-resume iframe 出现（waitForCResumeIframeOrPaywall，15s）
2. 原始视口下等正文稳定（waitForVisibleCResumeIframeReady，15s）
   - 轮询 iframe 正文 textLen + contentHeight，连续两次一致才算稳定
3. iframe 内部 scrollTo(0,0) 回顶
4. 取 iframe 内容完整高度（contentFrame.scrollHeight）
5. 撑开 iframe 元素 style.height 到该高度
6. 页面视口拉到能装下撑开后的 iframe（上限 16384px）
7. 再次等正文稳定（12s）—— 视口变化会触发重排，必须重等
8. 固定缓冲 500-900ms，等图片/字体最后绘制
9. page.screenshot + clip 裁到 iframe 区域（captureBeyondViewport: true）
10. 文件大小校验：< 40KB 删除并报失败
11. 等待 3s（C_RESUME_CLOSE_AFTER_CAPTURE_DELAY_MS）后关闭弹层
12. 恢复原始视口
```

---

## 五、对上游的影响

这些修改都在 fork 仓库（`champ0925/boss-cli`）的工作区，**未提交**。如果后续要从 upstream（`joohw/boss-cli`）合并更新，需注意：

- `src/common/c_resume_capture.ts` 改动最大，合并时优先保留本地版本
- `src/toolset/preview.ts` 改动小（就绪等待 + 失败处理），冲突易解决
- 建议先把这些修改 commit 到本地分支，再拉 upstream

---

## 六、相关文件路径

- 简历截图输出：`resumes/<YYYY-MM-DD>/screenshots/`
- OCR 文本输出（已禁用）：`resumes/<YYYY-MM-DD>/ocr/`
- 批量脚本：`scripts/boss-batch-fetch-resume.mjs`
- 批量日志：`logs/boss-fetch-resume/`
- 环境变量：
  - `BOSS_RESUME_OCR=0` 关闭 OCR（批量脚本已默认注入）
  - `BOSS_RESUME_SCREENSHOTS_DIR` / `BOSS_RESUME_OCR_DIR` 覆盖输出目录（设置后不追加日期子目录）
  - `BOSS_RESUME_SCREENSHOT_VIEWPORT_HEIGHT` 覆盖临时视口高度（默认 5000，现已按内容动态调整）
