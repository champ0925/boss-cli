import type { Page } from 'puppeteer-core';

export type BossChatIdentity = {
  uniqueId: string;
  friendId: number;
  friendSource: number;
  encryptUid: string;
  encryptJobId: string;
  securityId: string;
  name: string;
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
        securityId: String(row.securityId ?? '').trim(),
        name: String(row.name ?? '').trim(),
      };
    })
    .filter((item: BossChatIdentity | null): item is BossChatIdentity => item !== null);
}
