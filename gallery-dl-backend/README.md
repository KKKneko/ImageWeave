# gallery-dl 独立代理池后端

这是一个 FastAPI 后端，用于统一搜索图库地址、按选择顺序建立图片任务，并通过独立
代理租约运行 gallery-dl：

- `../gallery-dl-codeberg` 保持为上游 Git submodule，源码树不做任何本地修改，
  并始终通过独立子进程调用；后端需要的两处行为差异（跨尝试稳定的 `.part` 命名、
  EH 卡死检测心跳）由 `gdl_backend/worker_patches.py` 在 worker 进程内以运行时
  补丁实现，上游接口变化时补丁自动跳过并在任务日志输出 `[gdl-backend-patch]` 告警；
- `gdl_backend/` 负责搜索、规划、调度、授权、代理池和状态持久化；
- `/ui/` 提供随后端打包、已接入真实 API 的桌面化 WebUI，无需单独构建前端；旧单页资源和
  临时 `/ui-next/` 挂载已在正式切换时删除。

## 运行要求

Linux、Windows 以及纯 CPU/CUDA 的完整安装命令统一维护在
[根 README](../README.md)。后端要求 Python 3.11–3.14，默认只监听本机回环地址。

X、Pixiv、EH 的托管授权需要桌面 Chrome/Chromium；纯后端、下载调度和去重不要求图形界面。
`auth.authorization_proxy` 是授权浏览器的独立代理，与抓取代理池互不影响。

## 主要能力

- 搜索 Danbooru、E-Hentai/ExHentai 与 Pawchive，并从 Danbooru 画师资料补充已验证的 X/Pixiv 账号；
- EH 与 Pawchive 搜索自动携带 Danbooru 画师条目的别名（`other_names`，中日文/罗马字变体）扩搜并合并去重，弥补两站缺少人工链接维护导致的漏检；
- 关键词输入框提供 Danbooru autocomplete 前缀补全（`GET /api/v1/search/autocomplete?q=`），可用画师任意别名前缀（如“柠檬静”）解析出正式 artist tag，由用户自行确认选用，不做静默替换；
- 按来源和地址顺序执行批次，当前地址内部采用图片级并发；
- 利用 Danbooru `source` 在同一批次内预去重，后续 Pixiv/X 作品在建任务前跳过；
- 使用 SQLite/WAL 持久化任务、尝试、事件、日志、租约和批次进度；
- 导入原生 HTTP/HTTPS/SOCKS 代理及常见机场订阅格式；
- 通过 Mihomo 将 VLESS、VMess、Trojan、Shadowsocks、Hysteria、TUIC 等节点桥接为本地 HTTP 出口；
- 对每个新地址执行站点探活，图片任务全程固定一个代理节点；
- 托管 X、Pixiv、EH 的项目专属浏览器授权，Danbooru 与 Pawchive 公共抓取无需登录；
- 为 EH/EHX 批次显式选择 `fullimg` 原图或 1280 查看图，并控制 GP 响应时停止或降级；
- 支持任务取消、失败重试、重启恢复、文件清单和幂等提交；
- 聚合批次结束后可独立启动 L0-L2 去重；严格自动组先淘汰，剩余图片进入分组人工审核。

具体进程边界、状态机、搜索证据规则和代理选择算法见
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## CPU 去重资源 profile

Linux setup 明确写入 `dedup.device=cpu`。以下字段接受 `0`（自动）或正整数覆盖：

| 配置字段 | 16 逻辑 CPU 自动值 | 自动边界 |
| --- | ---: | --- |
| `workers` | 4 | 图片预处理、关系分析和模型解码共用，最多 4 |
| `torch_threads` | 4 | Torch intra-op，同时设置 OpenMP/MKL，最多 4 |
| `torch_interop_threads` | 1 | 每个独立 worker 进程只设置一次 |
| `deep_batch_size` | 2 | CPU 按逻辑 CPU 收敛到 1–4 |
| `neighbor_block_size` | 128 | CPU 按逻辑 CPU 收敛到 64–256 |

