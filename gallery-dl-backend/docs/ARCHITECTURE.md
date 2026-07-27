# 架构与状态机

## 进程边界

FastAPI、`DiscoveryService`、`OrderedCrawlManager`、`CrawlPlanner` 与任务调度器运行在主进程。每个图片任务启动一个：

```text
python -m gdl_backend.worker_entry --marker TASK_TOKEN --gallery-root PATH -- GALLERY_ARGS URL
```

`worker_entry` 从指定源码目录导入 gallery-dl。命令行 marker 用于后端重启时核验 PID，降低 PID 复用导致误终止其他进程的风险。

FastAPI 同源挂载 `/ui/` 下的纯 HTML/CSS/JavaScript 测试台。界面直接调用现有
`/api/v1/search`、`/api/v1/crawls` 与代理池接口，只负责候选选择、顺序调整和状态
展示；搜索归并、顺序约束、代理租约及任务状态仍以后端数据库为准。

代理池控制面运行在 FastAPI 主进程内：`proxy_sources` 先完成全部机场订阅、节点文件和内联节点的解析，再由 `NativeProxyPool` 管理轮换、原子租约和冷却。导入及探活没有节点数量上限。带认证的 HTTP 上游在租约期间由 `LocalHTTPForwarder` 暴露为随机本地端口，任务结束时同步关闭。普通 HTTP/SOCKS 代理直接交给 gallery-dl。

站点授权控制面由 `AuthManager` 管理。X、Pixiv 与 EH 共用
`credentials/managed/browser-profiles/shared/` 下的一个持久 Chrome Profile；宿主进程按授权
会话的需要启动。后端以随机且非零的本地 DevTools 端口启动可见浏览器，端口只绑定 `127.0.0.1`；
三个站点的授权流程串行创建独立标签页，会话终结（成功、失败、取消或超时）时先关闭对应
Target，再整体关闭宿主窗口，不留空白页；登录状态由磁盘 Profile 持久保留，下次授权自动重启宿主。满足 X/EH 必需 Cookie 后原子写入
`credentials/managed/*.cookies.txt`，共享 Profile 中的 Cookie、本地存储和设备历史继续保留。
Pixiv OAuth 由受控 gallery-dl 子进程完成，refresh-token
先写入单次会话的隔离 cache，交换成功后再原子更新后端专用 cache，取消或失败会清理会话 cache；
OAuth callback 监听绑定本次 Pixiv Target，并在页面导航前启用 Network 事件。
FastAPI 只返回授权状态、Cookie 数量、登录会话进度和缺失项，不返回值、配置目录或 DevTools
地址。托管目录在 Windows 上
收紧为当前用户、SYSTEM 与 Administrators，在 POSIX 系统上使用目录 `0700`、文件 `0600`。
Danbooru 公共抓取标记为无需登录。搜索和爬取请求未显式覆盖凭据时，后端按来源自动注入这些
托管文件及 cache；X 枚举后生成的 `pbs.twimg.com` / `video.twimg.com` 媒体直链任务不再携带
账号 Cookie。搜索、EH 规划或下载出现认证错误时，仅与项目托管文件精确匹配的凭据会
写入持久失效标记；调度器跳过仍引用该文件的排队任务，重新登录原子更新 Cookie 和元数据后
下一轮调度自动继续。

`DedupReviewManager` 在主进程中维护持久审核队列，但特征提取和模型推理由仓库根目录
`.venv` 启动 `dedup_review_worker.py` 独立完成。worker 直接复用 `dedup_core.py` 的
L0-L2 分析和 `.models/embeddings.sqlite3` 缓存，只把审核清单写回运行目录；模型阶段不移动
下载文件。服务同一时间只运行一个模型分析进程，退出时终止子进程，重启后重新认领中断任务。

单站清理只删除后端导出的 Cookie 或 Pixiv Token。独立的共享 Profile 清理接口会先取消全部授权
会话并关闭 Chrome 宿主，再删除整个 `shared/` 目录；导出凭证仍由站点接口分别管理。

授权链路支持独立于抓取代理池的「授权专用代理」：`auth.authorization_proxy` 提供配置默认值，
`PUT/DELETE /api/v1/auth/proxy` 的运行时设置持久化在托管元数据中并优先生效（空串覆盖表示强制
直连）。生效时共享 Chrome 以 `--proxy-server` 启动（剥离内嵌凭证、`socks5h` 归一为 `socks5`，
回环 DevTools 流量不受影响），Pixiv OAuth 子进程追加 `-o proxy=` 覆盖 token 交换；宿主按启动时
代理记账，会话间宿主已自动关闭，罕见的存活宿主与新代理不一致时也会在下次授权关旧开新。地址校验只接受
`http/https/socks4/socks5/socks5h` 且带显式端口的 `host:port` 形态。

