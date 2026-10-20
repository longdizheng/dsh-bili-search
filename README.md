# dsh-bili-search

给 DeepSeek Harness 用的 B 站搜索插件：**输入关键词 → 返回相关视频的链接**。

两条入口，共用同一份实现：

| 入口 | 怎么用 | 特点 |
|---|---|---|
| 命令 `/bili` | `/bili 原神 4.0 攻略` | 秒出结果，**不进模型请求**、不花 token |
| 工具 `bilibili_search` | 「帮我找几个 B 站讲 XX 的视频」 | 模型自己判断该不该搜，可以把结果接着加工 |

每条结果：**标题 · UP 主 · 播放量 · 时长 · 链接**。

## 为什么它不需要任何配置

走的是 B 站网页端自己用的那条接口（`/x/web-interface/wbi/search/type`），只需要两样东西，而且都能匿名拿到：

1. `buvid3` 指纹 —— 从 `/x/frontend/finger/spi` 取；
2. wbi 签名（`w_rid` / `wts`）—— 密钥从 `/x/web-interface/nav` 取（该接口匿名返回 `code:-101`，但密钥照给，属于正常现象）。

**不需要登录、不需要 Cookie、不需要 API key、不需要装任何依赖。** 代价是受 B 站的匿名风控约束：短时间密集请求可能吃 `-412`，插件会自动换一次签名重试，仍然失败就如实报错。

## 用法

```
/bili                          不带参数 = 按你的观看历史 / 收藏夹推荐（要登录态）
/bili 状态                      看登录账号、档案统计、最常看的 UP 和标签
/bili 设置 30                   观看历史读最近多少条（30 / 60 / 10–120 任意值）
/bili 黑神话 悟空              综合排序，5 条；有登录态时按兴趣重排
/bili 黑神话 悟空 最新         按发布时间
/bili 黑神话 悟空 播放         按播放量
/bili 崩坏3 弹幕               按弹幕数
```

## 个性化推荐（需要登录态）

有登录态时，插件会把**观看历史**和**收藏夹**压成一个兴趣档案，用它给搜索结果重排：

抓多少：观看历史**最近 50 条**（`historyLimit`，接口一页 30，所以是 30 + 20 两条请求）、收藏夹按内容量取**前 10 个**（`maxFolders`），每个最多 20 条、**稍后再看最近 30 条**（`watchLaterLimit`，接口一页上限就是 30，0 = 不抓）。

| 信号 | 来源 | 权重 |
|---|---|---|
| UP 主 | 历史（每看一次 × 新鲜度）+ 收藏 + 稍后再看 | **历史 3.2×recency（下限 0.65）> 收藏 2 > 稍后再看 1.6** |
| 标签 / 分区 | 历史条目的 `tag_name`、稍后再看的分区、收藏夹名字 | 历史标签 2.4×recency / 历史分区 1.2×recency / 稍后再看分区 0.8 / 收藏夹名 3 |
| 关键词 | 标题切出的高频二元/三元词 | 命中 +0.3 ~ +1.5 |
| 已经看过 | 历史 bvid 集合 | **一律沉到列表末尾**（保留，不删） |
| 已在稍后再看 | 稍后再看 bvid 集合 | +1 并标注，**不沉底**（你想看但还没看） |

历史权重可以整体调（`historyWeight`，默认 3.2）：标签/分区会按比例跟着缩放；只有降到收藏以下时，新鲜度下限才自动回落到 0.35。

每条结果下面会给一行理由，例如：

```
1. 战双帕弥什 新版本前瞻
   UP主：某某 ｜ 播放：12.3万 ｜ 时长：8:21
   ↳ 命中「战双帕弥什」 · 你常看 UP「羽春雨村_」
```

不带关键词的 `/bili` 则是纯推荐：拿档案里权重最高的 3 个词去搜，合并去重、**剔除看过的**，再按兴趣分排序。

数据抓取有缓存：档案默认缓存 30 分钟（`profileCacheMinutes`），避免每次搜索都打一遍历史/收藏接口招风控。

### 登录态从哪来

两个来源，按顺序试：