CPU 下 OpenCV 固定为 1 个原生线程，避免多个 Python worker 各自展开线程池。worker 在导入
Torch/OpenCV 和启动并行计算前应用边界，并把实际设备、worker、batch、Torch/OpenMP/MKL、
分块和主要阶段耗时写入日志及审核 manifest。资源参数不参与阈值、候选关系、complete-link
分组或质量 winner 判定。`device=auto/cuda` 且字段为 0 时仍沿用原有 8 worker、batch 8、
block 512 且不主动改变 Torch 线程；CPU 服务器应明确使用 `device=cpu`。P0 配置若已有
`workers: 8`，该值会被视为用户覆盖，改为 `0` 才会采用新 profile。

## 最小配置与代理边界

完整字段以 [`config.example.json`](./config.example.json) 为准。示例中的项目抓取代理池和去重
默认禁用，避免在没有节点源、根 venv 或模型时静默进入半可用状态；Linux 安装器会按所选设备
准备模型并启用去重。直连抓取可以保持 `proxy.enabled=false`；需要抓取代理池时再显式启用。
`config.json` 可提供启动基线；代理源管理 API 的修改会作为完整快照写入
`runtime/proxy/managed-sources.json`，且保存不会自动重载代理池。节点文件写接口只接受
`allowed_node_roots` 内的普通、非符号链接文件：

```json
{
  "proxy": {
    "enabled": true,
    "auto_start": true,
    "subscription_urls": ["https://SUBSCRIPTION_URL"],
    "allowed_node_roots": ["../subscriptions"],
    "transport_core_enabled": true
  }
}
```

可通过 `GET /api/v1/proxy/sources` 读取脱敏快照，并用其 `/subscriptions`、`/node-file`、
`/inline-nodes` 子路由增删改；`DELETE /api/v1/proxy/sources/override` 恢复 `config.json`
基线。桌面化入口 `/ui/#/proxy` 的 `PROXY.CPL` 已提供这些操作及运行池控制；保存与应用严格
分离，修改后需显式执行“应用并重载”，活动租约存在时仍返回冲突。

代理探活缓存配置如下；缓存仅驻留内存，并按目标协议、主机名与端口隔离：

| 配置字段 | 默认值 | 说明 |
| --- | ---: | --- |
| `probe_cache_ttl_seconds` | `600.0` | 同一目标主机全量探活结果的复用秒数；设为 `0` 禁用缓存。 |

`/ui/` 的八个主应用已可用，其中七个业务应用完成真实 API 接入，桌面个性化应用严格保持本地：

- `CRAWL.EXE`：autocomplete、聚合搜索、弱证据/EH 标签过滤、来源与地址排序，以及严格批次提交；
- `TASKMGR.EXE`：最近/活动批次、图片任务、1.5 秒活动态轮询、批次取消、失败补齐和重新规划；
- `PROXY.CPL`：运行池控制、脱敏代理源编辑，以及保存/显式重载分离；
- `VAULT.CPL`：五个目标的安全状态、X/Pixiv/EH 共享浏览器授权、材料/Profile 清理和授权专用代理；
- `REVIEW.EXE`：显式分析、服务端分页、逐页决定、离页前保存和危险应用确认；
- `POLICY.CPL`：为 Danbooru、X、Pixiv、EH 与 Pawchive 调整四项“各站运行设置”；
- `DIAG.EXE`：20 秒只读轮询健康、就绪、最小配置能力和调度摘要，离线时保留安全旧快照；
- `DESKTOP.CPL`：安全自定义强调色与窗口底色，并管理六种静态纯色、本地静态图片、可读性、动效二态和 92%–100% 窗口不透明度；不发起网络请求或调用业务 API。

界面主题默认值为墨灰纸白 `#46515D / #F4F1EA`。两个字段只接受规范化严格六位 HEX；任意
对比度（包括相同颜色和约 `1.00:1` 的组合）都可预览、应用并恢复，界面只同步显示实际对比度。
窗口底色自动派生 `light/dark` `color-scheme`；forced-colors 使用系统色。主题与其余个性化字段
共用同一完整草稿、Apply/Cancel 和既有 UI preference key。

`GALLERY.EXE`、`SCHEDULE.EXE` 与 `EXPORT.EXE` 仍是明确的“功能开发中”边界入口，不发送业务
API。`VAULT.CPL` 不提供后端不存在的手工 Cookie/Token、浏览器导入、文件路径导入或远端验证
按钮；来源勾选/排序、每请求路由和 EH 标签 include/exclude 过滤只属于 `CRAWL.EXE`。

