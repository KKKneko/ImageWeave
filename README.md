# gallery-dl 数据管理后端

本仓库包含 gallery-dl 调度后端及两个保持独立边界的依赖/参考模块。

| 路径 | 用途 |
| --- | --- |
| [`gallery-dl-backend/`](./gallery-dl-backend/) | FastAPI 后端、跨来源搜索、顺序批次、图片任务调度与代理池 |
| [`gallery-dl-codeberg/`](./gallery-dl-codeberg/) | 上游 gallery-dl Git submodule，源码树保持上游原样；后端所需行为差异由 `gallery-dl-backend/gdl_backend/worker_patches.py` 在 worker 进程内实现，勿直接修改本目录 |
| [`Proxy_pool/`](./Proxy_pool/) | 早期抽出的独立代理池参考模块 |

平台支持：**Windows 与 Linux 完整支持，macOS 兼容预览**。平台限制和运行要求见
[`gallery-dl-backend/README.md`](./gallery-dl-backend/README.md#平台支持)。

## 快速开始

首次检出先初始化上游子模块：

```bash
git submodule update --init --recursive
```

Linux：

```bash
cd gallery-dl-backend
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
bash scripts/install_mihomo.sh
cp config.example.json config.json
bash run_backend.sh
```

Windows PowerShell：

```powershell
cd .\gallery-dl-backend
python -m pip install -r requirements.txt
.\scripts\install_mihomo.ps1
Copy-Item config.example.json config.json
.\run_backend.ps1
```

启动后打开 `http://127.0.0.1:8787/ui/`。配置、授权、API 和测试说明集中在
[`gallery-dl-backend/README.md`](./gallery-dl-backend/README.md)，架构与状态机见
[`gallery-dl-backend/docs/ARCHITECTURE.md`](./gallery-dl-backend/docs/ARCHITECTURE.md)。

## L0-L2 图片变体去重

以下命令从仓库根目录执行。首次安装会在仓库根目录创建或复用去重专用 `.venv`，并把官方
SSCD、DINOv2 权重缓存到根目录 `.models`；它与 Linux 快速开始中可选的
`gallery-dl-backend/.venv` 后端环境相互独立。默认代理为 `http://127.0.0.1:7890`：

```powershell
.\setup-dedup.ps1
```

先模拟扫描：

```powershell
python ".\dedup_core.py" "图片目录" --dry-run --move-txt
```

确认候选后移除 `--dry-run` 正式处理。脚本会自动切换到同目录 `.venv`，分层规则为：

- L0：文件 SHA256 与解码像素哈希，完全相同图自动择优。
- L1：pHash、SSCD 与严格像素残差，纯压缩/重编码高置信组自动择优，其余进入人工审核。
- L2：DINOv2、边缘结构与 SIFT 几何校验，仅进入人工审核。

默认参数采用平衡档。模型向量按文件 SHA256 缓存在 `.models/embeddings.sqlite3`，重复扫描会复用。
使用 `--no-sscd` 或 `--no-dino` 可关闭对应层；完整参数见：

```powershell
python ".\dedup_core.py" --help
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

聚合工作流仍从 `gallery-dl-backend` 启动，打开 `http://127.0.0.1:8787/ui/` 即可在同一批次
页面完成爬取、去重和质量筛选。去重环境、脚本与模型路径可通过后端 `config.json` 的 `dedup`
段覆盖，默认均指向本目录现有资源。