Clash YAML 隧道节点由 `TunnelTransportCore` 管理一个项目内核心子进程。后端生成一份最小运行配置，每个订阅节点对应一个仅绑定 `127.0.0.1` 的 HTTP listener，并用 listener 的 `proxy` 字段固定到该出站节点。核心只负责协议传输；调度、探活、租约、重试和冷却仍由 Python 控制面负责。

## 跨来源发现与选择

`DiscoveryService` 用 gallery-dl DataJob JSON 协议运行元数据子进程，不下载媒体文件：

- Danbooru：artist 主名称或帖子 artist tag 精确匹配时生成已验证标签地址；仅别名匹配
  且不存在主名称精确命中时进入弱证据区，不把冲突别名或采样帖中的其他角色标签提升；
- X/Twitter 与 Pixiv：账号发现不执行站内搜索。请求这些来源时，后端在内部补充一次
  Danbooru 查询，并只采用 `artist_urls` 中可规范化的活动账号；选中后仍由 gallery-dl
  分别枚举 `/media` 或 `/users/{id}/artworks`；
- EH：保留通用站内搜索；Queue 消息形成具体 `/g/GID/TOKEN/` 画廊地址，再以一次或
  多次 gdata 批量请求补齐标题、封面、页数和标签。所有站内命中都进入默认可选地址，
  后端将标签汇总为官方 namespace `tag_facets[]`；WebUI 在候选行内直接展示封面、标题和
  标签，并提供分组包含/排除过滤和原图/1280 下载选择，由用户结合预览判断；
- Pawchive：使用上游 gallery-dl 自带的 pawchive 提取器枚举 `/artists?q=` 创作者目录
  （名称包含匹配、按收藏数排序）。目录约八成是 kemono 同步、本站从未导入的空壳
  （`ever_imported=false`，profile/posts 均 404），解析层丢弃这些条目，为此枚举窗口按
  `limit×10` 放大；名称与关键词精确一致的候选标记 `verified`，其余进入 `site_search`。
  公共 API 与 `file.pawchive.pw` 文件下载均无需登录。

Danbooru artists API 的通配模糊查询（`any_name_matches` 带 `*`）已因服务端 3 秒语句
超时（按账号等级 3/6/9s，Member 与匿名同档）全部失败，后端画师目录查询因此固定
为无通配精确匹配（服务端归一空格/下划线，匹配 name/other_names/group_name）。模糊
需求由 `GET /api/v1/search/autocomplete?q=` 承接：它代理 Danbooru 搜索框的
autocomplete 接口（`search[type]=tag_query`，前缀匹配主名与翻译别名，`antecedent`
标注命中别名，category 区分画师/角色/作品），WebUI 关键词框防抖 300ms 请求并渲染
下拉，由用户点选确认后回填正式 tag——补全只作展示，绝不静默改写搜索词。

EH 与 Pawchive 没有 Danbooru 那样的人工画师链接维护，画师常以中日文/罗马字等
别名存在，仅按输入关键词检索会漏掉本来存在的画师。搜索这两个来源时，后端会
预取一次 Danbooru 画师目录（与 danbooru 来源共享同一次查询，最多等待 30s，
失败或超时自动降级为原始行为并记入 `enrichment_errors`），从主名或
`other_names` 与关键词精确一致的条目提取至多 4 个别名，与主关键词并行执行站
内搜索后按候选 id 去重合并（主词命中排前，合并结果按 `limit` 截断）。候选记录
`matched_keywords`；证据规则为：EH 仅别名命中的画廊标 `danbooru_alias_search`，
Pawchive 创作者名与别名精确一致时按 `danbooru_alias_name_match` 升为
`verified`。来源级 `alias_keywords[]` 会在响应与 WebUI 中展示实际使用的别名。

`POST /api/v1/search` 可以一次查询多个来源，并始终按请求顺序返回 `sources[]`。
响应的 `sources[].addresses[]` 保存默认可选的已验证账号/标签地址与 EH 站内画廊候选，
`sources[].weak_evidence[]` 保存 Danbooru 仅别名命中的画师候选。WebUI 默认展示
`addresses[]`，用户显式打开弱证据后还可核对并提交次级候选。

EH 标签分组遵循 EHWiki 的 `artist`、`character`、`cosplayer`、`female`、`group`、
`language`、`location`、`male`、`mixed`、`other`、`parody`、`reclass` namespace；
`temp` 单独保留，未识别前缀归入 `unknown`。过滤器采用组内 OR、组间 AND、排除优先，
只作用于浏览器当前候选视图，不重新请求站点或删除响应中的原始地址。
Danbooru artist tag 还会查询 `artists.json` 与 `artist_urls.json`，把人工维护的其他
活动平台主页原样返回。可确定为 X 或 Pixiv 账号的 URL 会同时生成已验证图库地址；
其余主页保存在 `related_profiles` 供前端展示。