### 各站运行设置（POLICY.CPL）

页面面向 Danbooru、X / Twitter、Pixiv、EH 与 Pawchive，每个网站只提供四项设置：

| 页面名称 | API 字段 | 范围或选项 |
| --- | --- | --- |
| 并发任务 | `max_concurrency` | 1–128 |
| 重试次数 | `retry_limit` | 0–20 |
| 重试间隔 | `backoff_base_seconds` | 0–3600 |
| 代理方案 | `proxy_mode` | `direct`、`prefer`、`required` |

桌面页面使用 `?view=policy` 读取五站快照，并通过
`PUT /api/v1/sites/policies/{site}?view=policy` 保存所选网站的完整四字段对象。默认响应形状仍可供
旧客户端读取，但所有 PUT 形状都使用同一个四字段请求模型：缺字段、未知字段以及旧高级字段一律
返回 422，不会忽略后写入。`DELETE` 删除该网站的四字段覆盖，让它重新使用统一默认。

以下运行参数由后端固定，不属于 POLICY API 或 `default_site_policy` 的配置面：

```text
probe_url                         = null
probe_before_use                  = true
node_tags                         = []
http_timeout                      = 60.0
gallery_retries                   = 2
task_timeout_seconds              = 7200.0
download_stall_timeout_seconds    = 300.0
eh_download                       = null
extra_args                        = []
```

`default_site_policy` 也只读取前述四字段；旧配置文件中的高级键会被丢弃，不能改变新任务运行参数。
运行时由后端把四字段与固定值合成为完整 `SitePolicy`。单次任务或 CRAWL 请求的显式
`proxy_mode` 仍优先；CRAWL 的 EH 图片版本/GP 选择与受控单次附加参数仍按请求进入任务快照，不会
被站点固定值误删。

保存只影响之后新建的搜索、规划和任务。已经创建、排队或运行的任务继续使用创建时持久化的完整
快照。数据库 schema v8 在首次升级时与版本标记同一事务清空全部旧 `site_policies` 行；升级完成后
新建的四字段覆盖会在后续重启中保留，不会反复清除。

页面不轮询；激活和写入后读取一次最新值。未保存内容只留在当前表单，切换网站、切换应用、最小化、
关闭和浏览器离开都会先确认。错误只显示受控提示和请求 ID，不回显提交原文。

`HTTP_PROXY`/`HTTPS_PROXY` 和 setup 的 `--proxy` 只服务于 git/pip/Mihomo/模型下载，不会写入
config，也不会被 doctor 当作抓取代理池节点。Mihomo 是抓取池中 VLESS/VMess/Trojan 等隧道
节点的本地传输核心，不是节点订阅本身。`auth.authorization_proxy` 又是共享授权 Chrome 的第三
条独立线路。后端完整导入项目节点后统一探活，不限制导入数量。

默认从项目 `bin/` 和系统 `PATH` 查找 Mihomo。其他位置使用
`proxy.transport_core_binary`；需要固定校验本地可执行文件时，再设置
`proxy.transport_core_sha256`。

## 启动与入口

推荐从根目录运行 `./scripts/run.sh`，它会先执行快速 doctor。直接运行后端脚本时只使用明确的
`PYTHON` 或 `gallery-dl-backend/.venv/bin/python`；venv/config 缺失会 fail-fast，不再回退
系统 Python 或静默使用默认配置。`--config`、`--host` 和 `--port` 会继续透传：

```bash
bash gallery-dl-backend/run_backend.sh --port 8788
```

Windows 从仓库根目录运行 PowerShell 启动器；它固定使用后端 venv，不会退回系统 Python：

```powershell
.\gallery-dl-backend\run_backend.ps1
```

默认入口：

| 用途 | 地址 |
| --- | --- |
| WebUI | `http://127.0.0.1:8787/ui/` |
| API | `http://127.0.0.1:8787/api/v1` |
| Swagger | `http://127.0.0.1:8787/docs` |
| 健康检查 | `http://127.0.0.1:8787/healthz` |
| 就绪检查 | `http://127.0.0.1:8787/readyz` |