1. **内置浏览器（默认优先）**：`ctx.browser.open()` 开一个标签、`flushAuth()` 取 cookie，**只在内存里存 10 分钟**，不落盘、不进对话日志。需要 `dsh-builtin-browser` 装着且能用。
2. **`cookies.json` 兜底**：路径 `<DSH_HOME>/bili-search/cookies.json`（或配置 `cookieFile`），三种格式都认：

```jsonc
{ "sessdata": "...", "bili_jct": "...", "dedeuserid": "..." }   // 对象
[ { "name": "SESSDATA", "value": "..." } ]                      // 浏览器导出的数组
"SESSDATA=...; DedeUserID=..."                                  // 原始 header
```

**SESSDATA 是活的登录凭证**：别提交、别贴进聊天、别写进公开仓库。插件只在内存里用它拼请求头，不会打印，也不会写日志。

> 为什么不去直接读 Chromium 的 Cookies 库：那个文件被浏览器独占锁定，`copyFile` 直接 `EBUSY`，`FileShare.ReadWrite` 也打不开——读不了。


命令结尾的排序词也认这些别名：`综合` / `默认` / `播放` / `播放量` / `热门` / `最新` / `最新发布` / `弹幕`。

工具参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `keyword` | string，必填 | 关键词 |
| `count` | number | 1–20，默认取配置 `count`（5） |
| `order` | `totalrank` / `click` / `pubdate` / `dm` | 默认取配置 `order`（`totalrank`） |

## 链接能不能点

- **工具 `bilibili_search`**：每条标题本身就是 Markdown 链接（`[标题](https://www.bilibili.com/video/BVxxxx)`），模型原样转述后**在聊天里可以直接点**。
- **命令 `/bili`**：点不了。它的返回在 Web UI 里走的是 `notice.text`（`InputBar` 里的纯文本节点，React 会转义），**不渲染 Markdown**——这是 UI 结构决定的，不是格式没写对。所以命令只给裸地址，能选中复制。
  - 想要能点的，得把 `tool` 打开（见「配置」），然后用自然语言问一句「帮我找几个 B 站讲 XX 的视频」。

## 配置

在 profile 的 `cordis.patch.yml` 的 `- insert:` 块里（`config` 段）：

```yaml
- insert:
    - id: bili-search
      name: dsh-bili-search
      config:
        count: 5          # 默认返回几条（1–20）
        order: totalrank  # 默认排序：totalrank / click / pubdate / dm
        tool: true        # 注册 bilibili_search 工具？false = 工具定义不进请求，只剩 /bili
        command: true     # 注册 /bili 命令？
        personalize: true        # 用观看历史 + 收藏夹给结果重排
        profileCacheMinutes: 30  # 兴趣档案缓存多久（分钟）
        maxFolders: 10           # 最多抓几个收藏夹（按内容量取前 N）
        watchLaterLimit: 30      # 稍后再看取多少条（接口上限 30，0 = 不抓）
        historyWeight: 3.2       # 历史整体权重（默认最高：> 收藏 2 > 稍后再看 1.6）
        cookieFile: ""           # 默认 <DSH_HOME>/bili-search/cookies.json
```

### 运行时设置（不用改配置文件）

```
/bili 设置          看当前设置
/bili 设置 30       观看历史读最近 30 条
/bili 设置 60       改成 60 条
/bili 设置 120      10–120 之间任意整数，超上限自动夹到 120
```

存在 `<DSH_HOME>/bili-search/settings.json`，优先级高于上面的 `config`；改完会顺手清掉档案缓存，下一次搜索按新档重建。

### 两个开关在省什么

| 开关 | 关掉之后 | 省什么 |
|---|---|---|
| `tool: false` | 只剩 `/bili` 命令，模型侧看不到任何工具 | 工具定义不再随每个请求发出；也搜不了自然语言 |
| `command: false` | 只剩工具，斜杠菜单里没有 `/bili` | 一点点菜单开销（几乎为零） |

两个都关 = 插件空转（日志里会警告一句）。

