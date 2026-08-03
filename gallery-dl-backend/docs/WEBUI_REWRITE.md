# ImageWeave WebUI 桌面化重写开发方案

状态：**方案已确认，待实施**

最后更新：2026-08-02

本文是 ImageWeave WebUI 重写的实施基线。后续开发、评审与验收均以本文为准；如需改变应用边界、部署方式或代理源持久化语义，应先更新本文再改代码。

---

## 1. 背景

当前 WebUI 位于：

```text
gallery-dl-backend/gdl_backend/webui/
├── index.html
├── app.js
└── styles.css
```

它由 FastAPI 同源挂载在 `/ui/`，已经覆盖聚合搜索、站点授权、代理池控制、顺序批次、任务监控、去重分析和人工审核，但所有功能集中在一个长页面与单个 JavaScript 文件中。

仓库根目录的 `blog/` 是本次视觉重写的本地参考代码。需要复用的是其复古桌面视觉语言：

- 像素抖动云背景；
- 桌面快捷方式；
- 仿系统内容窗口；
- START 开始菜单；
- 底部任务栏与时钟；
- 严格双色、2px 实线边框和无模糊硬阴影。

`blog/` 只作为参考，不参与 ImageWeave 构建、打包或运行，并由根 `.gitignore` 整目录忽略。

---

## 2. 已确认的技术决策

### 2.1 部署方式

继续使用 FastAPI 静态托管：

```text
http://127.0.0.1:8787/ui/
```

前端与 API 保持同源，不新增独立前端服务、不引入运行时 Node.js，也不新增 CORS 依赖。

### 2.2 前端技术栈

采用：

- 语义化 HTML；
- 模块化 CSS；
- 原生 ES Modules；
- Hash 路由；
- 浏览器原生 Fetch、History、Storage 与 DOM API。

不把 Astro 博客整体移入后端，不复制 `blog/dist`，不要求最终用户执行前端构建。

### 2.3 桌面交互模型

首期采用“一个桌面壳层、一个前台应用窗口”的模型：

- 每个桌面图标代表一个独立功能应用；
- 点击图标、开始菜单项或跨应用链接时切换前台应用；
- URL 使用 `/ui/#/<app>`，刷新后可以恢复当前应用；
- 应用业务状态保存在中央状态仓库，不依赖窗口 DOM 是否正在显示；
- 暂不实现任意窗口拖拽、自由缩放、多个重叠窗口和桌面图标拖动。

该模型保留桌面隐喻，同时避免为了装饰性多窗口引入不必要的焦点管理、遮挡和移动端复杂度。

### 2.4 桌宠边界

桌宠必须彻底移除，而不是仅默认关闭：

- 不复制 `public/neuro-pet/`；
- 不加载任何桌宠引擎或插件；
- 不保留开场动画；
- 不保留 `PETS.CPL`、角色选择、猫形托盘按钮或桌宠设置；
- 不读取或写入任何 `neuro-pet:*` Storage 键；
- 不保留桌宠主题色跟随逻辑；
- 页面首帧直接显示桌面，不允许先隐藏再揭幕。

### 2.5 已采纳的 UI 风险处理

1. `REVIEW.EXE` 默认最大化，保证图片对比、指标与批量操作有足够空间。
2. 运行状态不依赖多种颜色表达。成功、运行、警告、错误和禁用状态必须同时使用文字、图标、边框或纹理区分，保持双色主题仍可准确识别。

### 2.6 代理源配置

新增专用 API 管理以下三类抓取代理源：

- 订阅 URL；
- 本地节点文件；
- 内联节点。

WebUI 不直接读写完整 `config.json`。API 修改保存到应用管理的运行时覆盖文件，并由用户显式执行“应用并重载”；保存配置本身不得强制终止现有代理租约。

---

## 3. 目标与非目标

### 3.1 本次目标

- 将现有单页 WebUI 重构成复古桌面应用界面；
- 保持现有抓取、授权、代理、批次和审核功能等价；
- 将业务逻辑拆分为可维护的 ES Module；
- 为代理源提供安全、持久、脱敏的 CRUD API；
- 提供站点策略与诊断应用；
- 为尚未开发的功能保留明确的桌面应用占位；
- 保持 `/ui/` 同源部署和本地回环安全边界；
- 保持桌面端、平板和手机端可操作。

### 3.2 本次非目标

- 不新增图片站点或改变来源发现规则；
- 不改变顺序批次、任务调度或代理租约语义；
- 不修改 L0–L2 去重算法、阈值、分组或质量推荐规则；
- 不实现通用图库、定时任务或数据集导出后端；
- 不实现自由拖拽、多窗口重叠或桌面图标布局编辑；
- 不向前端暴露订阅原文、代理凭据、Cookie、Token 或浏览器 Profile 路径；
- 不把 `blog/` 作为源码依赖或发布内容。

---

## 4. 桌面应用划分

### 4.1 应用注册表