`/healthz` 只表示进程与 SQLite 存活；`/readyz` 结构化报告 submodule、调度器、项目抓取代理、
Mihomo、去重 Python、Torch 实际设备及 SSCD/DINOv2 缓存。禁用组件显示 `disabled`，启用去重
但 Python/Torch/任一启用模型缺失时返回 HTTP 503。`./scripts/doctor.sh` 做同类快速检查，并额外
报告配置、runtime、SQLite/sidecar、credentials/managed、模型缓存及外部输出边界，不下载模型、
不运行推理，也不会打印订阅 URL、Cookie、token、代理凭据或完整授权数据。

应用管理目录（runtime 元数据、credentials/managed、审核日志/manifest、代理核心配置、模型
缓存）为 0700，敏感文件为 0600；创建前拒绝管理路径现有组件中的符号链接。setup 使用 `umask 077` 并只
修复上述项目管理路径。`default_output_root` 位于 runtime 内时由应用维护；用户配置到外部的
输出根目录不被 setup、应用或 doctor 递归 `chmod`，doctor 只诊断。

### 本地网络与安全边界

服务只允许绑定回环地址。

- 后端仅接受与 `server.port` 匹配的 `127.0.0.1`、`localhost` 或 `[::1]` 回环 Host；不支持通过反向代理或自定义域名访问。SSH 本地端口转发仍可用，本地端口应与 `server.port` 一致。

任务和探活目标默认拒绝回环、私网、链路本地及保留 IP。
`server` 区域的目标地址校验开关如下：

| 配置字段 | 默认值 | 说明 |
| --- | --- | --- |
| `strict_target_dns` | `true` | 要求 DNS 返回的每个地址均为公网；仅在确认某个合法站点被误拒时才改为 `false`，退回“至少一个公网地址”的兼容模式。 |

本地部署确需访问局域网图站时，在 `server` 配置中设置
`"allow_private_targets": true`。

## Linux CPU CI 分层

- `.github/workflows/linux-cpu-fast.yml`：每次 push/PR/手动触发；检查 Shell 语法和锁漂移，
  在 Python 3.11/3.14 跑后端完整测试，并在 3.14 做干净 CPU 锁安装、根测试、CPU 纯净性、
  `/healthz` 与 ready/not-ready 语义。快速层不下载大模型。
- `.github/workflows/linux-cpu-real-models.yml`：每周和手动触发；缓存固定公开模型，校验
  SSCD+DINOv2，并用程序生成、无敏感内容的图片跑 CPU worker 闭环。
- 两层均复用仓库 setup/smoke 脚本，不包含开发机代理。私人 `runtime/downloads` 样本测试继续
  可选；它不再是唯一真实回归证据。

本地复现关键 smoke：

```bash
./.venv/bin/python ./scripts/check-cpu-environment.py
./scripts/smoke-linux-service.sh
./.venv/bin/python ./scripts/run-real-model-smoke.py --base-images 4
```

## WebUI 工作流

1. （可选）在 `DESKTOP.CPL` 调整严格六位 HEX 的强调色、窗口底色及其他本地个性化设置；任意颜色组合均可直接预览和应用。
2. 查看代理池状态，按需启动、重载或探活。
3. 在“站点登录授权”中完成所需站点登录。
4. 输入关键词搜索来源，核对候选和弱证据，并调整来源/地址顺序。
5. 设置单地址图片并发数，提交批次并查看地址与图片任务状态。
6. 批次结束后按需启动去重，再审核剩余重复组与独立图片，保存选择并应用整理结果。

界面直接调用下述 API；搜索归并、执行顺序、代理租约和任务状态均以后端数据库为准。

### 桌面 WebUI 状态、轮询与安全边界

所有业务请求只经同源 `js/core/api.js` 和应用 `context.api` 发出；应用模块不直接调用
`fetch`/XHR。后端响应必须先经过对应 model 白名单投影，再通过受控 action 进入中央 Store。
爬取提交所需的原始地址只在 CRAWL 控制器内短暂保留，批次/任务/review 响应中的 URL、绝对路径、
原始错误和内部载荷不会进入 Store 或 DOM。`sessionStorage` 只保存当前应用 ID 与活动批次 UUID；
`LocalStorage` 只保存窗口最大化状态及规范化后的 UI 偏好白名单。既有
`imageweave.ui:ui-preferences` 中的个性化值始终是完整偏好对象，主题只占
`themeAccent/themeSurface` 两个规范化严格六位 HEX 字段；不建立主题专用 key，也不保存 CSS 声明、
选择器、`var()`、颜色函数或其他 CSS 文本。LocalStorage 仍不接受图片内容、文件名、路径、
Base64/Data URL 或 Blob URL。

