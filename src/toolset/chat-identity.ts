import type { Page } from 'puppeteer-core';

export type BossChatIdentity = {
  uniqueId: string;
  friendId: number;
  friendSource: number;
  encryptUid: string;
  encryptJobId: string;
  expectId?: string;
  securityId: string;
  name: string;
  jobName: string;
};

export function parseBossChatUniqueId(uniqueId: string): {
  friendId: number;
  friendSource: number;
} | null {
  const matched = /^(\d+)-(\d+)$/.exec(uniqueId.trim());
  if (!matched) return null;
  return {
    friendId: Number(matched[1]),
    friendSource: Number(matched[2]),
  };
}

export type BossFriendRow = {
  friendId: number;
  friendSource: number;
  name: string;
  updateTime: number;
};

/**
 * 全量好友列表（filterByLabel labelId=0，即沟通列表全部分类的好友）。
 * 与页面列表请求保持一致：表单编码 POST，labelId=0&encJobId=&sort=&scene=0。
 */
export async function fetchBossAllFriends(page: Page): Promise<BossFriendRow[]> {
  const result = (await page.evaluate(`(async () => {
    const response = await fetch("/wapi/zprelation/friend/filterByLabel", {
      method: "POST",
      credentials: "include",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "labelId=0&encJobId=&sort=&scene=0"
    });
    return { status: response.status, text: await response.text() };
  })()`)) as { status: number; text: string };

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`BOSS 好友列表接口返回 HTTP ${result.status}`);
  }
  let data: any;
  try {
    data = JSON.parse(result.text);
  } catch {
    throw new Error(`BOSS 好友列表接口返回非 JSON：${result.text.slice(0, 120)}`);
  }
  if (typeof data?.code === 'number' && data.code !== 0) {
    throw new Error(data.message || data.msg || `BOSS 好友列表接口失败（code=${data.code}）`);
  }
  const rows = Array.isArray(data?.zpData?.result) ? data.zpData.result : [];
  return rows
    .map((row: any): BossFriendRow | null => {
      const friendId = Number(row?.friendId ?? 0);
      if (!friendId) return null;
      return {
        friendId,
        friendSource: Number(row?.friendSource ?? 0),
        name: String(row?.name ?? '').trim(),
        updateTime: Number(row?.updateTime ?? 0),
      };
    })
    .filter((row: BossFriendRow | null): row is BossFriendRow => row !== null);
}

/**
 * 全量好友 uniqueId 集合。
 * 用途：打招呼前后各取一次做差集，唯一新增项就是刚建立沟通的人（geekId → friendId 映射）。
 */
export async function fetchBossAllFriendUniqueIds(page: Page): Promise<Set<string>> {
  const rows = await fetchBossAllFriends(page);
  return new Set(rows.map((row) => `${row.friendId}-${row.friendSource}`));
}

/** 全量好友 + 身份富化（岗位/encryptUid/securityId），供离线回填与诊断（分批 100 调用详情接口）。 */
export async function fetchBossAllFriendsEnriched(page: Page): Promise<BossChatIdentity[]> {
  const rows = await fetchBossAllFriends(page);
  const uniqueIds = rows.map((row) => `${row.friendId}-${row.friendSource}`);
  const result: BossChatIdentity[] = [];
  for (let start = 0; start < uniqueIds.length; start += 100) {
    const identities = await fetchBossChatIdentities(page, uniqueIds.slice(start, start + 100));
    result.push(...identities);
  }
  return result;
}

/**
 * 沟通列表 DOM 只暴露 friendId-source；通过 BOSS 列表详情接口换取 encryptUid。
 * 调用方必须使用返回的 encryptUid 精确匹配，不允许按姓名代替。
 */
export async function fetchBossChatIdentities(
  page: Page,
  uniqueIds: string[],
): Promise<BossChatIdentity[]> {
  const parsed = uniqueIds
    .map((uniqueId) => ({ uniqueId, parsed: parseBossChatUniqueId(uniqueId) }))
    .filter((item): item is { uniqueId: string; parsed: { friendId: number; friendSource: number } } =>
      item.parsed !== null && item.parsed.friendId > 0,
    );
  if (parsed.length === 0) return [];

  const friendIds = parsed
    .filter((item) => item.parsed.friendSource !== 1)
    .map((item) => item.parsed.friendId);
  const dzFriendIds = parsed
    .filter((item) => item.parsed.friendSource === 1)
    .map((item) => item.parsed.friendId);

  const result = (await page.evaluate(`(async () => {
    const params = new URLSearchParams();
    params.set("friendIds", ${JSON.stringify(friendIds.join(','))});
    params.set("dzFriendIds", ${JSON.stringify(dzFriendIds.join(','))});
    const response = await fetch("/wapi/zprelation/friend/getBossFriendListV2.json?" + params.toString(), {
      method: "GET",
      credentials: "include",
      headers: { "Accept": "application/json, text/plain, */*" }
    });
    return { status: response.status, text: await response.text() };
  })()`)) as { status: number; text: string };

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`BOSS 沟通身份接口返回 HTTP ${result.status}`);
  }

  let data: any;
  try {
    data = JSON.parse(result.text);
  } catch {
    throw new Error(`BOSS 沟通身份接口返回非 JSON：${result.text.slice(0, 120)}`);
  }
  if (typeof data?.code === 'number' && data.code !== 0) {
    throw new Error(data.message || data.msg || `BOSS 沟通身份接口失败（code=${data.code}）`);
  }

  const rows = Array.isArray(data?.zpData?.friendList) ? data.zpData.friendList : [];
  return rows
    .map((row: any): BossChatIdentity | null => {
      const friendId = Number(row.friendId ?? row.uid ?? 0);
      const friendSource = Number(row.friendSource ?? 0);
      const encryptUid = String(row.encryptUid ?? '').trim();
      if (!friendId || !encryptUid) return null;
      return {
        uniqueId: `${friendId}-${friendSource}`,
        friendId,
        friendSource,
        encryptUid,
        encryptJobId: String(row.encryptJobId ?? '').trim(),
        expectId: String(row.expectId ?? '').trim(),
        securityId: String(row.securityId ?? '').trim(),
        name: String(row.name ?? '').trim(),
        jobName: String(row.jobName ?? row.job?.jobName ?? '').trim(),
      };
    })
    .filter((item: BossChatIdentity | null): item is BossChatIdentity => item !== null);
}