| 应用 ID | 桌面名称 | 窗口标题 | 路由 | 首期状态 | 默认窗口 |
| --- | --- | --- | --- | --- | --- |
| `crawl` | 聚合爬图 | `C:\IMAGEWEAVE\CRAWL.EXE` | `#/crawl` | 可用 | 普通 |
| `tasks` | 批次任务 | `C:\IMAGEWEAVE\TASKMGR.EXE` | `#/tasks` | 可用 | 普通 |
| `proxy` | 代理配置 | `C:\IMAGEWEAVE\PROXY.CPL` | `#/proxy` | 可用 | 普通 |
| `vault` | 凭证管理 | `C:\IMAGEWEAVE\VAULT.CPL` | `#/vault` | 可用 | 普通 |
| `review` | 去重审核 | `C:\IMAGEWEAVE\REVIEW.EXE` | `#/review` | 可用 | **最大化** |
| `policy` | 站点策略 | `C:\IMAGEWEAVE\POLICY.CPL` | `#/policy` | 可用 | 普通 |
| `diagnostics` | 系统诊断 | `C:\IMAGEWEAVE\DIAG.EXE` | `#/diagnostics` | 可用 | 普通 |
| `gallery` | 图片库 | `C:\IMAGEWEAVE\GALLERY.EXE` | `#/gallery` | 占位 | 普通 |
| `schedule` | 定时任务 | `C:\IMAGEWEAVE\SCHEDULE.EXE` | `#/schedule` | 占位 | 普通 |
| `export` | 数据集导出 | `C:\IMAGEWEAVE\EXPORT.EXE` | `#/export` | 占位 | 普通 |

应用注册表是桌面图标、开始菜单和路由的唯一数据源，禁止在三处分别维护应用列表。

### 4.2 `CRAWL.EXE`：聚合爬图

职责：

- 输入画师、角色或作品关键词；
- Danbooru autocomplete；
- 选择搜索来源与来源顺序；
- 设置搜索和下载代理模式；
- 展示站内候选、弱证据、关联主页与 EH 标签过滤；
- 选择并调整地址顺序；
- 设置并发、任务上限、输出目录和 EH 下载模式；
- 创建顺序批次。

不再在该应用内嵌完整授权中心或代理池控制面。遇到未授权、代理未启动等前置条件时，显示带明确操作的跨应用提示：

```text
需要 Pixiv 授权  [打开 VAULT.CPL]
代理池尚未运行  [打开 PROXY.CPL]
```

批次创建成功后：

1. 更新中央状态中的 `activeBatchId`；
2. 写入非敏感的 `sessionStorage`；
3. 自动切换到 `TASKMGR.EXE`。

### 4.3 `TASKMGR.EXE`：批次与任务

职责：

- 最近批次选择；
- 当前批次状态、进度和来源/地址顺序；
- 图片任务列表；
- 自动刷新；
- 取消批次；
- 补齐失败下载；
- 重新爬取；
- 错误摘要与界面事件。

终态批次出现审核入口时，提供：

```text
[在 REVIEW.EXE 中打开]
```

任务中的认证错误应链接到 `VAULT.CPL`，代理错误应链接到 `PROXY.CPL`。

### 4.4 `PROXY.CPL`：代理池与代理源

职责分为三块。

#### 运行状态

- 是否启用、是否运行；
- 节点总数、健康数、可重试数和租约数；
- Mihomo 传输核心状态；
- 启动、停止、重载、全池探活；
- 节点列表、协议、标签、延迟和最近错误。

#### 代理源

- 添加、替换和删除订阅 URL；
- 设置或清除本地节点文件；
- 添加、替换和删除内联节点；
- 显示配置来源是 `config` 还是 `runtime`；
- 恢复配置文件默认值；
- 显示“已保存，等待重载”状态。

#### 应用配置

“保存”与“重载”严格分离：

- 保存成功只更新托管配置；
- “应用并重载”调用既有 `POST /api/v1/proxy/reload`；
- 存在代理租约时禁用重载按钮，并显示原因；
- 不提供默认强制停止任务的按钮。

### 4.5 `VAULT.CPL`：凭证管理

职责：

- 展示 Danbooru、X、Pixiv、EH 和 Pawchive 授权状态；
- 启动、轮询和取消共享浏览器授权；
- 删除单站导出凭证；
- 清空共享授权浏览器 Profile；
- 编辑授权专用代理；
- 保持所有敏感值后端托管与脱敏显示。

沿用现有 `/api/v1/auth` API，不改变共享 Chrome Profile 和单站导出凭证的语义。

阶段 4A 使用同一路由的 `?view=vault` 最小响应 profile；默认 `legacy` 响应保持兼容。
后端投影移除完整 Pixiv OAuth URL、原始会话诊断、绝对路径与非必要代理字段，`AuthError`
只保留白名单错误码和受控消息；前端 `vault-model.js` 再做一次纯白名单投影后才允许进入 Store。
“已配置”只证明本地材料或 Token 缓存存在，不等于远端登录验证成功。

不提供后端契约不存在的手工 Cookie/Token、浏览器导入、文件路径导入或“验证登录”按钮。
授权代理是唯一敏感自由文本，只存在于密码控件和提交局部变量；提交、失败、取消、对话框关闭、
最小化、关闭、路由切换和销毁都会清空。普通状态按激活、写后或手动刷新读取；只有活动授权
会话启动一个 800ms、隐藏暂停、请求不重叠的 `vault.authorization` 轮询资源。

### 4.6 `REVIEW.EXE`：去重与人工审核

职责：

- 选择已结束批次；
- 显式启动或重试去重分析；
- 展示严格自动组及淘汰统计；
- 按全部、重复组、独立图片、读取失败筛选；
- 图片预览、质量推荐、尺寸、格式、质量和模型相似度；
- 单组、本页批量保留/不保留/仅推荐；
- 保存分页决策；
- 应用审核结果。

窗口规则：

