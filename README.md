# gallery-dl 数据管理后端

本仓库包含 gallery-dl 调度后端及两个保持独立边界的依赖/参考模块。

| 路径 | 用途 |
| --- | --- |
| [`gallery-dl-backend/`](./gallery-dl-backend/) | FastAPI 后端、跨来源搜索、顺序批次、图片任务调度与代理池 |
| [`gallery-dl-codeberg/`](./gallery-dl-codeberg/) | 上游 gallery-dl Git submodule，源码树保持上游原样；后端所需行为差异由 `gallery-dl-backend/gdl_backend/worker_patches.py` 在 worker 进程内实现，勿直接修改本目录 |
| [`Proxy_pool/`](./Proxy_pool/) | 早期抽出的独立代理池参考模块 |

平台支持：**Windows 与 Linux 完整支持，macOS 兼容预览**。平台限制和运行要求见
[`gallery-dl-backend/README.md`](./gallery-dl-backend/README.md#平台支持)；已解决问题与后续
P1/P2 部署计划见 [`DEPLOYMENT_ROADMAP.md`](./gallery-dl-backend/docs/DEPLOYMENT_ROADMAP.md)。

## Linux CPU（无 GPU）快速开始

在仓库根目录执行统一安装器。下面的 `127.0.0.1:7890` 只是一个本机安装代理示例，按实际
环境替换；也可只设置 `HTTP_PROXY`/`HTTPS_PROXY`，或用 `--no-proxy` 明确直连：

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

安装器检查 Linux、Python >= 3.10、venv、git、下载与哈希工具，不自动运行 `sudo`；随后
初始化 submodule、创建两个 venv、安装并校验 Mihomo、下载固定 revision 和 SHA-256 的
SSCD/DINOv2，并创建但不覆盖 `gallery-dl-backend/config.json`。快速重跑可用
`--skip-models`、`--skip-mihomo`、`--skip-submodule`、`--skip-backend-deps` 或
`--skip-dedup-deps`；跳过仍启用的模型后，doctor/readyz 会如实保持 not ready。

| 环境 | 路径 | 用途 |
| --- | --- | --- |
| 后端 venv | `gallery-dl-backend/.venv` | FastAPI、gallery-dl worker、代理与授权 |
| 去重 venv | `.venv` | OpenCV headless、CPU PyTorch、SSCD/DINOv2 推理 |

CPU 清单为 `requirements-dedup-common.txt` + `requirements-dedup-cpu.txt`，只安装官方
`torch==2.11.0+cpu`/`torchvision==0.26.0+cpu`，不得包含 CUDA wheel、`nvidia-*` 运行时，
也不会与普通 `opencv-python` 混装。CUDA 是独立的 `requirements-dedup-cuda.txt` 路径，
不能用于无 GPU Linux 服务器。模型和 embedding 缓存位于 `.models/`，doctor 只做快速状态
检查，不重复下载或推理。

### 三种代理不要混淆

1. `HTTP_PROXY`/`HTTPS_PROXY` 或 setup 的 `--proxy`：只辅助 git、pip、Mihomo 和模型下载，
   不写入 `config.json`，也不表示抓取任务已有节点；
2. `config.json` 的 `proxy`：项目抓取代理池，需要订阅、节点文件或内联节点；新安装因没有
   节点源而默认禁用；Mihomo 只是其中隧道节点的传输核心；
3. `auth.authorization_proxy`：X/Pixiv/EH 共享授权 Chrome 的专用代理，与抓取池独立。

Chrome/Chromium 仅为桌面授权所需；无图形会话的 Linux 服务器仍可运行后端和 CPU 去重，
但不能完成需要可见浏览器窗口的 X/Pixiv/EH 授权。启动后打开
`http://127.0.0.1:8787/ui/`。配置、授权、API 和测试说明见
[`gallery-dl-backend/README.md`](./gallery-dl-backend/README.md)，架构与状态机见
[`gallery-dl-backend/docs/ARCHITECTURE.md`](./gallery-dl-backend/docs/ARCHITECTURE.md)。

Windows PowerShell 仍可分别安装：

```powershell
cd .\gallery-dl-backend
python -m pip install -r requirements.txt
.\scripts\install_mihomo.ps1
Copy-Item config.example.json config.json
cd ..
.\setup-dedup.ps1 -ProxyUrl http://127.0.0.1:7890
.\gallery-dl-backend\run_backend.ps1
```

## L0-L2 图片变体去重

以下命令从仓库根目录执行。Linux 先使用上面的统一安装器；Windows 可用
`setup-dedup.ps1 -ProxyUrl URL`（不传则继承环境代理，`-NoProxy` 明确直连）。官方 SSCD、
DINOv2 权重缓存到 `.models`，与两个 venv 分离。

先模拟扫描：

```bash
./.venv/bin/python ./dedup_core.py "图片目录" --device cpu --dry-run --move-txt
```

确认候选后移除 `--dry-run` 正式处理。脚本会自动切换到同目录 `.venv`，分层规则为：

- L0：文件 SHA256 与解码像素哈希，完全相同图自动择优。
- L1：pHash、SSCD 与严格像素残差，纯压缩/重编码高置信组自动择优，其余进入人工审核。
- L2：DINOv2、边缘结构与 SIFT 几何校验，仅进入人工审核。

默认参数采用平衡档。模型向量按文件 SHA256 缓存在 `.models/embeddings.sqlite3`，重复扫描会复用。
使用 `--no-sscd` 或 `--no-dino` 可关闭对应层；完整参数见：

```bash
./.venv/bin/python ./dedup_core.py --help
```

## 聚合爬图到人工审核

聚合爬取和去重整理是两个独立的可选环节。批次结束或载入历史批次都不会自动运行去重；用户
在批次页面点击“开始去重分析”后，后端才调用仓库根目录 `.venv` 中的 Python 和 `.models`
中的 SSCD/DINOv2 权重执行 L0-L2 分析：

- L0 完全相同组和通过原脚本严格门槛的 L1 压缩、重编码、重采样组，沿用原脚本的
  complete-link 分组与 `choose_quality_winner`，自动保留 keeper 并将其余图片移出；
- L1/L2 人工候选会合并到对应重复组，自动 keeper、未命中图片和读取失败图片全部进入审核；
- 每组默认全部保留，可全留、全不留或仅保留质量推荐；
- 所有组确认后才可应用，避免未翻页图片被默认选择静默带过；
- 严格自动淘汰和人工未选图片均连同同名 `.txt`，按原相对目录移入批次的 `duplicates/`。

新建和历史终态批次都保持“去重未开始”，只有显式启动才建立分析任务。读取批次详情、打开
WebUI 或重启服务均不会隐式排队。

聚合工作流使用根目录 `./scripts/run.sh` 启动，打开 `http://127.0.0.1:8787/ui/` 即可在同一批次
页面完成爬取、去重和质量筛选。去重环境、脚本与模型路径可通过后端 `config.json` 的 `dedup`
段覆盖，默认均指向本目录现有资源。