`DESKTOP.CPL` 不发起网络请求、调用业务 API、增加后端端点或上传主题/图片。本地 JPG/PNG/WebP 经
解码与 Canvas 静态重编码后，只有重编码 Blob 会写入 IndexedDB；原始 `File`、文件名、路径和临时
Object URL 不进入中央 Store 或 LocalStorage，图片也不会上传。IndexedDB 不可用或配额写入失败时
保留旧壁纸并给出安全提示；偏好指向的记录缺失或损坏时清理无效记录并回退默认 `graphite`，这些
故障不阻断桌面壳层启动。主题颜色不进入 IndexedDB、中央 Store、dataset、业务 API 或上传路径；
只有通过严格六位 HEX 整对投影后的两个字段随完整偏好写入 LocalStorage；对比度不参与合法性判断。桌面与主题设计/验收分别见
[`../docs/webui-desktop-personalization.md`](../docs/webui-desktop-personalization.md) 与
[`../docs/webui-interface-theme-personalization.md`](../docs/webui-interface-theme-personalization.md)。

`TASKMGR.EXE` 仅对活动批次执行一个 1.5 秒、生命周期受控且不重叠的轮询，终态、404、最小化、
关闭或切出应用即停止；写操作加锁并在完成后读取权威快照。`REVIEW.EXE` 只在分析处理中轮询，翻页、
切换批次或离开应用前先保存当前脏页，保存失败则阻止切换。`DIAG.EXE` 使用一个 20 秒只读轮询；
`GET /api/v1/config?view=diagnostics` 与 `GET /api/v1/scheduler/status?view=diagnostics` 只返回受控
布尔值、计数和枚举，不返回主机路径、秘密、配置正文、任务标识或原始异常。默认不带 `view` 的
legacy API 契约保持兼容。

异常界面只显示受控错误码与恢复动作，不渲染后端 `details`。控制台只允许固定文本的壳层故障提示，
不记录用户输入、请求/响应、凭据、路径或异常对象。桌面 WebUI 不需要 Node/npm、打包器、跨域服务或
独立前端进程，其模块、样式与资源均随后端 wheel 同源提供。

## 托管授权

| 站点 | 授权方式 | 托管结果 |
| --- | --- | --- |
| X | 项目专属 Chrome 登录 | X/Twitter Cookie |
| Pixiv | 项目专属 Chrome OAuth | 后端专用 gallery-dl cache |
| EH | 项目专属 Chrome 登录 | E-Hentai/ExHentai Cookie |
| Danbooru | 公共 API | 无需登录 |
| Pawchive | 公共 API | 无需登录 |

X、Pixiv 和 EH 共用项目目录中的持久 Chrome Profile，但每次授权使用独立标签页。后端只
管理这个 Profile，不读取用户日常浏览器数据。搜索、规划或下载实际返回认证错误后，凭证
才会标记为失效；重新授权成功后，尚未运行的同站任务会继续调度。

删除单站授权只删除该站导出的 Cookie 或 Token；删除共享浏览器 Profile 会停止授权会话并
清理浏览器状态，但不会自动删除已经导出的站点凭证。权限、缓存交换和失效恢复细节见
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#进程边界)。

`VAULT.CPL` 使用相同路由的 `?view=vault` 响应 profile。默认 `legacy` 响应保持兼容；`vault`
投影只保留受控站点/会话 ID、布尔能力、计数与时间，移除 Pixiv 完整授权 URL、原始会话错误、
失效原因、绝对路径及非必要代理字段；VAULT 操作失败也只返回白名单错误码和受控消息，不透传
`AuthError.message/details`。前端再经 `js/core/vault-model.js` 二次白名单投影后才进入中央
Store；会话 ID 只短暂保存在应用控制器中，不进入 Store、DOM 或 Storage。

授权代理是唯一由 VAULT 表单提交的敏感自由文本：输入使用默认隐藏控件，构造 JSON 后、发请求
前即清空，成功、失败、确认取消、最小化、关闭、路由切换和销毁都会再次清空。代理写接口限制
字段长度和 `Content-Length`，Pydantic 错误不含原始 `input`。普通状态只在激活、写后和手动刷新
时读取；仅活动授权会话使用一个 `vault.authorization`、800ms、隐藏暂停的非关键轮询器。