- 桌面端打开时默认最大化；
- 用户可以恢复普通窗口，但普通窗口最小宽度不得破坏图片比较；
- 手机端始终等价于最大化；
- 保留服务端分页，禁止一次加载全部审核图片；
- 图片使用懒加载，切页前自动保存脏决策或阻止切换。

### 4.7 `POLICY.CPL`：站点策略

使用现有接口：

```text
GET    /api/v1/sites/policies
GET    /api/v1/sites/policies/{site}
PUT    /api/v1/sites/policies/{site}
DELETE /api/v1/sites/policies/{site}
```

支持编辑：

- 最大并发；
- 重试次数与退避；
- 默认代理模式；
- HTTPS 探活地址；
- 使用前探活；
- 节点标签；
- HTTP、任务和无进展超时；
- gallery-dl 重试；
- 已受后端白名单保护的额外参数。

必须明确标识“继承默认值”和“站点覆盖值”，删除覆盖前需要确认。

阶段 4B 使用同一路由的 `?view=policy` 最小响应 profile，默认 `legacy` 响应保持兼容。投影只枚举
Danbooru、X、Pixiv、EH 与 Pawchive，未知站点覆盖只返回计数；绝对路径、URL 凭据/query/fragment、
疑似秘密赋值及不安全旧值不进入响应。POLICY 不管理来源启用/排序，也不迁移 EH 标签
include/exclude；这些仍属于阶段 5 `CRAWL.EXE`。未保存草稿不进入 Store/Storage，配置无轮询；
PUT/DELETE 尝试无论成功或失败都重新 GET 权威值；失败时只恢复 DOM 草稿，若基线已变化则进入
冲突态。后端没有 ETag/revision，前端世代门只处理本页竞态。

### 4.8 `DIAG.EXE`：系统诊断

使用：

```text
GET /healthz
GET /readyz
GET /api/v1/config
GET /api/v1/scheduler/status
```

展示：

- 进程、SQLite、gallery-dl、代理池、Mihomo、去重 Python、Torch 和模型状态；
- CPU/CUDA 实际设备；
- 调度器活动任务与顺序批次摘要；
- 可复制的脱敏诊断摘要；
- Swagger 链接。

诊断应用只读，不提供直接编辑完整配置文件的能力。

### 4.9 占位应用

`GALLERY.EXE`、`SCHEDULE.EXE` 和 `EXPORT.EXE` 首期只打开统一占位窗口：

- 清楚标记“功能开发中”；
- 简述预期职责；
- 不发起不存在的 API 请求；
- 不伪装成可用功能；
- 在图标与开始菜单中使用“占位”状态标记。

---

## 5. 视觉与交互规范

### 5.1 设计令牌

保留参考桌面的核心规则：

```css
:root {
  --hue: 345;
  --accent: oklch(0.55 0.12 var(--hue));
  --surface: #fff;
  --taskbar-height: 40px;
  --border-width: 2px;
  --hard-shadow: 5px 5px 0 var(--accent);
}
```

最终变量命名统一使用 ImageWeave 语义，不继续使用博客中的 `--blue` 命名。

主题首期只保证一个固定默认色相。未来可以增加普通主题设置，但不得重新引入桌宠主题逻辑。

### 5.2 状态语法

严格双色下使用以下组合：

| 状态 | 图标 | 视觉形式 | 文本示例 |
| --- | --- | --- | --- |
| 成功/就绪 | `✓` | 普通实线边框 | `已就绪` |
| 运行中 | `▶` | 反色填充 | `运行中` |
| 等待/警告 | `△` | 斜线纹理 | `等待重载` |
| 错误 | `!` | 双线或加粗边框 | `启动失败` |
| 禁用/占位 | `—` | 点线边框与降低不透明度 | `功能开发中` |

要求：

- 任何状态不得只由颜色区分；
- 状态图标必须有可读文本；
- 动态纹理在 `prefers-reduced-motion: reduce` 下停止动画；
- 错误提示必须包含可操作的下一步，而不只显示原始异常。

### 5.3 桌面壳层

桌面包含：

1. WebGL 抖动云背景与静态 PNG 回退；
2. 桌面应用图标；
3. 一个前台内容窗口；
4. START 开始菜单；
5. 当前应用任务栏按钮；
6. API、代理和去重简要状态；
7. 本地时钟。

不包含桌宠托盘区域。

### 5.4 窗口行为

- 最小化：隐藏内容窗口，保留任务栏应用按钮；
- 恢复：从任务栏恢复；
- 最大化：填满桌面与任务栏之间的可用区域；
- 关闭：关闭当前前台窗口并回到纯桌面，业务状态不清空；
- 切换应用：更新 Hash、标题栏、任务栏和正文；
- `Escape`：关闭开始菜单或当前弹出层，不直接丢弃表单；
- 路由切换前若存在未保存审核选择，先保存或请求确认。

### 5.5 响应式

沿用三个布局区间：

- `>= 1008px`：标准桌面；
- `768px–1007px`：桌面图标在左，窗口占据剩余宽度；
- `< 768px`：图标顶部网格，应用窗口占据余下屏幕。

移动端要求：

- 点击目标不小于 44×44 CSS px；
- 表格可以切换为卡片或横向滚动，不压缩到不可读；
- 审核图片网格最小卡片宽度约 150px；
- 任务栏尊重安全区；
- 内容窗口内部独立滚动，页面本身不产生双滚动条。

### 5.6 云背景性能

