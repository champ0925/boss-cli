import { open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { sleepRandom } from '../browser/timing.js';
import { CACHE_DIR, ensureAppDataLayout } from '../config.js';

const SESSION_LOCK_FILE = join(CACHE_DIR, 'session.lock');
const SESSION_LOCK_WAIT_MAX_MS = 30_000;
const SESSION_LOCK_POLL_MS = 250;
/** 锁持有超过该时长视为"持有者卡死"，强制接管（防僵尸锁死锁整条批量链路） */
const SESSION_LOCK_STALE_MAX_MS = 5 * 60 * 1000;

type SessionLockMeta = {
  pid: number;
  createdAt: number;
  hostname: string;
  cwd: string;
  command: string;
};

function buildSessionLockMeta(): SessionLockMeta {
  return {
    pid: process.pid,
    createdAt: Date.now(),
    hostname: hostname(),
    cwd: process.cwd(),
    command: process.argv.join(' ').trim(),
  };
}

async function readSessionLockMeta(): Promise<SessionLockMeta | null> {
  try {
    const raw = await readFile(SESSION_LOCK_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionLockMeta>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.hostname !== 'string' ||
      typeof parsed.cwd !== 'string' ||
      typeof parsed.command !== 'string'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      hostname: parsed.hostname,
      cwd: parsed.cwd,
      command: parsed.command,
    };
  } catch {
    return null;
  }
}

async function processExists(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    return code === 'EPERM';
  }
}

async function clearStaleSessionLockIfNeeded(): Promise<void> {
  const meta = await readSessionLockMeta();
  if (!meta) {
    await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
    return;
  }
  // 锁持有超过阈值：无论进程是否存活，一律视为卡死，强制接管
  const ageMs = Date.now() - meta.createdAt;
  if (ageMs > SESSION_LOCK_STALE_MAX_MS) {
    await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
    return;
  }
  if (meta.hostname !== hostname()) {
    if (!(await processExists(meta.pid))) {
      await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
    }
    return;
  }
  if (await processExists(meta.pid)) {
    return;
  }
  await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
}

function formatSessionLockOwner(meta: SessionLockMeta | null): string {
  if (!meta) {
    return 'unknown';
  }
  const ageSeconds = Math.max(0, Math.floor((Date.now() - meta.createdAt) / 1000));
  return [
    'pid=' + meta.pid,
    'host=' + meta.hostname,
    'age=' + ageSeconds + 's',
    meta.command ? 'cmd=' + meta.command : '',
  ]
    .filter(Boolean)
    .join(', ');
}

export async function withBossSessionLock<T>(callback: () => Promise<T>): Promise<T> {
  ensureAppDataLayout();
  const deadline = Date.now() + SESSION_LOCK_WAIT_MAX_MS;

  while (true) {
    try {
      const handle = await open(SESSION_LOCK_FILE, 'wx');
      const ownMeta = buildSessionLockMeta();
      let lockCreated = false;
      try {
        await handle.writeFile(JSON.stringify(ownMeta), 'utf8');
        lockCreated = true;
      } finally {
        await handle.close().catch(() => {});
      }

      if (!lockCreated) {
        await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
        throw new Error('Boss session lock creation failed.');
      }

      try {
        return await callback();
      } finally {
        // 只删除自己创建的锁：stale 接管或外部清理后，锁文件可能已属于新持有者
        const cur = await readSessionLockMeta();
        if (cur && cur.pid === ownMeta.pid && cur.createdAt === ownMeta.createdAt) {
          await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
        }
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
      if (code !== 'EEXIST') {
        throw error;
      }

      await clearStaleSessionLockIfNeeded();
      if (Date.now() >= deadline) {
        const meta = await readSessionLockMeta();
        throw new Error(
          'Boss session is busy for more than 30s. Lock owner: ' +
            formatSessionLockOwner(meta) +
            '. If stale, delete ' +
            SESSION_LOCK_FILE,
        );
      }
      await sleepRandom(SESSION_LOCK_POLL_MS, SESSION_LOCK_POLL_MS);
    }
  }
}
