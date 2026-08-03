# ImageWeave

ImageWeave 是面向插画与图库采集的本地 Web 应用，将跨站来源发现、gallery-dl 批次调度、
订阅代理池、站点授权和 L0–L2 图片去重整合到同一工作流中。

## 主要功能

- 聚合 Danbooru、E-Hentai/ExHentai、Pawchive、X 和 Pixiv 来源；
- 按来源与地址顺序执行批次，支持失败重试、断点续传和重启恢复；
- 导入 HTTP、SOCKS 及常见 Clash 订阅，并通过 Mihomo 承载隧道节点；
- 托管 X、Pixiv、EH 授权，授权代理与抓取代理池相互独立；
- 使用 SHA-256、pHash、SSCD 和 DINOv2 完成自动去重与人工审核。

## 支持环境

| 平台 | 纯 CPU（无 GPU） | NVIDIA CUDA 12.8 |
| --- | --- | --- |
| Linux x86_64 | 已验证，推荐 | 提供锁定安装路径，未实机验证 |
| Windows x86_64 | 提供 PowerShell 安装路径，未实机验证 | 提供 PowerShell 安装路径，未实机验证 |

基础要求：

- Python 3.11–3.14，推荐 Python 3.14；
- Git；
- Linux 需要 `venv`、`curl` 或 `wget`、`gzip` 和 SHA-256 工具；
- CUDA 模式需要 NVIDIA GPU 及兼容 CUDA 12.8 PyTorch 的驱动；
- X、Pixiv、EH 的托管授权需要桌面 Chrome/Chromium；纯后端和去重不要求图形界面。

## 获取源码

```bash
git clone --recurse-submodules https://github.com/KKKneko/ImageWeave.git
cd ImageWeave
```

已有仓库补全 submodule：

```bash
git submodule update --init --recursive
```

## 依赖结构

项目使用两个互相隔离的虚拟环境：

| 环境 | 路径 | 锁文件 |
| --- | --- | --- |
| 后端与 gallery-dl worker | `gallery-dl-backend/.venv` | `gallery-dl-backend/requirements.txt` |
| 纯 CPU 去重 | `.venv` | `requirements-dedup-cpu.txt` |
| CUDA 12.8 去重 | `.venv` | `requirements-dedup-cuda.txt` |

CPU 与 CUDA 锁都包含完整传递依赖，安装时二选一，不需要先安装
`requirements-dedup-common.txt`。所有正式安装命令均使用哈希校验和二进制 wheel；
直接依赖统一维护在 `gallery-dl-backend/pyproject.toml`。

## Linux 部署

### 1. 安装系统依赖

Debian/Ubuntu：

```bash
sudo apt update
sudo apt install -y python3 python3-venv git curl ca-certificates gzip coreutils
```

Arch Linux：

```bash
sudo pacman -S python git curl ca-certificates gzip coreutils
```

### 2. 选择去重环境

#### 纯 CPU（无 GPU）

```bash
./scripts/setup-linux.sh --device cpu
```

该模式安装 `torch==2.11.0+cpu`、`torchvision==0.26.0+cpu` 和
`opencv-python-headless`，不会安装 NVIDIA、CUDA 或 Triton 包。

#### NVIDIA CUDA 12.8

```bash
./scripts/setup-linux.sh --device cuda
```

该模式安装独立的 CUDA 12.8 PyTorch 锁，并在安装阶段检查 GPU 是否可用。

安装需要 HTTP 代理时追加：

```bash
./scripts/setup-linux.sh --device cpu --proxy http://127.0.0.1:7890
```

安装器会初始化 submodule、创建两个 venv、安装后端与去重依赖、安装 Mihomo、下载并校验
SSCD/DINOv2 模型，以及首次创建 `gallery-dl-backend/config.json`。重复运行不会覆盖已有配置；
切换 CPU/CUDA 后需同步修改已有配置中的 `dedup.device`。

### 3. 检查并启动

```bash
./scripts/doctor.sh
./scripts/run.sh
```

## Windows 部署

以下命令在仓库根目录的 PowerShell 中执行，并确保 `python --version` 为 3.11–3.14。

### 1. 安装后端依赖

```powershell
git submodule update --init --recursive
python -m venv .\gallery-dl-backend\.venv
& .\gallery-dl-backend\.venv\Scripts\python.exe -m pip install `
  --disable-pip-version-check --require-hashes --only-binary=:all: `
  -r .\gallery-dl-backend\requirements.txt
& .\gallery-dl-backend\scripts\install_mihomo.ps1
```

### 2. 选择去重环境

#### 纯 CPU（无 GPU）