- WebGL 初始化失败时立即使用静态回退图；
- 页面隐藏时停止 `requestAnimationFrame`；
- 减少动态偏好下只渲染静态帧；
- WebGL context lost 后不循环重试；
- 云背景永远不拦截鼠标或触摸事件。

---

## 6. 前端技术架构

### 6.1 目标目录结构

```text
gallery-dl-backend/gdl_backend/webui/
├── index.html
├── assets/
│   └── dithered-cloud-fallback.png
├── styles/
│   ├── tokens.css
│   ├── base.css
│   ├── desktop.css
│   ├── controls.css
│   ├── status.css
│   ├── responsive.css
│   └── apps/
│       ├── crawl.css
│       ├── tasks.css
│       ├── proxy.css
│       ├── vault.css
│       ├── review.css
│       ├── policy.css
│       └── diagnostics.css
└── js/
    ├── main.js
    ├── core/
    │   ├── api.js
    │   ├── router.js
    │   ├── store.js
    │   ├── app-registry.js
    │   ├── desktop.js
    │   ├── window-manager.js
    │   ├── polling.js
    │   ├── storage.js
    │   └── dom.js
    ├── components/
    │   ├── cloud-background.js
    │   ├── icons.js
    │   ├── status.js
    │   ├── dialog.js
    │   └── empty-state.js
    └── apps/
        ├── crawl.js
        ├── tasks.js
        ├── proxy.js
        ├── vault.js
        ├── review.js
        ├── policy.js
        ├── diagnostics.js
        └── placeholder.js
```

禁止重新形成单个数千行 `app.js`。应用模块只操作自己的根节点，共享行为必须进入 `core/` 或 `components/`。

### 6.2 应用接口

应用注册项至少包含：

```js
{
  id: "review",
  label: "去重审核",
  icon: "images",
  route: "/review",
  windowTitle: "C:\\IMAGEWEAVE\\REVIEW.EXE",
  availability: "ready",
  defaultWindowState: "maximized",
  mount(context) {},
  activate(context) {},
  deactivate(context) {},
  unmount(context) {},
}
```

约束：

- `mount()` 只能执行一次性 DOM 和事件初始化；
- `activate()` 开启本应用需要的刷新；
- `deactivate()` 停止非必要刷新，但不得清空中央状态；
- `unmount()` 只用于完整销毁或测试；
- 应用之间通过 store action 或 router 导航协作，不直接查询其他应用 DOM。

### 6.3 Hash 路由

合法路由：

```text
#/crawl
#/tasks
#/proxy
#/vault
#/review
#/policy
#/diagnostics
#/gallery
#/schedule
#/export
```

规则：

- `/ui/` 或未知 Hash 默认进入 `#/crawl`；
- 路由切换更新当前应用、窗口标题和页面 `<title>`；
- 路由不得包含凭证、订阅 URL、Cookie、输出绝对路径等敏感参数；
- 批次 ID 优先保存在中央状态和 `sessionStorage`，需要深链接时只允许使用后端生成的批次 ID。

### 6.4 中央状态

建议状态形状：

```js
{
  system: {
    health: null,
    readiness: null,
    apiConnected: false,
  },
  proxy: {
    status: null,
    sources: null,
  },
  auth: {
    bySite: new Map(),
    authorizationProxy: null,
  },
  crawl: {
    searchResponse: null,
    sources: [],
    ehTagFilter: new Map(),
  },
  batches: {
    activeId: "",
    active: null,
    tasks: [],
    recent: [],
  },
  review: {
    batchId: "",
    summary: null,
    groups: [],
    filter: "",
    offset: 0,
    dirty: false,
  },
  ui: {
    activeApp: "crawl",
    windowState: "normal",
    startMenuOpen: false,
  },
}
```

状态修改通过显式 action 完成。渲染函数不在读取时偷偷修改业务状态。

### 6.5 API 客户端

`core/api.js` 统一负责：

- JSON 请求与响应；
- `cache: "no-store"`；
- HTTP 错误归一化；
- 提取 `error.code`、`error.message`、`error.details` 和 `request_id`；
- AbortController；
- 幂等键；
- 只在必要时序列化请求体。

应用模块不得各自复制 Fetch 错误处理。

### 6.6 轮询管理

所有轮询由 `core/polling.js` 注册并可见化管理：

- 浏览器授权会话：沿用约 800ms 的活动会话轮询；
- 活动批次：沿用约 1500ms 的运行期轮询；
- 去重分析：仅在非稳定状态轮询；
- API/代理摘要：使用低频轮询或用户主动刷新；
- 页面隐藏时暂停非关键轮询；
- 应用切换时停止仅服务于已离开页面的轮询；
- 同一资源不允许出现多个并发轮询器。

### 6.7 浏览器存储

允许保存：

- 当前应用 ID；
- 当前批次 ID；
- 窗口最大化状态；
- 非敏感 UI 偏好。

禁止保存：

- 订阅 URL；
- 内联节点原文；
- 代理用户名或密码；
- Cookie、Token 或 OAuth 回调；
- 浏览器 Profile 路径；
- 未脱敏 API 原始响应。

---

## 7. 现有 API 复用

