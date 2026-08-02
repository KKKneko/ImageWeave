# gallery-dl 独立代理池后端

这是一个 FastAPI 后端，用于统一搜索图库地址、按选择顺序建立图片任务，并通过独立
代理租约运行 gallery-dl：

- `../gallery-dl-codeberg` 保持为上游 Git submodule，源码树不做任何本地修改，
  并始终通过独立子进程调用；后端需要的两处行为差异（跨尝试稳定的 `.part` 命名、
  EH 卡死检测心跳）由 `gdl_backend/worker_patches.py` 在 worker 进程内以运行时
  补丁实现，上游接口变化时补丁自动跳过并在任务日志输出 `[gdl-backend-patch]` 告警；
- `gdl_backend/` 负责搜索、规划、调度、授权、代理池和状态持久化；
- `/ui/` 提供随后端打包的静态操作界面，无需单独构建前端。

## 平台支持

| 平台/设备 | 支持等级 | 说明 |
| --- | --- | --- |
| Linux x86_64 / CPU | 必测支持 | P1 真实验收：Arch Linux、Python 3.14、无 NVIDIA GPU；快速 CI 为 Ubuntu 24.04。 |
| Windows x86_64 / CPU 或 CUDA | 兼容维护 | PowerShell 路径和通用锁保留；本次 P1 未在 Windows 实机运行。 |
| Linux x86_64 / CUDA 12.8 | 兼容维护 | 有独立完整锁，但本次无 NVIDIA 硬件，未验证驱动、运行时或性能。 |
| macOS、Linux ARM、其他加速器 | 未验证 | 不属于当前发布门槛，不作可用性承诺。 |

| Python | 状态 | 说明 |
| --- | --- | --- |
| 3.11 | 最低支持 / CI | `numpy==2.4.2` 已不支持 3.10，因此最低版本如实上调。 |
| 3.14 | 推荐 / CI / 实测 | 当前 Arch 验收和推荐生产版本。 |
| 3.12–3.13 | 锁可解析 | 不为每个微版本扩张 CI 矩阵。 |
| < 3.11 或 >= 3.15 | 不支持 | setup 会提前退出；放开前必须重新验锁。 |

CPU-only 是 Linux 发布门槛；CUDA 及 ARM 不会因存在代码路径而被隐式视为已验证。站点授权需要
桌面环境中的 Chrome、Chromium 或 Chromium Browser。非标准路径通过
`auth.chrome_executable` 配置。doctor 检测到浏览器不等于服务器具备桌面会话；纯 SSH/headless
环境可以运行 API、下载调度和 CPU 去重，但不能完成需要可见窗口的 X/Pixiv/EH 授权。

X、Pixiv、EH 登录授权可通过 `auth.authorization_proxy`（或授权面板中的「授权专用代理」
输入框，运行时设置优先并持久化）指定一个独立代理，例如 `http://127.0.0.1:7890`；
共享授权 Chrome 的页面流量与 Pixiv token 交换全程经该代理，与抓取用的代理池互不影响，
留空则直连。支持 http/https/socks4/socks5/socks5h，地址需带显式端口。授权会话结束后
共享浏览器窗口自动关闭，登录状态保留在项目 Profile，下次授权自动重新拉起。

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
- 支持任务取消、失败重试、重启恢复、文件清单和幂等提交。
- 聚合批次结束后可独立启动 L0-L2 去重；严格自动组先淘汰，剩余图片进入分组人工审核。

具体进程边界、状态机、搜索证据规则和代理选择算法见
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## Linux CPU（无 GPU）快速开始

从仓库根目录运行统一安装器，而不是分别手工创建环境。以下代理地址只是当前主机示例，可改用
环境变量中的其他地址；`--no-proxy` 可明确关闭安装下载代理：

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export http_proxy="$HTTP_PROXY"
export https_proxy="$HTTPS_PROXY"
export NO_PROXY=127.0.0.1,localhost
export no_proxy="$NO_PROXY"