```powershell
.\setup-dedup.ps1 -Device cpu
```

#### NVIDIA CUDA 12.8

```powershell
.\setup-dedup.ps1 -Device cuda
```

安装需要 HTTP 代理时追加 `-ProxyUrl`：

```powershell
.\setup-dedup.ps1 -Device cpu -ProxyUrl http://127.0.0.1:7890
```

### 3. 创建配置

```powershell
if (-not (Test-Path .\gallery-dl-backend\config.json)) {
  Copy-Item .\gallery-dl-backend\config.example.json .\gallery-dl-backend\config.json
}
```

然后在 `gallery-dl-backend/config.json` 的 `dedup` 段设置：

| 配置 | 纯 CPU | CUDA 12.8 |
| --- | --- | --- |
| `enabled` | `true` | `true` |
| `device` | `"cpu"` | `"cuda"` |

`python_executable` 留空即可自动使用仓库根目录的 `.venv`。

### 4. 启动

```powershell
.\gallery-dl-backend\run_backend.ps1
```

## 访问与检查

服务默认只监听本机 `127.0.0.1:8787`：

| 用途 | 地址 |
| --- | --- |
| WebUI | <http://127.0.0.1:8787/ui/> |
| API 文档 | <http://127.0.0.1:8787/docs> |
| 存活检查 | <http://127.0.0.1:8787/healthz> |
| 完整就绪检查 | <http://127.0.0.1:8787/readyz> |

`/healthz` 只检查进程和 SQLite；`/readyz` 还会检查 gallery-dl、代理池、Mihomo、去重 Python、
PyTorch 与模型缓存。`/ui/` 直接提供已完成七个主应用真实 API 接入的桌面化 WebUI；旧单页
实现和临时 `/ui-next/` 入口已经移除。

## 配置抓取代理池

桌面化入口 `/ui/` 提供 CRAWL.EXE、TASKMGR.EXE、PROXY.CPL、VAULT.CPL、
REVIEW.EXE、POLICY.CPL 与只读 DIAG.EXE。`PROXY.CPL` 接入代理池
运行控制与脱敏代理源管理，通过 `/api/v1/proxy/sources` 把订阅、本地节点文件和内联节点保存为
私有运行时覆盖；`gallery-dl-backend/config.json` 仍是代理源启动基线。本地 Clash 文件建议放入
仓库根目录已忽略的 `subscriptions/`，并通过
`allowed_node_roots` 限制 API 可选范围：

```json
{
  "proxy": {
    "enabled": true,
    "auto_start": true,
    "subscription_urls": [],
    "node_file": "../subscriptions/provider.yaml",
    "inline_nodes": [],
    "allowed_node_roots": ["../subscriptions"],
    "transport_core_enabled": true
  }
}
```

API 保存只修改 `runtime/proxy/managed-sources.json`，不会停止代理池或活动租约；需显式调用
`POST /api/v1/proxy/reload` 才会应用，存在租约时仍返回冲突。订阅 URL、节点文件、
`config.json`、凭据、runtime、模型和 venv 均属于本地隐私或运行数据，不应提交到 Git。

以下三类代理互相独立：

1. setup 的 `--proxy`/`-ProxyUrl`：只用于安装和模型下载；
2. `config.json` 的 `proxy`：实际抓取任务使用的代理池；
3. WebUI“授权专用代理”：X、Pixiv、EH 共享授权浏览器使用的代理。

## 去重方式

WebUI 中可对完成的批次启动去重分析、审核候选并应用结果。也可以直接运行 CLI：

Linux：

```bash
./.venv/bin/python ./dedup_core.py "图片目录" --device cpu --dry-run --move-txt
```

Windows：

```powershell
& .\.venv\Scripts\python.exe .\dedup_core.py "图片目录" --device cpu --dry-run --move-txt
```

确认结果后移除 `--dry-run`。完整参数使用 `dedup_core.py --help` 查看。

## 依赖维护

普通用户不需要安装 `uv`。维护者更新或检查锁文件：

```bash
./scripts/lock-dependencies.sh --upgrade
./scripts/lock-dependencies.sh --check
```

## 文档

- [后端配置、API 与工作流](./gallery-dl-backend/README.md)
- [WebUI 桌面化重写开发方案](./gallery-dl-backend/docs/WEBUI_REWRITE.md)
- [架构与状态机](./gallery-dl-backend/docs/ARCHITECTURE.md)
- [Mihomo 安装说明](./gallery-dl-backend/docs/MIHOMO.md)
- [部署修复记录](./gallery-dl-backend/docs/DEPLOYMENT_ROADMAP.md)