| 能力 | API | 应用 |
| --- | --- | --- |
| 健康与就绪 | `/healthz`、`/readyz` | `DIAG.EXE`、任务栏 |
| 公共配置 | `GET /api/v1/config` | `DIAG.EXE` |
| 代理状态与控制 | `/api/v1/proxy/status|start|reload|probe|stop` | `PROXY.CPL` |
| 凭证与授权代理 | `/api/v1/auth...` | `VAULT.CPL` |
| 搜索与补全 | `/api/v1/search`、`/api/v1/search/autocomplete` | `CRAWL.EXE` |
| 顺序批次 | `/api/v1/crawls...` | `CRAWL.EXE`、`TASKMGR.EXE` |
| 去重审核 | `/api/v1/crawls/{id}/review...` | `REVIEW.EXE` |
| 任务详情 | `/api/v1/tasks...` | `TASKMGR.EXE` |
| 站点策略 | `/api/v1/sites/policies...` | `POLICY.CPL` |
| 调度摘要 | `/api/v1/scheduler/status` | `DIAG.EXE` |

现有 API 的业务语义保持不变。前端拆分不是后端状态机重写。

---

## 8. 新增代理源管理 API

### 8.1 持久化模型

新增后端组件 `ManagedProxySourceStore`，建议文件：

```text
gdl_backend/proxy_source_store.py
```

运行时覆盖文件：

```text
runtime/proxy/managed-sources.json
```

要求：

- 目录权限 `0700`；
- 文件权限 `0600`；
- 使用 `write_private_text()` 写同目录临时文件后原子替换；
- 拒绝管理路径中的符号链接；
- JSON 顶层带 `version`；
- 写入完整快照，禁止多文件半更新；
- 文件损坏时不静默使用半份数据，应记录脱敏错误并回退到 `config.json` 基线。

建议结构：

```json
{
  "version": 1,
  "updated_at": 0,
  "subscription_urls": [],
  "node_file": null,
  "inline_nodes": []
}
```

完整值只存在后端内存和私有文件中，不进入 API 响应。

### 8.2 配置优先级

```text
runtime/proxy/managed-sources.json
    > config.json 的 proxy.subscription_urls / node_file / inline_nodes
    > 空配置
```

语义：

- 没有运行时覆盖文件时使用 `config.json`；
- 第一次通过 API 修改时，以当前有效配置为基线生成完整运行时快照；
- 后续 API 修改只更新运行时快照；
- “恢复配置文件默认”删除运行时覆盖文件；
- 当运行时覆盖存在时，外部手改 `config.json` 不会改变有效代理源，直到用户恢复默认。

### 8.3 生效与重载

代理源存储维护 `configured_revision`，正在运行的代理池维护 `active_revision`：

```text
reload_required = configured_revision != active_revision
```

保存代理源后：

- 新配置立即成为下次启动/重载的输入；
- 当前已运行节点和租约保持不变；
- API 返回 `reload_required=true`；
- 用户调用现有 `/proxy/reload` 后才切换运行池；
- 有活动租约时 `/proxy/reload` 继续返回冲突，不自动强制停止；
- 重载成功后更新 `active_revision`。

`ProxyPoolAdapter` 需要改为在每次 `start()`/`reload()` 时读取不可变的最新代理源快照，而不是永久直接读取启动时的三个 `ProxySettings` 字段。

### 8.4 脱敏规则

#### 订阅 URL

API 只返回：

- opaque ID；
- scheme；
- hostname；
- 脱敏展示值，例如 `https://example.com/…`；
- 是否包含凭据或敏感路径；
- 来源是 `config` 还是 `runtime`。

不得返回路径、查询参数、fragment、用户名或密码。

#### 内联节点

API 只返回：

- opaque ID；
- 协议；
- 节点名称；
- 主机与端口；
- 是否需要传输核心；
- 脱敏展示值，例如 `vless://***@host:443#JP-01`。

不得返回 UUID、密码、用户信息、查询参数、插件参数或完整原文。

#### 节点文件

API 返回允许展示的项目相对路径或文件名，不返回无必要的主机绝对路径。

### 8.5 节点文件许可范围

新增配置字段：

```json
{
  "proxy": {
    "allowed_node_roots": ["../subscriptions"]
  }
}
```

API 设置的节点文件必须：

- 位于 `allowed_node_roots` 内；
- 是普通文件；
- 不经过符号链接；
- 大小不超过现有订阅解析上限；
- 能被 `parse_subscription_text()` 读取；
- 至少解析出一个支持或可交给传输核心的节点。

`config.json` 中既有的 `node_file` 仍按原启动语义加载；许可范围主要约束新的 WebUI 写接口。

### 8.6 API 端点

#### 获取有效代理源

```http
GET /api/v1/proxy/sources
```

示例响应：

```json
{
  "source": "runtime",
  "has_runtime_override": true,
  "runtime_override_valid": true,
  "configured_revision": "8c9f0c2d7a5b0000000000000000000000000000000000000000000000000000",
  "active_revision": "2d1a07e949bc0000000000000000000000000000000000000000000000000000",
  "reload_required": true,
  "subscriptions": [
    {
      "id": "sub_5c3f6b7a00000000000000000000000000000000000000000000000000000000",
      "source": "runtime",
      "scheme": "https",
      "host": "example.com",
      "port": null,
      "display_url": "https://example.com/…",
      "credentials_redacted": true,
      "sensitive_parts_redacted": true
    }
  ],
  "node_file": {
    "configured": true,
    "source": "runtime",
    "display_path": "subscriptions/provider.yaml"
  },
  "inline_nodes": [
    {
      "id": "node_59c203a100000000000000000000000000000000000000000000000000000000",
      "source": "runtime",
      "scheme": "vless",
      "name": "JP-01",
      "host": "proxy.example",
      "port": 443,
      "requires_transport_core": true,
      "display_endpoint": "vless://***@proxy.example:443#JP-01"
    }
  ],
  "counts": {
    "subscriptions": 1,
    "node_file": 1,
    "inline_nodes": 1,
    "total": 3
  }
}
```

