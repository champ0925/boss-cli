import type { ElementHandle, Frame, Page } from 'puppeteer-core';
import { stat, unlink } from 'node:fs/promises';
import { sleepRandom } from '../browser/timing.js';
import { resumeHeight, setTempHeight } from '../browser/viewport_temp.js';

/** 判定为空白截图的文件大小阈值（字节）。正常简历截图普遍 >300KB，空白图 <25KB。 */
const BLANK_SCREENSHOT_MAX_BYTES = 40 * 1024;

/** 在线简历 iframe：`src` 常为相对路径 `/web/frame/c-resume/...`，故用子串匹配 */
export const C_RESUME_IFRAME_SELECTOR =
  'iframe[src*="c-resume"], iframe[src*="frame/c-resume"]' as const;

const CLOSE_C_RESUME_PANEL_SCRIPT = `(() => {
  const sel = ${JSON.stringify(C_RESUME_IFRAME_SELECTOR)};
  function hasCResumeIframe(root) {
    return Array.from(root.querySelectorAll('iframe')).some((iframe) => {
      const src = iframe.getAttribute('src') || '';
      return src.includes('c-resume') || src.includes('frame/c-resume');
    });
  }
  const wraps = Array.from(document.querySelectorAll('.dialog-lib-resume, .boss-popup__wrapper, .boss-dialog__wrapper, .dialog-container'));
  for (var wi = 0; wi < wraps.length; wi++) {
    var w = wraps[wi];
    if (hasCResumeIframe(w)) {
      var c =
        w.querySelector('.close-btn') ||
        w.querySelector('.boss-popup__close') ||
        w.querySelector('.boss-dialog__close') ||
        w.querySelector('.drawer-close') ||
        w.querySelector('.icon-close') ||
        w.querySelector('.btn-quxiao');
      if (c) {
        c.click();
        return true;
      }
    }
  }
  var iframe = document.querySelector(sel);
  var node = iframe ? iframe.parentElement : null;
  for (var i = 0; i < 12 && node; i++) {
    var closeBtn = node.querySelector(
      '.close-btn, .boss-popup__close, .boss-dialog__close, .drawer-close, .icon-close, .btn-quxiao',
    );
    if (closeBtn) {
      closeBtn.click();
      return true;
    }
    node = node.parentElement;
  }
  return false;
})()`;

const C_RESUME_CLOSE_AFTER_CAPTURE_DELAY_MS = 3_000;

const VISIBLE_C_RESUME_IN_FRAME_SCRIPT = `(() => {
  var iframe = document.querySelector(${JSON.stringify(C_RESUME_IFRAME_SELECTOR)});
  if (!(iframe instanceof HTMLElement)) return false;
  var r = iframe.getBoundingClientRect();
  return r.width > 8 && r.height > 8;
})()`;

export async function frameHasVisibleCResumeIframe(frame: Frame): Promise<boolean> {
  try {
    return (await frame.evaluate(VISIBLE_C_RESUME_IN_FRAME_SCRIPT)) as boolean;
  } catch {
    return false;
  }
}