./scripts/setup-linux.sh --device cpu --proxy http://127.0.0.1:7890
./scripts/doctor.sh
./scripts/run.sh
```

安装器不会执行 `sudo`；要求 Linux x86_64 与 Python 3.11–3.14，缺少 venv、git、
curl/wget、gzip 或 SHA-256 工具时，会分别给出 Debian/Ubuntu 与 Arch Linux 安装提示。它幂等初始化 submodule、创建
`gallery-dl-backend/.venv`（后端）和根 `.venv`（去重），安装官方 CPU PyTorch 与
`opencv-python-headless`、校验 Mihomo v1.19.28，并把 SSCD/DINOv2 缓存到根 `.models`。
`--skip-models`、`--skip-mihomo` 等选项用于快速重跑；已有 config、模型缓存和运行数据不会被
覆盖。新建 config 为 0600，runtime/credentials 等敏感目录为 0700。

`pyproject.toml` 是后端、去重公共、CPU 和 CUDA **直接依赖的唯一事实来源**。生成的
`requirements.txt`、根目录 `requirements-dedup-common.txt`、`requirements-dedup-cpu.txt`、
`requirements-dedup-cuda.txt` 分别固定完整传递闭包与哈希；CPU/CUDA 文件各自是一份可直接
安装的完整环境锁，不需要先叠加 common。CPU 锁不含 CUDA、`nvidia-*`、Triton 或普通 OpenCV。
维护命令：

```bash
./scripts/lock-dependencies.sh --upgrade  # 固定 uv 0.12.1，显式更新锁
./scripts/lock-dependencies.sh --check    # 复算现有版本并检查漂移
```

普通 `setup-linux.sh` 只消费锁，不自动升级依赖解析结果。安装脚本固定下载并校验受支持的
Mihomo 版本；单独安装时也支持：

```bash
bash gallery-dl-backend/scripts/install_mihomo.sh --proxy http://127.0.0.1:7890
# 或明确直连：--no-proxy
```

自定义目录、强制重装及手动安装见 [`docs/MIHOMO.md`](./docs/MIHOMO.md)。Windows PowerShell
仍使用 `scripts/install_mihomo.ps1` 和根 `setup-dedup.ps1`；后者同样消费 CUDA 完整哈希锁，
但本次只做兼容性维护，未实机验证。

### CPU 去重资源 profile

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
默认禁用，避免在没有节点源、根 venv 或模型时静默进入半可用状态；统一 Linux CPU 安装器会
准备模型并只启用去重。直连抓取可以保持 `proxy.enabled=false`；需要抓取代理池时再显式启用并
配置订阅、`proxy.node_file` 或 `inline_nodes`：

```json
{
  "proxy": {
    "enabled": true,
    "auto_start": true,
    "subscription_urls": ["https://SUBSCRIPTION_URL"],
    "transport_core_enabled": true
  }
}
```

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

Windows 可运行 `run_backend.ps1`，也可以直接执行：

```powershell
python -m gdl_backend --config .\config.json
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

服务只允许绑定回环地址。任务和探活目标默认拒绝回环、私网、链路本地及保留 IP；本地部署
确需访问局域网图站时，在 `server` 配置中设置 `"allow_private_targets": true`。

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

1. 查看代理池状态，按需启动、重载或探活。
2. 在“站点登录授权”中完成所需站点登录。
3. 输入关键词搜索来源，核对候选和弱证据，并调整来源/地址顺序。
4. 设置单地址图片并发数，提交批次并查看地址与图片任务状态。
5. 批次结束后按需启动去重，再审核剩余重复组与独立图片，保存选择并应用整理结果。

界面直接调用下述 API；搜索归并、执行顺序、代理租约和任务状态均以后端数据库为准。

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

## API 概览

请求和响应模型以运行中的 [Swagger](http://127.0.0.1:8787/docs) 为准。主要端点：

```text
GET  /api/v1/proxy/status
POST /api/v1/proxy/start
POST /api/v1/proxy/reload
POST /api/v1/proxy/probe
POST /api/v1/proxy/stop

GET    /api/v1/auth
GET    /api/v1/auth/{site}
POST   /api/v1/auth/{site}/login/start
GET    /api/v1/auth/{site}/login/{session_id}
DELETE /api/v1/auth/{site}/login/{session_id}
DELETE /api/v1/auth/{site}

GET  /api/v1/search/sites
POST /api/v1/search

POST /api/v1/crawls
GET  /api/v1/crawls
GET  /api/v1/crawls/{batch_id}
GET  /api/v1/crawls/{batch_id}/tasks
POST /api/v1/crawls/{batch_id}/cancel
POST /api/v1/crawls/{batch_id}/retry
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

PUT /api/v1/sites/policies/{site}
```

Pixiv OAuth 和共享 Profile 清理另有专用授权端点，可直接从 Swagger 或 WebUI 调用。

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
降级为 1280 查看图。WebUI 默认提交 `original + stop`。EH 图片任务还使用
`download_stall_timeout_seconds` 作为单进程无进展保护，超时会结束当前尝试并按任务的
`max_attempts` 自动换代理重试；已存在的完整文件仍由 gallery-dl 跳过。
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

站点策略可配置并发、重试、探活地址、节点标签和任务超时。完整字段由
`PUT /api/v1/sites/policies/{site}` 的 Swagger 模型定义。

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