阶段 3A 的稳定后端契约补充如下：

- `configured_revision` 与非空 `active_revision` 是 64 位小写十六进制 SHA-256；首次从未成功启动时 `active_revision=null`；停止后保留最近一次成功值，失败的 start/reload 不更新；
- 订阅 ID 固定为 `sub_` 加 64 位摘要，内联节点 ID 固定为 `node_` 加 64 位摘要；两者均基于规范化完整秘密值且不截断；
- 顶层额外返回 `runtime_override_valid`；损坏覆盖安全回退时其为 `false`，同时 `has_runtime_override=true`；
- 每个订阅和内联节点条目包含 `source`；订阅额外包含安全的显式 `port` 与 `sensitive_parts_redacted`；
- `node_file` 始终是 `{configured, source, display_path}` 对象；`counts` 固定包含 `subscriptions`、`node_file`、`inline_nodes` 与 `total`；
- 所有变更接口均返回同形脱敏快照，保存本身不调用 start、stop 或 reload。

#### 添加订阅

```http
POST /api/v1/proxy/sources/subscriptions
Content-Type: application/json

{"url": "https://provider.example/sub/SECRET"}
```

#### 替换订阅

```http
PUT /api/v1/proxy/sources/subscriptions/{source_id}
Content-Type: application/json

{"url": "https://provider.example/sub/NEW_SECRET"}
```

#### 删除订阅

```http
DELETE /api/v1/proxy/sources/subscriptions/{source_id}
```

#### 设置节点文件

```http
PUT /api/v1/proxy/sources/node-file
Content-Type: application/json

{"path": "../subscriptions/provider.yaml"}
```

#### 清除节点文件

```http
DELETE /api/v1/proxy/sources/node-file
```

#### 批量添加内联节点

```http
POST /api/v1/proxy/sources/inline-nodes
Content-Type: application/json

{
  "nodes": [
    "http://127.0.0.1:7890#local",
    "vless://UUID@example.com:443?...#JP-01"
  ]
}
```

请求失败时只返回出错索引与脱敏原因，不回显节点原文。

#### 替换内联节点

```http
PUT /api/v1/proxy/sources/inline-nodes/{source_id}
Content-Type: application/json

{"node": "socks5://127.0.0.1:1080#local"}
```

#### 删除内联节点

```http
DELETE /api/v1/proxy/sources/inline-nodes/{source_id}
```

#### 恢复 `config.json` 默认

```http
DELETE /api/v1/proxy/sources/override
```

所有变更接口返回与 `GET /proxy/sources` 相同的脱敏快照，不回显刚提交的秘密。

### 8.7 请求模型与校验

新增 Pydantic 模型，全部使用：

```python
model_config = ConfigDict(extra="forbid")
```

最低校验：

- 订阅只接受带主机的 `http://` 或 `https://`；
- URL 长度、节点数量、单节点长度和总请求体有上限；
- 空白与重复项规范化；
- 内联节点复用 `parse_proxy_line()` / `parse_subscription_text()`；
- 不接受解析后完全为空的更新；
- source ID 格式固定且长度有限；
- 路径越界、符号链接和非普通文件返回 422；
- 找不到 source ID 返回 404；
- 存储写入冲突或损坏返回结构化错误；
- 所有错误消息经过脱敏。

建议错误码：

```text
invalid_proxy_subscription
invalid_proxy_inline_node
invalid_proxy_node_file
invalid_proxy_source_id
proxy_source_not_found
proxy_source_path_forbidden
proxy_sources_request_too_large
proxy_sources_store_error
```

### 8.8 并发模型

`ManagedProxySourceStore` 使用独立锁串行化：

1. 读取当前有效快照；
2. 应用单次变更；
3. 完整校验；
4. 原子写入；
5. 发布新 revision。

不得在多个路由中直接修改 `container.settings.proxy.subscription_urls` 等可变列表。

---

## 9. 迁移策略

### 阶段 0：基线与隔离

- [x] 确认桌面应用边界；
- [x] 确认原生 ES Modules 与 FastAPI 同源部署；
- [x] 确认彻底移除桌宠与开场动画；
- [x] 根 `.gitignore` 忽略 `/blog/`；
- [x] 记录旧 WebUI 关键流程与 API 请求基线（见 [`WEBUI_LEGACY_BASELINE.md`](./WEBUI_LEGACY_BASELINE.md)）；
- [ ] 补充旧 WebUI 关键流程截图（维护者已明确放弃备份与人工视觉留档，不作为发布阻塞项）；
- [x] 为重写建立独立的 `/ui-next/` 开发挂载，旧 `/ui/` 暂时保留。

### 阶段 1：桌面壳层

- [x] 建立新目录结构与 ES Module 入口；
- [x] 移植并重命名设计令牌；
- [x] 移植 WebGL 云背景与静态回退；
- [x] 完成应用注册表、Hash 路由、窗口管理、开始菜单、任务栏和时钟；
- [x] 创建全部真实应用与占位应用空壳；
- [x] 确认不存在桌宠脚本、素材、Storage 或开场隐藏逻辑；
- [x] 完成三档响应式布局。

