// 只读探针：验证 getBossFriendListV2 返回行的完整字段（是否含 geekId/encryptGeekId）
// 用法：node scripts/probe-friend-api.mjs [friendId]
import { withBossSessionPage } from '../dist/common/boss_session_page.js';

const friendId = (process.argv[2] || '597662335').trim();

await withBossSessionPage(async (page) => {
  const result = await page.evaluate(`(async () => {
    const params = new URLSearchParams();
    params.set("friendIds", ${JSON.stringify(friendId)});
    params.set("dzFriendIds", "");
    const response = await fetch("/wapi/zprelation/friend/getBossFriendListV2.json?" + params.toString(), {
      method: "GET",
      credentials: "include",
      headers: { "Accept": "application/json, text/plain, */*" }
    });
    return { status: response.status, text: await response.text() };
  })()`);
  console.log('HTTP', result.status);
  try {
    const data = JSON.parse(result.text);
    const row = data?.zpData?.friendList?.[0];
    console.log('friendList 行字段名：', row ? Object.keys(row).join(', ') : '(空)');
    console.log('完整行：', JSON.stringify(row, null, 2));
  } catch {
    console.log('非 JSON 响应：', result.text.slice(0, 300));
  }
});