/** 截图文件名安全段（在线简历 / 推荐预览共用） */
export function safeResumeScreenshotFileBase(name: string): string {
  const t = name.replace(/[/\\?%*:|"<>]/g, '_').trim().slice(0, 64);
  return t.length > 0 ? t : 'candidate';
}

/** 关闭含 `c-resume` iframe 的弹层（聊天「在线简历」与推荐「预览」共用）。含 `.boss-popup__close`、`.btn-quxiao`（取消）等。会在主文档与各子 frame 中尝试。 */
export async function closeCResumePanel(page: Page): Promise<void> {
  try {
    for (let round = 0; round < 5; round++) {
      let closedAny = false;
      for (const frame of page.frames()) {
        try {
          const closed = (await frame.evaluate(CLOSE_C_RESUME_PANEL_SCRIPT)) as boolean;
          closedAny = closedAny || closed;
        } catch {
          /* detached / 无权限 */
        }
      }
      if (!closedAny) {
        break;
      }
      await sleepRandom(200, 450);
    }
  } catch {
    /* ignore */
  }
}

/**
 * 在任意 frame（含主 frame、`recommendFrame` 等）中查找已挂载且尺寸可见的 c-resume iframe。
 */
export async function findVisibleCResumeIframeHandle(page: Page): Promise<ElementHandle<Element> | null> {
  for (const frame of page.frames()) {
    try {
      if (!(await frameHasVisibleCResumeIframe(frame))) {
        continue;
      }
      const h = await frame.$(C_RESUME_IFRAME_SELECTOR);
      if (h) {
        return h;
      }
    } catch {
      /* detached */
    }
  }
  return null;
}

/**
 * 采样 iframe 内简历内容指纹（文本长度 + 内容高度）。
 * BOSS 简历 iframe 的 DOM 是异步渲染的：`readyState` 一旦到 `interactive`
 * 且骨架占位高度已 > 100，旧判定就会误报 ready，而正文可能还没填进去。
 * 因此必须等「文本量」和「内容高度」连续两次采样都稳定才视为渲染完成。
 */
async function sampleResumeContentFingerprint(
  contentFrame: Frame,
): Promise<{ textLen: number; contentHeight: number; nodeCount: number } | null> {
  try {
    return (await contentFrame.evaluate(`(() => {
      const body = document.body;
      const doc = document.documentElement;
      if (!body) return null;
      // innerText 在跨域 iframe 中可能返回空，退到 textContent
      const rawText = body.innerText || body.textContent || "";
      const text = rawText.replace(/\\s+/g, "");
      const contentHeight = Math.max(body.scrollHeight || 0, doc?.scrollHeight || 0);
      const nodeCount = body.getElementsByTagName("*").length;
      return { textLen: text.length, contentHeight, nodeCount };
    })()`)) as { textLen: number; contentHeight: number; nodeCount: number } | null;
  } catch {
    return null;
  }
}

export async function waitForVisibleCResumeIframeReady(
  page: Page,
  timeoutMs = 18_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  /** 上一次成功的采样指纹；用于判定「连续两次稳定」 */
  let lastFingerprint: { textLen: number; contentHeight: number; nodeCount: number } | null = null;
  while (Date.now() < deadline) {
    const iframe = await findVisibleCResumeIframeHandle(page);
    if (!iframe) {
      lastFingerprint = null;
      await sleepRandom(150, 250);
      continue;
    }
    try {
      const box = await iframe.boundingBox();
      const contentFrame = await iframe.contentFrame();
      if (box && box.width > 8 && box.height > 8) {
        if (!contentFrame) {
          // 跨域拿不到内容帧：保守起见多等一段固定时间再放行
          await sleepRandom(1_200, 1_800);
          return true;
        }
        const fp = await sampleResumeContentFingerprint(contentFrame);
        // 判定「已加载」：文本量 + 内容高度都要达标。
        // 注意不能用 nodeCount：BOSS 简历正文在嵌套子 frame 里，外层只能采到个位数节点。
        const loaded = !!fp && fp.textLen > 60 && fp.contentHeight > 300;
        if (loaded && fp) {
          if (
            lastFingerprint &&
            lastFingerprint.textLen === fp.textLen &&
            lastFingerprint.contentHeight === fp.contentHeight
          ) {
            // 连续两次采样一致 → 视为正文渲染稳定
            return true;
          }
          lastFingerprint = fp;
        } else {
          lastFingerprint = null;
        }
      }
    } finally {
      await iframe.dispose();
    }
    await sleepRandom(250, 400);
  }
  // 超时也视为没加载出来：返回 false，让上层跳过这份简历，不截空白图
  return false;
}

/**
 * 在已出现 `c-resume` iframe 的页面上，对 iframe 整框截图并关闭弹层。
 * `preOpenViewport` 为打开弹层前的视口快照，请用 `snapshotBossPageViewport(page)`（`page.viewport()` 常为 null 时勿直接用默认尺寸）。
 */
export async function captureCResumeIframeToFile(
  page: Page,
  preOpenViewport: Awaited<ReturnType<Page['viewport']>>,
  absPath: string,
): Promise<boolean> {
  try {
    // 注意：不要在这里先拉高视口。视口突变会触发 iframe 重排/懒加载重置，
    // 内容被清空后重新渲染，就绪判定会踩在窗口期误判 ready，截到空白。
    // 正确顺序：先在原始视口下等内容稳定 → 再调视口 → 调完再等一次稳定。

    // 第一次就绪：原始视口下等正文渲染稳定
    const ready = await waitForVisibleCResumeIframeReady(page, 15_000);
    if (!ready) {
      return false;
    }

    const iframe = await findVisibleCResumeIframeHandle(page);
    if (!iframe) {
      return false;
    }

    // 1) 把 iframe 内部滚回顶部（它可能停在之前的滚动位置）
    try {
      const contentFrame = await iframe.contentFrame();
      if (contentFrame) {
        await contentFrame.evaluate(`(() => { window.scrollTo(0, 0); })()`);
      }
    } catch { /* 跨域忽略 */ }

    // 2) 把 iframe 元素本身撑开到它的内容完整高度，让内部不再需要滚动
    //    这是关键：iframe 默认只渲染可视区，撑开后内部全部内容才会进入渲染树
    let targetHeight = 0;
    try {
      const contentFrame = await iframe.contentFrame();
      if (contentFrame) {
        targetHeight = (await contentFrame.evaluate(`(() => {
          const body = document.body;
          const doc = document.documentElement;
          return Math.max(body?.scrollHeight || 0, doc?.scrollHeight || 0);
        })()`)) as number;
      }
    } catch { /* 跨域忽略 */ }

    await iframe.evaluate(`((el, h) => {
      if (h > 0) {
        el.style.height = h + "px";
        el.style.maxHeight = "none";
      }
      el.scrollIntoView({ block: "start", inline: "nearest" });
    })`, targetHeight).catch(() => {});

    const box = await iframe.boundingBox();
    if (!box) {
      await iframe.dispose();
      return false;
    }
    await iframe.dispose();

    // 3) 把页面视口拉到能装下整个撑开后的 iframe（含顶部偏移）
    const docTop = box.y;
    const wanted = Math.ceil(docTop + Math.max(targetHeight, box.height, 1200) + 40);
    const capped = Math.min(wanted, 16_384);
    const curVp = page.viewport();
    await page.setViewport({
      width: curVp?.width ?? 1280,
      height: capped,
      deviceScaleFactor: curVp?.deviceScaleFactor ?? 1,
      isMobile: curVp?.isMobile ?? false,
      hasTouch: curVp?.hasTouch ?? false,
      isLandscape: curVp?.isLandscape ?? false,
    });

    // 视口变化触发重排/重绘，必须再等一次内容稳定（这次等不到就是真空白）
    const readyAfterResize = await waitForVisibleCResumeIframeReady(page, 12_000);
    if (!readyAfterResize) {
      return false;
    }
    // 固定缓冲，等图片/字体最后绘制
    await sleepRandom(500, 900);

    // 4) 截整个页面（captureBeyondViewport 在页面级生效），再裁到 iframe 区域
    const iframe2 = await findVisibleCResumeIframeHandle(page);
    if (!iframe2) {
      return false;
    }
    const clip = await iframe2.boundingBox();
    await iframe2.dispose();
    if (!clip) {
      return false;
    }
    await page.screenshot({
      path: absPath,
      type: 'png',
      captureBeyondViewport: true,
      clip: {
        x: Math.max(0, clip.x),
        y: Math.max(0, clip.y),
        width: Math.ceil(clip.width),
        height: Math.ceil(clip.height),
      },
    });

    // 截图后立即校验：文件过小 = 实际是空白图（加载判定被绕过/截图时内容被清空），
    // 删除并返回 false，让上层跳过这份简历，不污染结果目录
    try {
      const st = await stat(absPath);
      if (st.size < BLANK_SCREENSHOT_MAX_BYTES) {
        await unlink(absPath).catch(() => {});
        await closeCResumePanel(page);
        return false;
      }
    } catch {
      // 读不到文件也视为失败
      await closeCResumePanel(page);
      return false;
    }

    await sleepRandom(
      C_RESUME_CLOSE_AFTER_CAPTURE_DELAY_MS,
      C_RESUME_CLOSE_AFTER_CAPTURE_DELAY_MS,
    );
    await closeCResumePanel(page);
    return true;
  } finally {
    await resumeHeight(page, preOpenViewport);
  }
}