### 阶段 2：共享基础设施

- [x] 实现统一 API 客户端；
- [x] 实现中央状态仓库；
- [x] 实现轮询注册与取消；
- [x] 实现统一状态徽标、对话框、错误提示和空状态；
- [x] 实现任务栏 API/代理/去重摘要；
- [x] 实现跨应用导航 action。

### 阶段 3：代理源后端与 `PROXY.CPL`

- [x] 新增 `ManagedProxySourceStore`；
- [x] 新增私有运行时覆盖文件；
- [x] 新增代理源请求模型和 API；
- [x] 改造 `ProxyPoolAdapter` 使用最新快照与 revision；
- [x] 实现脱敏列表、增删改、恢复默认与等待重载状态；
- [x] 实现运行状态、节点表、启动/停止/重载/探活；
- [x] 完成持久化、脱敏、路径与租约冲突测试。

### 阶段 4：配置类应用

- [x] 迁移 `VAULT.CPL`；
- [x] 实现 `POLICY.CPL`；
- [x] 实现 `DIAG.EXE`；
- [x] 验证共享浏览器授权轮询不会因应用切换重复启动；
- [x] 验证任何 UI 状态与日志不含凭证。

阶段 4A 已完成 VAULT 模块、后端安全投影、秘密生命周期和共享授权轮询验收。阶段 4B 已完成
POLICY 的五来源安全投影、站点策略编辑、SQLite 覆盖/reset、草稿生命周期与无轮询验收。
DIAG.EXE 现已使用 diagnostics 最小投影接入健康、就绪、配置能力和调度摘要；配置阶段的 Store、
DOM、Storage、URL、日志与浏览器错误路径已完成集中脱敏复核。来源勾选/排序、每请求路由及 EH
标签 include/exclude 按本方案归阶段 5 的 CRAWL.EXE，并已完成迁移。

### 阶段 5：抓取工作流

- [x] 迁移搜索、补全、来源选择和 EH 标签过滤到 `CRAWL.EXE`；
- [x] 迁移顺序提交配置；
- [x] 迁移最近批次、进度、任务表和重试操作到 `TASKMGR.EXE`；
- [x] 实现创建批次后自动打开任务管理器；
- [x] 实现认证与代理错误的跨应用修复入口；
- [x] 对比旧 UI 请求载荷，确保字段和顺序等价。

### 阶段 6：去重审核

- [x] 将审核状态从任务页面解耦到 `REVIEW.EXE`；
- [x] 实现终态批次选择；
- [x] 迁移分析、分页、筛选、图片选择、保存和应用；
- [x] 默认最大化；
- [x] 保留图片懒加载与分页；
- [x] 验证脏决策切页保护；
- [x] 验证移动端图片比较可用。

### 阶段 7：切换与清理

- [x] 完成旧/新 UI 功能对照验收；
- [x] 将新 UI 切换到 `/ui/`；
- [x] 删除临时 `/ui-next/` 挂载；
- [x] 删除旧单页 HTML/CSS/JS；
- [x] 更新静态资源 API 测试和 README；
- [x] 运行完整后端、根去重与浏览器验收；
- [x] 确认后端安装和启动流程不需要 Node.js。

阶段 7 已由维护者确认执行不可逆切换：模块化桌面 WebUI 现从正式 `/ui/` 入口提供，临时
`/ui-next/` 挂载已移除，旧单页 `index.html`、`app.js` 与 `styles.css` 已删除且不保留兼容副本。
阶段 0 的旧界面截图由维护者明确放弃，不作为发布阻塞项；功能与请求基线仍保留为历史文档。

切换前的可执行验收已完成：前端模型套件 48 项与后端 276 项通过；根去重共 32 项，其中 31 项通过、
真实私有样本 1 项按设计跳过；`doctor.sh` 为 ready；1440px/320px 浏览器烟雾覆盖七个主应用、三个占位入口、
搜索建批、活动批次轮询/取消、审核脏页保存/应用与 DIAG 离线旧快照。正式切换后的静态契约继续验证
`/ui/` 包含全部 59 个模块化资源，`/ui-next/` 与旧平面 `app.js/styles.css` 均返回 404；wheel 仅打包
正式 WebUI 资源。

---

## 10. 旧功能迁移对照

| 旧 WebUI 区域 | 新归属 | 要求 |
| --- | --- | --- |
| 后端与代理池 | `PROXY.CPL`、任务栏 | 功能等价并新增代理源编辑 |
| 聚合关键词搜索 | `CRAWL.EXE` | 请求载荷等价 |
| 站点登录授权 | `VAULT.CPL` | 授权状态和轮询等价 |
| 来源路由覆盖 | `CRAWL.EXE` | 保留 |
| 搜索候选与 EH 标签过滤 | `CRAWL.EXE` | 保留顺序和选择状态 |
| 顺序批次提交 | `CRAWL.EXE` | 保留幂等键 |
| 最近批次与运行监控 | `TASKMGR.EXE` | 保留自动刷新 |
| 去重与质量审核 | `REVIEW.EXE` | 独立并默认最大化 |
| 图片任务表 | `TASKMGR.EXE` | 保留显示上限说明 |
| 界面事件 | `TASKMGR.EXE`，必要时全局通知 | 不记录秘密 |
| 原始 API 响应 | `DIAG.EXE` 或开发模式 | 默认不展示敏感大对象 |