## 顺序批次与单地址并发

客户端从搜索响应中选择地址后提交 `sources[]`：

```text
来源 0 / 地址 0（内部图片并发）
  → 来源 0 / 地址 1（内部图片并发）
  → 来源 1 / 地址 0（内部图片并发）
  → ...
```

`OrderedCrawlManager` 只为当前地址建立图片任务。当前地址的全部图片任务进入终态后，
才激活同一来源的下一个地址；来源内地址结束后，再激活下一个来源。因此来源顺序和
地址顺序由 SQLite 持久化，不依赖内存列表或协程完成先后。

每次地址从 `pending` 进入 `planning` 后，管理器先从地址 URL 提取 HTTPS 站点根地址
（站点策略显式配置 `probe_url` 时优先使用），对全池执行一次探活。通过节点集合与探活
摘要按地址持久化；该地址的发现、索引规划及全部图片任务只能从此集合取得租约。服务重启
继续执行已建立任务时从 SQLite 恢复集合，切换到下一个地址时重新探活。

单地址统一执行图片级规划：

- X 账号：枚举时同时收集 gallery-dl `Message.Url` 给出的媒体 CDN URL，完整时直接为每个
  `pbs.twimg.com` / `video.twimg.com` URL 建立任务；只有直链缺失时才回退到状态页 `--range N`；
- Pixiv 账号：枚举时仅保留每个作品的首个协议 URL，并从 Directory 元数据读取真实页数，
  避免多页作品在规划阶段复制整套文件元数据；多图作品再通过独立 `--range N` 任务拆分；
- Danbooru artist/character tag：枚举标签下 posts，每个图片 post 建立一个任务；
- Danbooru post 同时保留 API `source` 中的 Pixiv 作品 ID 或 X/Twitter 状态 ID。
  同一批次后续规划 Pixiv/X 地址时，若稳定来源键已有成功的 Danbooru
  图片任务，则在建立下载任务前跳过整个对应作品；失败或取消的 Danbooru 任务
  不参与预去重。匹配兼容 Pixiv 新旧作品页、Pixiv 原图直链以及 `x.com` / `twitter.com`
  状态页变体；
- EH 画廊：读取索引中的 `/s/TOKEN/GID-NUM`，每张图片建立 `--range 1` 任务；来源级
  `eh_download` 随地址持久化，并写入每个图片任务的策略；
- Pawchive 账号：以 `--post-range` 枚举创作者帖子，每帖读取上游提取器给出的可下载
  文件数 `count`（站点未导入的 deferred 附件不计入）；单文件帖子建立整帖任务，多文件
  帖子按 `--range N` 拆分为逐文件任务，全部为 0 的帖子直接跳过。

搜索、账号/标签枚举和 EH 索引规划使用短期代理租约；每个图片下载任务再独立获取
一个全程粘性的代理租约。Mihomo 隧道节点与原生 HTTP/HTTPS/SOCKS 节点对上层使用
同一 `ProxyPoolAdapter`。请求的 `concurrency` 是当前单地址图片任务并发上限，并再受
`scheduler.max_concurrent_tasks` 全局上限限制。

## 任务状态

```text
queued → starting → running → succeeded
                          ├→ queued（可重试）
                          ├→ failed
                          └→ cancelling → cancelled
```

每次 `running` 都会生成一条 attempts 记录。代理租约在启动 gallery-dl 前持久化，并在任意结束路径的 `finally` 中释放。

图片审核状态独立于爬取终态：

```text
未建立 → pending → analyzing → auto_applying → ready → applying → applied
                       └→ failed                         └→ apply_failed → applying
```

爬取终态不建立审核记录。只有显式调用 `review/start` 才创建 `pending`；读取新建或历史批次、
服务启动和爬取状态迁移均为只读，不会隐式启动模型。

worker 直接保留原脚本 `auto_groups` 中的组类型、winner 和原因。L0 完全相同组及通过原脚本
严格门槛的 L1 压缩/重编码/重采样组继续采用 complete-link 阻断相似链，并使用原
`choose_quality_winner` 择优。`auto_applying` 按记录逐张移动非 winner 及同名 `.txt`；每次移动
前持久化目标路径，进程中断后可继续。自动 winner、L1/L2 人工候选、所有独立图片与读取失败
图片组成完整人工组。每张剩余图片初始为保留，人工组允许空选择；`applying` 再移动人工未选
文件。自动组不计入人工确认总数。

## SQLite 表