## API 概览

请求和响应模型以运行中的 [Swagger](http://127.0.0.1:8787/docs) 为准。主要端点：

```text
GET  /api/v1/proxy/status
POST /api/v1/proxy/start
POST /api/v1/proxy/reload
POST /api/v1/proxy/probe
POST /api/v1/proxy/stop

GET    /api/v1/auth
GET    /api/v1/auth/proxy
PUT    /api/v1/auth/proxy
DELETE /api/v1/auth/proxy
GET    /api/v1/auth/{site}
POST   /api/v1/auth/{site}/login/start
GET    /api/v1/auth/{site}/login/{session_id}
DELETE /api/v1/auth/{site}/login/{session_id}
POST   /api/v1/auth/pixiv/oauth/start
DELETE /api/v1/auth/pixiv/oauth/session
DELETE /api/v1/auth/browser-profile
DELETE /api/v1/auth/{site}

GET  /api/v1/search/sites
GET  /api/v1/search/autocomplete
POST /api/v1/search

GET  /api/v1/config?view=diagnostics
GET  /api/v1/scheduler/status?view=diagnostics

POST /api/v1/crawls
GET  /api/v1/crawls
GET  /api/v1/crawls/{batch_id}
GET  /api/v1/crawls/{batch_id}/tasks
POST /api/v1/crawls/{batch_id}/cancel
POST /api/v1/crawls/{batch_id}/retry
POST /api/v1/crawls/{batch_id}/rerun
GET  /api/v1/crawls/{batch_id}/review
POST /api/v1/crawls/{batch_id}/review/start
PUT  /api/v1/crawls/{batch_id}/review/decisions
POST /api/v1/crawls/{batch_id}/review/apply
POST /api/v1/crawls/{batch_id}/review/retry
GET  /api/v1/crawls/{batch_id}/review/images/{image_id}

POST /api/v1/tasks
GET  /api/v1/tasks
GET  /api/v1/tasks/{id}
POST /api/v1/tasks/{id}/cancel
POST /api/v1/tasks/{id}/retry
GET  /api/v1/tasks/{id}/logs
GET  /api/v1/tasks/{id}/events
GET  /api/v1/tasks/{id}/files

GET    /api/v1/sites/policies
GET    /api/v1/sites/policies/{site}
PUT    /api/v1/sites/policies/{site}
DELETE /api/v1/sites/policies/{site}
```

授权读取与操作端点均接受可选 `view=vault`，供桌面 WebUI 取得不含完整 OAuth URL 和原始诊断文本
的最小响应；不传该参数时保持旧响应兼容。Pixiv OAuth 和共享 Profile 清理使用上表专用端点。

### 搜索

`POST /api/v1/search`：

```json
{
  "keyword": "artist name",
  "sites": ["danbooru", "x", "pixiv", "eh", "pawchive"],
  "limit": 20,
  "proxy_mode": "required"
}
```

响应按请求中的站点顺序返回 `sources[]`：

- `addresses[]` 保存默认可选的已验证账号/标签地址和 EH 画廊候选；
- `weak_evidence[]` 保存 Danbooru 仅别名匹配、尚未闭环的画师候选；
- `related_profiles` 保存 Danbooru 人工维护的其他平台主页；
- EH 候选带标题、封面、页数和按官方 namespace 分组的 `tag_facets[]`；
- Pawchive 候选来自站内创作者目录（名称包含匹配，按收藏数排序），
  已过滤本站从未导入的 kemono 同步空壳条目。

详细匹配与过滤规则见
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#跨来源发现与选择)。

### 顺序批次

客户端从搜索响应中选择地址后，按期望顺序提交到 `POST /api/v1/crawls`：

```json
{
  "sources": [
    {
      "site": "danbooru",
      "addresses": [
        {
          "address_type": "artist_tag",
          "label": "artist name",
          "url": "https://danbooru.donmai.us/posts?tags=artist_name"
        }
      ]
    },
    {
      "site": "pixiv",
      "addresses": [
        {
          "address_type": "account",
          "label": "Artist",
          "url": "https://www.pixiv.net/users/USER_ID/artworks"
        }
      ]
    },
    {
      "site": "eh",
      "addresses": [
        {
          "address_type": "gallery",
          "label": "Gallery",
          "url": "https://e-hentai.org/g/GID/TOKEN/"
        }
      ],
      "eh_download": {
        "image_mode": "original",
        "gp_policy": "stop"
      }
    }
  ],
  "concurrency": 20,
  "max_tasks": 10000,
  "proxy_mode": "required"
}
```

来源和地址顺序串行推进，只有当前地址内部的图片任务并发。每个新地址开始前会进行一次
站点探活，并把通过节点集合持久化；该地址的规划与下载只从此集合取得租约。`concurrency`
还受全局调度上限限制，`max_tasks` 限制整个批次的媒体任务规模。
地址详情中的 `pre_dedup_skipped_count` 记录在建立任务前按来源键跳过的媒体任务数；这些项不会进入 `task_count` 或任务列表。

爬取和去重是两个独立的可选环节。批次进入终态后保持“去重未开始”，只有
`POST review/start` 或 WebUI 的“开始去重分析”会建立任务；读取详情、载入历史批次和服务启动
都不会触发分析。启动后，`dedup` 管理器使用仓库根目录的独立 `.venv` 和 `.models` 分析实际
下载文件。原脚本判定的 L0 完全相同组和严格 L1 压缩/重编码/重采样组沿用其 complete-link
分组和质量 winner，非 winner 自动移入 `duplicates/`；自动 keeper、L1/L2 人工候选、独立图
及解码失败图进入审核。`review/decisions` 以组为单位保存 `selected_image_ids`，空数组表示整组
不保留；`review/apply` 将人工未选图片及其同名 `.txt` 移入批次根目录的 `duplicates/`，并保留
原相对目录层级。严格自动淘汰也同步移动同名 `.txt`。应用前要求所有人工组均已确认，分析、
自动整理和应用状态均持久化，可在服务重启后恢复或重试。

EH/EHX 来源的 `eh_download.image_mode` 接受 `original` 或 `resample`。原图模式下，
`gp_policy=stop` 保持严格原图并在 GP 响应时停止，`gp_policy=resized` 允许 gallery-dl
降级为 1280 查看图。WebUI 默认提交 `original + stop`。EH 图片任务使用后端固定的 300 秒
无进展保护，超时会结束当前尝试并按任务的 `max_attempts` 自动换代理重试；已存在的完整文件仍由
gallery-dl 跳过。
批次终态若仍有失败图片，可调用 `POST /api/v1/crawls/{batch_id}/retry`（或 WebUI 的“补齐失败下载”），
只重新排队失败任务，不会重跑成功任务。

### 代理策略

- `direct`：始终直连；
- `prefer`：有健康节点时使用代理，代理池降级时直连；
- `required`：必须取得健康节点，否则按站点策略重试。

例外：节点源包含需要 mihomo 传输核心的隧道节点时，核心启动失败会使代理池启动直接报错
（不再丢弃隧道节点降级续跑）；该状态下 `prefer` 与 `required` 任务立即终止并在任务日志
中提醒，不会回退直连，修复核心后在 WebUI 重新启动代理池再重试。其余场景（代理池被停止、
未启动或运行中暂无可租节点）行为不变。

各站运行设置只开放并发任务、重试次数、重试间隔和代理方案。其余运行参数由后端固定；完整四字段
请求模型由 `PUT /api/v1/sites/policies/{site}` 的 Swagger 定义。

## 失败与恢复

- 明确的代理连接、CONNECT、407 或 TLS 故障会处罚并冷却当前节点；
- 429、502、503、504 作为站点临时错误重试，不处罚节点；
- 认证错误会标记对应托管凭证失效，并暂停尚未运行的同站任务；
- 输入错误、不支持 URL 和资源不存在直接进入终态；
- 后端重启会核验 worker marker、回收遗留进程并重新排队仍可重试的任务；
- 用户取消先中断进程组，超时后终止整个子进程树。

## 测试与诊断

完整单元回归：

```bash
python -m unittest discover -s tests -v
```

测试默认使用本地夹具、mock 或 gallery-dl `--version`。需要真实凭据和代理节点的 EH
烟雾脚本见 [`scripts/README.md`](./scripts/README.md)。
