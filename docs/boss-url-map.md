# Boss URL 与功能对照

本文件记录 boss-cli 已知页面 URL、对应命令和当前位置要求。修改页面导航、命令入口或报错文案前，先对照这里，避免把某个命令改成隐式跳转或多路径兜底。

## 页面 URL

| URL / Path | 页面功能 | 相关命令 | 当前行为 |
| --- | --- | --- | --- |
| `https://www.zhipin.com/web/user/?ka=header-login` | 登录入口 | `boss login` | 直接打开登录页，交还给人工扫码/验证。 |
| `/wapi/zpuser/wap/getUserInfo.json` | 当前招聘账号身份 | `boss status` | 登录态有效时读取 `userId`、`encryptUserId`、企业 ID、昵称和企业名；不输出令牌、邮箱、IP 等敏感字段。 |
| `/web/chat/index` | 沟通列表、候选人会话页 | `boss list`、`boss list --json`、`boss friends --json`、`boss chat <姓名>`、`boss chat --uid <encryptUid\|uniqueId\|friendId>`、`boss send --uid <encryptUid>`、`boss action ... --uid <encryptUid>` | `--uid` 支持三种格式：`encryptUid` 通过沟通列表接口解析后定位；`uniqueId`（friendId-source）与裸 `friendId` 直接按行 `data-id`（前缀）匹配。`chat --json` 输出真实沟通身份（friendId/uniqueId/encryptUid/securityId），friendId 为稳定认人键。`friends --json` 输出全量好友身份（filterByLabel 全部分类 + 详情富化，含岗位），供离线回填与诊断。姓名、序号入口继续保留。 |
| `/web/chat/recommend` | 推荐候选人列表 | `boss recommend`、`boss preview <姓名>`、`boss preview --geek-id <ID> --name <姓名> [--job <岗位>]`、`boss greet <geekId> [--json]` | 普通 `preview` 要求当前列表已加载；`--geek-id` 模式会进入推荐页、选择岗位并按候选人 ID 精确打开，供自动收取在线简历使用。`greet` 执行前后会对 `/wapi/zprelation/friend/filterByLabel` 全量好友做差集，唯一新增好友即被打招呼者，`--json` 输出 `newFriend`（friendId/uniqueId）供 Worker 建立 geekId→friendId 映射；基线拉取失败则不执行打招呼。 |
| `/web/chat/aiform` | 深度搜索 / Agent 搜索 | `boss deep-search [--core <要求>] [--bonus <加分项>] [--clear-core] [--clear-bonus] [--match]`、`boss preview <姓名>` | `deep-search` 会先检查当前位置，不在该页时直接进入；默认只输出招聘要求表单、核心要求、加分项、今日剩余匹配次数和按钮状态，不输出候选列表；`--core` / `--bonus` 可重复，并按传入列表同步对应分组（多余行会删除，不足会新增），`--clear-core` / `--clear-bonus` 清空对应分组；只有 `--match` 会消耗今日匹配次数并输出列表顶部最新 20 条；`preview` 要求当前已在该页且列表已加载。深度搜索打招呼需先保存完整 chatContext，再走 `greet <geekId>` 直接接口。 |
| `/web/chat/search` | 常规搜索 | `boss search [关键词]`、`boss preview <姓名>` | `search` 会先检查当前位置，不在该页时直接进入；带关键词时填入搜索框并回车搜索；`preview` 要求当前已在该页且列表已加载，不支持 `--job`。 |
| `/web/chat/job/list` | 职位管理列表 | `boss positions`、`boss jd <name>` | 可通过侧栏进入职位管理页后读取。 |

## 约定

- 沟通列表按 ID 查找时，滚轮定位 `.user-list` 的可见中心。BOSS 使用 `overflow:hidden` 的自定义位移滚动，以内容相对容器的实际坐标、内容高度和行 ID 判断进展，不依赖 `scrollTop`。到底后最多等待 5 秒加载；未到底却滚不动时明确报错，不将其误报为候选人不存在。查找仍最多 40 轮，失败信息包含分类和已检查记录数。设置 `BOSS_CHAT_SCROLL_DEBUG=1` 可输出容器位置和行数诊断。

- 当前 URL 校验优先于 DOM 猜测。命令依赖特定页面时，先检查 path，再执行页面读取或点击。
- 不为高风险操作添加隐式兜底跳转。需要用户处于特定页面的命令，应直接报出当前 URL 与目标 URL。
- 页面入口发生变化时，同步更新本文件和相关命令 help 文案。