- `tasks`：任务状态、站点、输出目录、重试与错误摘要；
- `attempts`：每次执行的 PID、代理节点、退出码和错误分类；
- `leases`：正在使用的节点；
- `task_logs`：脱敏 stdout/stderr/backend 日志；
- `task_events`：状态变化事件；
- `site_policies`：每站策略。
- `crawl_batches`：顺序批次、并发上限和聚合计数；
- `crawl_addresses`：来源顺序、地址顺序、规划状态及来源级凭据；
- `crawl_address_tasks`：地址与图片任务的稳定序号映射。
- `crawl_task_source_keys`：图片任务与 Pixiv/X 稳定来源键的持久化映射，用于批次内预去重。
- `crawl_address_proxy_probes`：每个地址最近一次站点探活目标、时间及汇总；
- `crawl_address_proxy_nodes`：每个地址通过站点探活的节点集合。
- `crawl_reviews`：批次去重分析、人工审核和应用结果的状态与汇总；
- `crawl_review_groups`：重复组、独立图片组、读取失败组及人工确认状态；
- `crawl_review_images`：每张图片的相对路径、质量元数据、保留选择和最终位置。

数据库启用 WAL、foreign_keys、busy_timeout 和 NORMAL synchronous。

## 代理选择

1. 新地址规划前对对应图站执行全池 HTTPS 探活并持久化通过节点；
2. `NativeProxyPool.acquire()` 将候选限制到该地址的通过集合；
3. 原子排除已租用、冷却及任务已尝试节点；
4. 应用站点 `node_tags`；
5. 使用内部轮询游标分配节点，并记录成功、失败和冷却状态；
6. 可选执行任务取用前的二次站点 HTTPS 探活；
7. 任务全程固定同一代理；
8. 仅明确的代理故障处罚节点。

节点 `healthy` 只记录最近一次探活结果；冷却到期后仅将 `retry_eligible` 置为真，不会在没有新探活成功的情况下自动恢复健康状态。默认单节点 HTTPS 探活超时为 10 秒。

## 订阅协议边界

- 直接进入运行池：HTTP、HTTPS、无认证 SOCKS4/SOCKS5/SOCKS5H；
- 带认证 HTTP 由任务级本地转发器承接；带认证 SOCKS5 由传输核心桥接；
- Base64、纯文本、Clash YAML/JSON、sing-box JSON 与 SIP008 均可导入；
- VLESS、VMess、Trojan、Shadowsocks/SSR、Hysteria/Hysteria2、TUIC、AnyTLS、Mieru 进入 `TunnelTransportCore`；
- 每个核心节点映射为一个本地 HTTP endpoint，再与原生代理采用相同的任务租约语义；
- 核心配置写入 `runtime/proxy/transport-core/config.yaml`，日志写入相邻 `core.log`；目录由 `.gitignore` 排除；
- 核心启动前执行配置校验，所有 listener 就绪后才开放代理池。

## gallery-dl 隔离

- 后端从源码路径启动子进程，不调用系统中另一个版本的 gallery-dl；
- 每个任务使用 `--config-ignore`，随后按需加载白名单内的显式配置；
- 输出、代理、Cookie、超时和重试由后端构造；
- 仍需读取 X 状态页的任务强制关闭 gallery-dl Cookie 回写，避免并发更新共享文件；
- `--exec`、输出覆盖、代理覆盖、任意配置注入等参数从 API 层拦截；
- EH 图片任务只根据类型化策略注入 `extractor.exhentai.original` 和
  `extractor.exhentai.gp`，浏览器请求仍不能提交任意 `--option`；
- 子进程 stdout/stderr 统一采集到 SQLite。
- 元数据子进程达到输出或时间上限后，管道收尾也有独立时限，残留 reader 会被取消。
- 子模块源码树保持上游原样。`worker_entry` 在导入 gallery-dl 后应用
  `gdl_backend/worker_patches.py` 的两个运行时补丁：`PathFormat.part_enable`
  重置陈旧 `temppath`，使 `.part` 命名恒为 `<目标路径>.part`，被杀的尝试可在
  下一次尝试用 HTTP Range 续传；`HttpDownloader.receive`/`_receive_rate` 包装
  写入循环，向 `GDL_ACTIVITY_STARTED_FILE`/`GDL_ACTIVITY_FILE` 触发心跳供父进程
  的 EH 卡死看门狗观测（同地址媒体任务共享输出目录，目录 mtime 无法区分单任务
  进度，故必须由子进程逐任务上报）。每个补丁先校验上游签名，不匹配时打印
  `[gdl-backend-patch]` 告警并退回上游原生行为：心跳缺失只会使卡死看门狗不触发，
  下载本身不受影响。