- `/bili` 的成本是 **0 token**：搜索在宿主进程里跑，结果作为 detached notice 直接推给界面，不进会话记录、不产生 provider 请求。
- 工具路径要花 token：每次调用的参数和结果会进上下文，并**在后续每一轮都被重新带上**，直到被裁剪。
- 现值：**`tool: true`**（要省 token 就改成 `false`，改完 1–2 秒生效，`bilibili_search` 会立刻从工具列表消失）。

改完存盘即可，桌面版会热重载 profile 配置（实测 1–2 秒后新配置生效，`plugin.log` 里会多一行「插件已激活（tool=off，command=on …）」）。

## 安装 / 卸载

### 方式 A：从 GitHub 装（推荐）

```sh
dsh plugin --profile <你的 profile> add github:<你的账号>/dsh-bili-search
```

装完 DSH 会热重载配置，`/bili` 立刻可用。

> 桌面版 profile 由 Electron 独占，`dsh plugin --profile desktop ...` 会被拒绝（报 "managed exclusively by the Electron application"）。桌面端请在 **设置 → 插件** 里用 spec 安装，或者用下面的手工方式。

### 方式 B：本地开发（手改 profile）

1. 把本目录放到任意位置；
2. 在 `<DSH_HOME>/profiles/desktop/node_modules/` 下建一个指向它的 junction / 符号链接，名字必须是 `dsh-bili-search`；
3. 在 `<DSH_HOME>/profiles/desktop/package.json` 的 `dependencies` 里加一条 `"dsh-bili-search": "link:<本目录>"`（防止将来 pnpm install 把它当多余包清掉）；
4. 在 `<DSH_HOME>/profiles/desktop/cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: bili-search
         name: dsh-bili-search
         config:
           count: 5
           order: totalrank
   ```

   ⚠️ **必须用 `- insert:` 包一层。** 直接写 `- id: bili-search` 是「修改已有条目」的语义，DSH 只会静静地说一句 `patch: entry "bili-search" not found`，插件根本不会挂上。

5. 存盘，等一两秒。

卸载：删掉 `cordis.patch.yml` 里那段、删掉 `dependencies` 里那条、删掉 junction。
状态文件在 `<DSH_HOME>/bili-search/`（`settings.json` / `profile-cache.json` / `plugin.log` / 可选的 `cookies.json`），一并删掉即可。

## 排错

插件把自己的行为写进 `<DSH_HOME>/bili-search/plugin.log`：

- **日志里不含你的隐私**：只记条数、耗时、错误码与状态，**不记搜索关键词、UP 名、视频标题**（`test/privacy.mjs` 会守住这条）。日志上限 256 KB，超了只保留后半段。
- `插件已激活（defineTool=host…）` —— 装好了；
- `插件已激活（defineTool=local…）` —— 宿主的 `dsh-tools` 没解析到，用的是本地等价实现（功能不受影响）；
- `⚠️ … 注册失败` —— 该入口没挂上，后面会带堆栈。

常见错误：

| 现象 | 原因 |
|---|---|
| `触发了风控（-412）` | 请求太密，等几分钟 |
| `接口要求登录（-101）` | 该 IP 的匿名访问被临时限制 |
| 搜不到东西 | 关键词太偏，或加了太多限定词 |

## 结构

```
index.js            插件入口：注册工具 + 命令（零外部依赖）
lib/bili.mjs        搜索实现：wbi 签名、匿名指纹、结果格式化
lib/personal.mjs    个性化：抓历史/收藏夹/稍后再看、建档案、重排
cordis.patch.yml    自挂载补丁（走 bundles 路线时用得到）
test/               离线自测：npm test（不联网的部分全在这里）
```

## 声明

- 本项目调用的是 **B 站网页端自用的接口**，并非官方开放 API。上游随时可能改动，改动后插件会失效或报错——这类问题不属于 bug，是接口变了。
- 未登录时只用公开的搜索接口；登录态仅用于读取**你自己的**观看历史、收藏夹与稍后再看，凭证只在内存里拼请求头，不落盘、不打印、不上传。
- 请遵守 B 站用户协议，仅作个人使用。请求做了缓存（档案默认 30 分钟），请不要把间隔调到很高频去刷接口。
- 与 B 站官方无关。
