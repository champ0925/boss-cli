// 配置文件 — 应用数据位于 ~/.boss-cli/.cache/

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * 多数 Agent 客户端约定的 skills 根目录（如 `~/.agents/skills`）。
 * 可用 `BOSS_AGENT_SKILLS_DIR` 设为绝对路径以覆盖。
 */
export function getAgentSkillsDir(): string {
  const raw = process.env.BOSS_AGENT_SKILLS_DIR?.trim();
  if (raw && raw.length > 0) {
    return raw;
  }
  return join(homedir(), '.agents', 'skills');
}

/** 应用主目录（业务数据在 .cache 下） */
export const APP_HOME = join(homedir(), '.boss-cli');

/** 存放岗位 JD 的目录（每个岗位一个 .md 文件） */
export const JD_DIR = join(APP_HOME, 'jd');

/**
 * 应用缓存与生成数据根目录（浏览器配置等）
 */
export const CACHE_DIR = join(APP_HOME, '.cache');

/** Puppeteer 用户数据目录（与 CDP 启动默认目录一致） */
export const BROWSER_USER_DATA_DIR = join(CACHE_DIR, 'browser-data');

/** 当天日期目录名，如 2026-07-28；可用 BOSS_RESUME_DATE_DIR 覆盖（测试用） */
function resumeDateDir(): string {
  return (
    process.env.BOSS_RESUME_DATE_DIR?.trim() ||
    new Date().toISOString().slice(0, 10)
  );
}

/**
 * `chat`/`preview` 抓取在线简历时对 iframe 区域截图保存目录。
 * 优先使用环境变量 `BOSS_RESUME_SCREENSHOTS_DIR`（绝对路径，不再追加日期目录），
 * 未设置时默认存到当前工作目录下的 `resumes/<日期>/screenshots/`（即项目内按天分目录）。
 */
export const RESUME_SCREENSHOTS_DIR =
  process.env.BOSS_RESUME_SCREENSHOTS_DIR?.trim() ||
  join(process.cwd(), 'resumes', resumeDateDir(), 'screenshots');

/**
 * 在线简历截图经 OCR 后的纯文本保存目录（与截图同名 `.txt`）。
 * 优先使用环境变量 `BOSS_RESUME_OCR_DIR`（绝对路径，不再追加日期目录），
 * 未设置时默认存到当前工作目录下的 `resumes/<日期>/ocr/`（即项目内按天分目录）。
 */
export const RESUME_OCR_DIR =
  process.env.BOSS_RESUME_OCR_DIR?.trim() ||
  join(process.cwd(), 'resumes', resumeDateDir(), 'ocr');

/**
 * 聊天中「附件简历」下载保存目录。
 * 优先使用环境变量 `BOSS_RESUME_ATTACHMENTS_DIR`（绝对路径，不再追加日期目录），
 * 未设置时默认存到当前工作目录下的 `resumes/<日期>/attachments/`（即项目内按天分目录）。
 */
export const RESUME_ATTACHMENTS_DIR =
  process.env.BOSS_RESUME_ATTACHMENTS_DIR?.trim() ||
  join(process.cwd(), 'resumes', resumeDateDir(), 'attachments');

let appDataLayoutReady = false;

/** 确保 `~/.boss-cli/.cache` 目录存在（幂等） */
export function ensureAppDataLayout(): void {
  if (appDataLayoutReady) {
    return;
  }
  appDataLayoutReady = true;
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
  if (!existsSync(BROWSER_USER_DATA_DIR)) {
    mkdirSync(BROWSER_USER_DATA_DIR, { recursive: true });
  }
  if (!existsSync(JD_DIR)) {
    mkdirSync(JD_DIR, { recursive: true });
  }
  if (!existsSync(RESUME_SCREENSHOTS_DIR)) {
    mkdirSync(RESUME_SCREENSHOTS_DIR, { recursive: true });
  }
  if (!existsSync(RESUME_OCR_DIR)) {
    mkdirSync(RESUME_OCR_DIR, { recursive: true });
  }
  if (!existsSync(RESUME_ATTACHMENTS_DIR)) {
    mkdirSync(RESUME_ATTACHMENTS_DIR, { recursive: true });
  }
  const agentSkills = getAgentSkillsDir();
  if (!existsSync(agentSkills)) {
    mkdirSync(agentSkills, { recursive: true });
  }
}
