# 旧 WebUI 流程与 API 请求基线

> 历史记录：模块化桌面 WebUI 已正式切换到 `/ui/`，旧单页资源与临时 `/ui-next/` 挂载均已删除。
> 维护者明确不保留旧界面截图或资源副本；本文只保留迁移时使用的行为与请求语义。

本文记录阶段 0 冻结的旧 WebUI 行为，供后续模块化迁移逐项对照。它描述的是
`gdl_backend/webui/index.html`、`app.js` 与 `styles.css` 当前实际行为，不为新界面增加需求，
也不改变后端 API 语义。

## 1. 基线范围与证据

- 阶段 0 的生产兼容入口为 `/ui/`，页面标题与主标识为“聚合爬取测试台”。
- 静态资源使用相对路径 `./styles.css` 与 `./app.js`，由 FastAPI 同源托管。
- 请求基线来自 `gdl_backend/webui/app.js` 中的 `api()`、各工作流函数与事件绑定。
- DOM 与交互入口来自 `gdl_backend/webui/index.html`；样式与响应式行为来自
  `gdl_backend/webui/styles.css`。
- 阶段 0 的 `tests/test_api.py::ApiTests.test_webui_static_assets_and_root_link` 验证旧入口和旧资源；
  当时的隔离测试验证开发入口没有替换旧页面。
- `/ui-next/` 在阶段 0 只是独立静态健康占位，不属于本基线中的业务功能。

### 通用请求约定

- 所有业务请求均使用同源相对 URL，不设置 CORS，也不依赖独立前端服务。
- `api()` 默认使用 `GET`，所有 Fetch 请求设置 `cache: "no-store"`。
- 仅在存在请求体时设置 `Content-Type: application/json` 并执行 JSON 序列化。
- 非 2xx 响应优先读取 `error.message`，并保留响应中的 `request_id` 供界面报错。
- 旧页面只在 `sessionStorage` 保存键 `gdl.activeBatch`，用于恢复当前批次 ID。

## 2. 健康检查与代理池

### 流程清单

- [x] 页面启动时执行连接检查。
- [x] 连接检查先请求进程健康与公共配置，再并行刷新代理、授权和最近批次。
- [x] 展示代理池运行、节点、健康节点、租约和传输核心摘要。
- [x] 提供启动、重载、全池探活与非强制停止操作。
- [x] `/readyz` 不是旧页面的请求；旧页面只调用 `/healthz`。

| 方法与路径 | 触发点 | 请求基线 | 界面处理 |
| --- | --- | --- | --- |
| `GET /healthz` | 启动、手动“检测连接” | 无请求体 | 非 2xx 判定连接失败 |
| `GET /api/v1/config` | 同上 | 无请求体 | 成功后将 API 标记为已连接 |
| `GET /api/v1/proxy/status` | 启动、连接检查、代理操作后 | 无请求体 | 更新代理摘要、状态标记和脱敏错误 |
| `POST /api/v1/proxy/start` | “启动代理池” | `{"force_refresh": true}` | 渲染返回状态并再次刷新 |
| `POST /api/v1/proxy/reload` | “重载节点” | `{"force_refresh": true}` | 渲染返回状态并再次刷新 |
| `POST /api/v1/proxy/probe` | “全池探活” | `{}` | 显示 `healthy/total` 后刷新状态 |
| `POST /api/v1/proxy/stop` | “停止代理池” | `{"force": false}` | 不提供默认强制停止路径 |

## 3. 聚合搜索、补全与来源选择

### 补全

- [x] 关键词至少 2 个字符后，以 300ms 防抖请求 Danbooru 补全。
- [x] 请求固定 `limit=10`；失败时静默关闭建议框，不影响手工输入。
- [x] 用户点击建议后才回填正式值，不静默改写搜索词。

```text
GET /api/v1/search/autocomplete?q=<URL 编码关键词>&limit=10
```

建议项显示 `category`、`label/value`、可选 `antecedent` 与 `post_count`。

### 聚合搜索