禁止因为拆分页面而删除旧 UI 已有的失败恢复、认证提示、弱证据、EH 标签筛选、预去重统计或审核分页能力。

---

## 11. 测试计划

### 11.1 后端 API 测试

新增或扩展 `tests/test_api.py`、代理源专用测试：

- GET 返回 config/runtime/none 正确来源；
- 第一次修改从有效配置建立完整覆盖；
- 添加、替换、删除订阅；
- 设置、清除节点文件；
- 添加、替换、删除内联节点；
- 恢复配置默认；
- 服务重启后覆盖仍存在；
- 覆盖文件损坏时安全回退；
- 所有响应不含订阅 path/query、代理密码、UUID 或节点原文；
- 私有文件权限和原子替换；
- 路径越界、符号链接、超大文件和无效格式被拒绝；
- 保存配置不终止活动租约；
- 有租约时重载仍返回冲突；
- 重载成功后 `reload_required=false`。

### 11.2 前端模块测试

优先把下列纯逻辑写成无 DOM 函数：

- Hash 路由解析；
- 状态名称和状态样式映射；
- EH 标签解析与过滤；
- 来源和地址顺序移动；
- 爬取请求载荷构造；
- 脱敏代理源视图模型；
- 审核分页和选择 payload 构造。

### 11.3 浏览器端到端测试

最低覆盖：

1. 打开 `/ui/`，首帧直接显示桌面；
2. 桌面图标、开始菜单和 Hash 路由一致；
3. 最小化、恢复、最大化和关闭窗口；
4. `REVIEW.EXE` 默认最大化；
5. 占位应用不请求不存在的 API；
6. 搜索、选择、排序并创建批次；
7. 批次自动刷新、取消、重试和重新爬取；
8. 授权启动、轮询和取消；
9. 代理源增删改、等待重载和应用重载；
10. 审核分页、保存和应用；
11. 320px、768px、1440px 三种视口可操作；
12. 键盘可以打开应用、开始菜单和主要操作；
13. `prefers-reduced-motion` 下无持续背景动画；
14. 网络请求中不存在 `/neuro-pet/`。

### 11.4 回归命令

至少执行：

```bash
(cd gallery-dl-backend && .venv/bin/python -m unittest discover -s tests -v)
.venv/bin/python -m unittest discover -s tests -v
./scripts/doctor.sh
```

按环境能力执行浏览器 E2E；模型或真实站点测试仍遵循现有分层，不纳入每次前端快速迭代。

---

## 12. 验收标准

### 12.1 功能

- [x] 七个首期应用均可从桌面和开始菜单进入；
- [x] 三个占位应用明确标记且不伪造功能；
- [x] 旧 WebUI 的搜索、授权、爬取、批次、代理和审核能力无回归；
- [x] 站点策略和系统诊断具备独立应用；
- [x] 代理 URL、节点文件和内联节点可通过 API 管理；
- [x] 代理源修改持久化且必须显式重载才切换运行池；
- [x] 有活动租约时不会被配置保存强制中断。

### 12.2 视觉与交互

- [x] 桌面、云背景、窗口、开始菜单和任务栏形成统一复古视觉；
- [x] 所有状态具有文字、图标和非颜色视觉差异；
- [x] `REVIEW.EXE` 默认最大化；
- [x] 桌面、平板和手机可操作；
- [x] 减少动态偏好有效；
- [x] 键盘焦点清晰且不会困在隐藏应用中。

### 12.3 桌宠清除

- [x] WebUI 目录没有桌宠素材；
- [x] HTML/JS/CSS 不包含桌宠引擎、插件、设置面板或开场动画；
- [x] 不存在 `neuro-pet:*` Storage 访问；
- [x] 浏览器不会请求 `/neuro-pet/`；
- [x] 首帧没有开场预隐藏。

可使用：

```bash
rg -n "neuro-pet|NeuroPet|PETS\.CPL|__neuroIntroPlay" \
  gallery-dl-backend/gdl_backend/webui
```

预期无结果。

### 12.4 安全与部署

- [x] API 响应、DOM、Storage 和界面日志不包含代理或授权秘密；
- [x] 代理源覆盖文件使用私有权限与原子写入；
- [x] FastAPI 仍只需托管静态文件；
- [x] 正式安装与运行不依赖 Node.js；
- [x] `/ui/` 与 `/api/v1` 保持同源；
- [x] `blog/` 不被 Git 跟踪、不参与构建或发布。

---

## 13. 预计改动文件

后端：

```text
gallery-dl-backend/gdl_backend/app.py
gallery-dl-backend/gdl_backend/config.py
gallery-dl-backend/gdl_backend/proxy.py
gallery-dl-backend/gdl_backend/proxy_source_store.py   # 新增
gallery-dl-backend/gdl_backend/schemas.py
gallery-dl-backend/tests/test_api.py
gallery-dl-backend/tests/test_proxy_sources.py         # 新增或扩展
```

前端：

```text
gallery-dl-backend/gdl_backend/webui/index.html
gallery-dl-backend/gdl_backend/webui/assets/
gallery-dl-backend/gdl_backend/webui/styles/
gallery-dl-backend/gdl_backend/webui/js/
```

文档：

```text
README.md
gallery-dl-backend/README.md
gallery-dl-backend/docs/ARCHITECTURE.md
gallery-dl-backend/docs/WEBUI_REWRITE.md
```

最终以实际实现为准，但新增功能不得绕过本文定义的模块边界、代理源持久化优先级和脱敏要求。