- [x] 至少选择一个来源并提供非空关键词。
- [x] 来源数组保持复选框顺序：`danbooru`、`twitter`、`pixiv`、`exhentai`、`pawchive`。
- [x] `limit` 限制为 1–200；搜索代理模式为 `required`、`prefer` 或 `direct`。
- [x] `source_options` 仅包含用户实际填写的来源覆盖；当前页面只提供来源级 `proxy_mode`。
- [x] 响应保留来源顺序，并展示地址数、弱证据、关联主页、来源错误与原始响应。

```http
POST /api/v1/search
Content-Type: application/json
```

```json
{
  "keyword": "示例关键词",
  "sites": ["danbooru", "twitter", "pixiv", "exhentai", "pawchive"],
  "limit": 20,
  "proxy_mode": "required",
  "source_options": {
    "pixiv": {"proxy_mode": "prefer"}
  }
}
```

搜索成功后，旧页面把每个来源的 `addresses[]` 与 `weak_evidence[]` 合并为可排序的浏览器状态，
并按 URL 或 ID 去除重复项。默认只显示正式候选；关闭“显示弱证据”时会同时取消已选弱证据。

### 来源、地址顺序与 EH 筛选

- [x] 来源可整体选择/取消并上下移动；提交顺序就是当前来源数组顺序。
- [x] 地址可在当前可见集合内上下移动；提交顺序就是来源内当前数组顺序。
- [x] EH 标签解析兼容 namespace 缩写，并归一到 `artist`、`character`、`cosplayer`、
  `female`、`group`、`language`、`location`、`male`、`mixed`、`other`、`parody`、
  `reclass`、`temp` 或 `unknown`。
- [x] EH 包含条件同 namespace 内为 OR、跨 namespace 为 AND；排除条件优先。
- [x] EH 标签筛选完全在浏览器内执行，不发起新请求，不删除搜索响应中的地址。
- [x] 筛选外已选项保持选择并在计数中明确提示；“全选当前显示”只影响可见项。
- [x] EH 候选展示封面、标题、元数据标签与 `tag_facets[]`，图片使用懒加载。

## 4. 授权与授权代理

### 流程清单

- [x] 页面启动和连接检查读取所有站点授权状态。
- [x] X 与 EH 使用共享浏览器登录会话；活动会话约每 800ms 轮询一次。
- [x] Pixiv 使用共享浏览器 OAuth；活动期间约每 800ms 读取 Pixiv 授权状态。
- [x] 支持取消当前授权标签页、删除单站导出凭证和清空共享浏览器 Profile。
- [x] 删除单站凭证与删除共享 Profile 是两个独立操作，界面文案明确区分。
- [x] 授权专用代理可保存运行时覆盖或恢复配置默认值。
- [x] 含凭据代理只显示后端脱敏值，不回填秘密到输入框。

| 方法与路径 | 用途 | 请求体或轮询条件 |
| --- | --- | --- |
| `GET /api/v1/auth` | 全站授权与授权代理摘要 | 启动、刷新、连接检查 |
| `POST /api/v1/auth/{site}/login/start` | 启动 X/EH 共享浏览器授权 | 无请求体 |
| `GET /api/v1/auth/{site}/login/{session_id}` | 查询 X/EH 会话 | `starting`、`awaiting_login` 时继续轮询 |
| `DELETE /api/v1/auth/{site}/login/{session_id}` | 取消 X/EH 会话 | 无请求体 |
| `POST /api/v1/auth/pixiv/oauth/start` | 启动 Pixiv OAuth | 无请求体 |
| `GET /api/v1/auth/pixiv` | 查询 Pixiv OAuth 状态 | 活动状态时继续轮询 |
| `DELETE /api/v1/auth/pixiv/oauth/session` | 取消 Pixiv OAuth | 无请求体 |
| `DELETE /api/v1/auth/{site}` | 删除单站导出凭证 | 用户确认后执行 |
| `DELETE /api/v1/auth/browser-profile` | 清空共享授权浏览器 Profile | 用户确认后执行 |
| `PUT /api/v1/auth/proxy` | 保存授权代理覆盖 | `{"proxy_url": "<用户输入或空串>"}` |
| `DELETE /api/v1/auth/proxy` | 恢复配置默认 | 无请求体 |

任务列表出现 `authentication` 错误分类时，旧页面会刷新授权状态，并为尚未授权的对应站点显示
重新授权提示；它不会在浏览器内处理或持久化 Cookie、Token。

## 5. 顺序批次创建

- [x] 只提交已选来源和地址，并保持用户调整后的两级顺序。
- [x] 地址字段为可选 `id`、`label`、`address_type` 与必需 `url`；未定义字段由 JSON 序列化省略。
- [x] 来源级路由覆盖直接合入对应来源对象。
- [x] EH 来源附加 `eh_download.image_mode` 与 `gp_policy`，默认 `original + stop`。
- [x] 全局设置包含 `concurrency`（1–128）、`max_tasks`（1–100000）与 `proxy_mode`；
  非空输出目录才提交 `output_dir`。
- [x] 每次创建都发送新的 `Idempotency-Key`，格式为 `webui-<UUID>`；无 `randomUUID` 时使用时间戳回退。

```http
POST /api/v1/crawls
Idempotency-Key: webui-<随机值>
Content-Type: application/json
```

```json
{
  "sources": [
    {
      "site": "danbooru",
      "addresses": [
        {
          "id": "候选 ID",
          "label": "候选名称",
          "address_type": "artist_tag",
          "url": "https://example.invalid/gallery"
        }
      ]
    },
    {
      "site": "exhentai",
      "addresses": [
        {
          "label": "EH 候选",
          "address_type": "gallery",
          "url": "https://example.invalid/eh-gallery"
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

创建成功后，旧页面把批次 ID 写入内存和 `sessionStorage` 的 `gdl.activeBatch`，立即载入批次、
刷新最近批次并启动轮询，然后滚动到监控区域。

## 6. 批次监控、恢复与任务

### 批次监控

| 方法与路径 | 用途 | 基线行为 |
| --- | --- | --- |
| `GET /api/v1/crawls?limit=30` | 最近批次 | 保持当前批次选中 |
| `GET /api/v1/crawls/{batch_id}` | 批次详情 | 与任务页并行请求 |
| `GET /api/v1/crawls/{batch_id}/tasks?limit=1000` | 图片任务页 | 固定显示上限 1000 |
| `POST /api/v1/crawls/{batch_id}/cancel` | 取消活动批次 | 请求体 `{}`，用户先确认 |
| `POST /api/v1/crawls/{batch_id}/retry` | 补齐失败下载 | `{"additional_attempts": 2}`；仅终态且 `resumable` 时显示 |
| `POST /api/v1/crawls/{batch_id}/rerun` | 重新爬取 | 请求体 `{}`；任意终态批次可用 |

- [x] 自动刷新默认开启，活动爬取或未稳定审核约每 1500ms 刷新。
- [x] 同一批次不并发发起重复刷新；请求 token 防止旧响应覆盖新选择。
- [x] 从 `sessionStorage` 恢复批次 ID；用户也可从最近 30 个批次手动载入。
- [x] 恢复出的批次返回 404 时清除陈旧 ID 并停止轮询，避免每 1.5 秒持续请求。
- [x] 终态爬取且审核进入稳定状态后停止轮询。
- [x] 取消、补齐失败与重新爬取成功后重新刷新批次和最近批次。
- [x] 原始批次与任务 JSON 只在详情块展开时序列化，避免轮询期重复处理大对象。

### 图片任务

- [x] 旧页面使用批次级任务接口，不调用独立的 `/api/v1/tasks/{id}` 操作端点。
- [x] 列表展示稳定顺序、来源、状态、尝试次数与 URL。
- [x] 当任务总数超过 1000 时明确显示“前 1000 / 总数”，完整进度以批次聚合计数为准。
- [x] 任务的 `error_class` 或 `last_error_class` 为 `authentication` 时触发授权恢复提示。
- [x] 旧页面没有单任务取消、重试、日志、事件或文件浏览按钮；后续迁移不得把这些后端能力误记为旧 UI 行为。

## 7. 去重分析、分页、保存与应用

### 状态与启动

- [x] 只有批次进入终态后才显示审核区域；读取批次不会隐式启动分析。
- [x] `not_started` 或 `waiting_for_crawl` 时显式调用
  `POST /api/v1/crawls/{batch_id}/review/start`，请求体为 `{}`。
- [x] 分析失败时调用 `POST /api/v1/crawls/{batch_id}/review/retry`，请求体为 `{}`。
- [x] 分析及应用中的非稳定状态沿用批次 1500ms 轮询，不另建并发轮询器。
- [x] 汇总展示全部图片、严格自动组、严格自动淘汰、重复组、当前保留、已确认组、读取失败，
  应用后再展示移出与失败数量。

### 分页与筛选

```text
GET /api/v1/crawls/{batch_id}/review?limit=8&offset=<offset>[&kind=<kind>]
```

- [x] 固定服务端分页大小为 8，不一次加载全部图片。
- [x] `kind` 为空表示全部，其他值为 `duplicate`、`single` 或 `unreadable`。
- [x] 切换筛选或翻页前，如当前页选择为脏状态，先保存；保存失败则阻止切换。
- [x] 图片使用后端给出的 `image.url`，预览启用 `loading="lazy"` 与异步解码。
- [x] 展示质量推荐、尺寸、格式、大小、JPEG 质量、细节、噪声及可用的 SSCD/DINO 指标。

### 选择与保存

单组支持“全留”“全不留”“仅推荐”，当前页也提供对应批量操作。保存会提交当前页所有组，
空的 `selected_image_ids` 表示整组不保留：

```http
PUT /api/v1/crawls/{batch_id}/review/decisions
Content-Type: application/json
```

```json
{
  "groups": [
    {
      "group_id": "组 ID",
      "selected_image_ids": ["保留图片 ID"]
    }
  ]
}
```

- [x] 保存成功后将当前页组标记为已确认并清除脏状态。
- [x] 手工点击“保存本页选择”、切换筛选、翻页和应用前均复用同一保存流程。

### 应用

```http
POST /api/v1/crawls/{batch_id}/review/apply
Content-Type: application/json

{}
```

- [x] `ready` 状态应用前先保存当前页，并要求所有人工组均已确认。
- [x] 确认框同时显示严格自动淘汰、最终保留和预计移出数量。
- [x] `apply_failed` 状态使用同一端点重试应用。
- [x] 应用完成后重新读取审核页与批次详情。

## 8. 截图状态（维护者已放弃补录）

阶段 0 检查时，Chromium 与浏览器调试环境可用，但 `127.0.0.1:8787` 没有运行中的后端；
对 `/healthz`、`/ui/` 和 `/ui-next/` 的探测均连接被拒绝。因此本次没有生成或提交截图，
也没有用静态拼图或其他内容伪造运行画面。

以下步骤仅保留为历史方案，不再执行：

1. 使用不含真实凭证、订阅 URL 和私人下载路径的开发配置启动本地后端。
2. 打开 `/ui/`，准备可公开的夹具搜索响应、终态批次与审核数据。
3. 分别记录连接/代理、搜索与授权、来源及 EH 筛选、批次与恢复按钮、任务列表、审核分页与应用确认。
4. 截图前检查页面、原始响应、事件日志和地址栏，移除 Cookie、Token、代理凭据、订阅地址与私人路径。
5. 将经脱敏复核的截图放入 `docs/assets/webui-legacy-baseline/`，并在本节登记文件名、视口、夹具版本和对应流程。

建议文件名（尚未创建）：

```text
01-connection-proxy.png
02-search-auth.png
03-source-eh-filter.png
04-batch-tasks-recovery.png
05-review-pagination-apply.png
```

维护者已明确选择不备份旧界面，因此这些截图不会补录，重写清单中的截图项保持未勾选并标记为
非发布阻塞项。
