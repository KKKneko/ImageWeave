# Linux 部署问题与修复路线图

本文记录 ImageWeave 在 Linux、特别是无 GPU 的 CPU-only 主机上的部署问题、优先级和完成状态。
问题按同类能力归组，避免把一个部署目标拆成过多零散事项。

## 范围与验收基线

当前优先支持：

- Linux x86_64；
- Python 3.11–3.14（3.11 最低，3.14 推荐）；
- 无 NVIDIA GPU 的 CPU-only 完整工作流；
- 后端、gallery-dl worker、Mihomo、SSCD/DINOv2 去重和 WebUI；
- X、Pixiv、EH 的托管授权仍需要桌面 Chrome/Chromium 与图形会话。

已完成的真实验证环境：Arch Linux x86_64、Python 3.14、无 NVIDIA GPU、本机 Chromium，
下载阶段使用 `http://127.0.0.1:7890` 作为临时安装代理。安装代理不会写入项目抓取代理池配置。

---

## P0：阻断 Linux CPU-only 部署的问题

状态：**已完成**。

### P0-1：缺少完整、幂等的 Linux CPU 安装入口

原问题：

- 只有 Windows `setup-dedup.ps1`，没有 Linux 去重安装器；
- 去重依赖强制安装 CUDA 12.8 版 PyTorch，无 GPU 主机也会下载 CUDA/NVIDIA 运行时；
- 后端和去重使用两个 venv，但需要用户手动理解、创建和连接；
- `dedup_core.py` 硬编码 `.venv/Scripts/python.exe` 和 Windows 安装提示；
- 没有统一检查 Python、venv、Git、下载工具、submodule、Mihomo、配置和模型。

已完成：

- 新增根目录入口 `scripts/setup-linux.sh`、`scripts/doctor.sh`、`scripts/run.sh`；
- 安装器负责初始化 submodule、创建两个 venv、安装依赖、安装 Mihomo、生成配置和准备模型；
- 拆分公共、CPU、CUDA 去重依赖；CPU 路径只安装官方 `+cpu` wheel 和
  `opencv-python-headless`；
- 支持 `--proxy`、`--no-proxy`、`--skip-models`、`--skip-mihomo` 等幂等重跑选项；
- 新配置不会覆盖已有配置、凭据或运行数据；
- 修复 Linux/Windows venv 路径发现，并避免把 venv Python 符号链接解引用成系统 Python。

### P0-2：启动、配置和就绪状态不能及时暴露错误

原问题：

- 后端 venv 缺失时，`run_backend.sh` 静默退回系统 Python；
- 正式启动缺少 `config.json` 时静默使用默认值；
- 默认启用代理和去重，但可能既没有代理源，也没有去重环境和模型；
- `/readyz` 只检查 SQLite 与 gallery-dl 源码，功能不可用时仍可能报告 ready。

已完成：

- 后端 venv或正式配置缺失时 fail-fast，并给出明确修复命令；
- 无节点源的新配置默认禁用项目抓取代理池；
- 新增 `gdl_backend.diagnostics` 和 Linux doctor；
- `/healthz` 只表示进程与 SQLite 存活；
- `/readyz` 结构化报告 gallery-dl、项目代理、Mihomo、去重 Python、Torch 实际设备、
  SSCD 和 DINOv2；启用组件缺失时返回 503，禁用组件不算失败；
- 安装下载代理与项目抓取代理池被明确区分。

### P0-3：模型下载并不等于 CPU 去重可用

原问题：

- Linux 没有正式模型准备路径；
- 模型缺失或下载失败直到批次去重时才暴露；
- 没有真实 CPU 加载和 embedding 闭环证据。

已完成：

- 安装器默认下载并校验固定 revision 的 SSCD 与 DINOv2；
- 保留模型 SHA-256 校验和缓存复用；
- 在真实 CPU 环境加载两套模型并处理三张临时图片；
- SSCD、DINOv2 各产生三条 embedding，worker 生成合法审核 manifest；
- manifest 记录实际分析设备和启用模型；
- doctor 快速检查缓存状态，不会重复执行昂贵推理。

### P0-4：Linux stall 后 `.part` 为空，无法续传

原问题：

- 下载收到部分数据后被 stall watchdog 终止，Python 用户态缓冲未及时刷新；
- `.part` 文件可能保持 0 字节，导致后续 Range 恢复失效；
- 对应测试在 Linux 上稳定失败。

已完成：

- 每个完整网络块写入后执行普通 `flush()`，不做逐块 `fsync()`；
- watchdog 终止后保留非空 `.part`；
- 重试使用正确的 `Range: bytes=<part_size>-` 并生成完整最终文件；
- 后端测试现为 232/232 通过。

### P0 验收结果

- `torch==2.11.0+cpu`；
- `torch.cuda.is_available() == False`；
- `torch.version.cuda is None`；
- 去重 venv 不含 `nvidia-*`、CUDA runtime 或 Triton；
- 只安装 `opencv-python-headless`；
- doctor 与 `/readyz` 返回 ready；
- 项目抓取代理池正确显示 disabled；
- 后端测试 232/232 通过；
- 根去重测试 30 个通过，1 个依赖未跟踪外部图片样本的测试跳过；
- venv、模型、配置、运行数据、凭据和 Mihomo 二进制均未进入 Git 跟踪。

---

## P1：部署可复现性、资源控制与持续验证

状态：**已完成（2026-08-02）**。

### P1-1：依赖可复现与支持矩阵

已完成：

- `gallery-dl-backend/pyproject.toml` 成为后端、去重公共、CPU 和 CUDA 的唯一直接依赖
  事实来源；去重使用 PEP 735 dependency groups，不再手工同步多份直接依赖；
- 提交四份带哈希的完整传递依赖锁：后端、去重公共、CPU 完整环境、CUDA 完整环境；
- CPU 锁固定官方 `torch==2.11.0+cpu`/`torchvision==0.26.0+cpu`，不含 `nvidia-*`、
  CUDA runtime、Triton 或非 headless OpenCV；CUDA 12.8 完整闭包严格位于独立锁；
- `setup-linux.sh` 默认用 `pip --require-hashes --only-binary` 消费锁，不再自动升级 pip 或依赖；
- `scripts/lock-dependencies.sh --upgrade/--check` 固定 `uv==0.12.1`，提供显式更新和 drift 检查；
- 完整产品最低版本从无法满足 NumPy 约束的 Python 3.10 如实上调到 3.11，推荐 3.14，
  支持范围暂定 `<3.15`；快速 CI 配置 3.11 与 3.14，不排列所有中间微版本；
- 必测平台仅为 Linux x86_64 CPU。Windows x86_64 与 CUDA 12.8 路径保留兼容锁和脚本，
  但本次未实机验证；macOS、ARM 和其他加速器明确标记未验证。

### P1-2：CPU 去重资源边界与可观察性

已完成：

- 新增 CPU 保守 profile：worker/模型解码最多 4，Torch intra-op 最多 4、inter-op 1，
  OpenCV 1；OpenMP/MKL 与 Torch 同步，batch 收敛到 1–4，近邻块收敛到 64–256；
- `workers`、`torch_threads`、`torch_interop_threads`、`deep_batch_size`、
  `neighbor_block_size` 支持 `0=自动` 和正整数覆盖，并贯穿配置、管理器、worker、核心和模型层；
- worker 在重型库导入和并行计算前设置环境/Torch；inter-op 每进程最多设置一次，CUDA/auto
  未覆盖时保留原有 8/8/512 与 Torch 线程语义；
- manifest 和日志记录配置/实际设备、预处理与解码 worker、batch、Torch/OpenMP/MKL/OpenCV
  线程、近邻分块以及扫描、预处理、分析、manifest 构建和总耗时；
- 未修改任何去重阈值、候选条件、complete-link 分组或质量 winner 规则；现有确定性测试通过。

真实 CPU 基准（程序生成、无敏感内容的 48 张 384×384 图片，SSCD+DINOv2 全开）：

- 实际参数：16 逻辑 CPU，worker 4，Torch 4/1，OpenCV 1，batch 2，neighbor block 128；
- wall time 28.141 秒；manifest 内分析阶段 24.380246 秒；
- worker 峰值 RSS 892060 KiB，由 Linux `resource.RUSAGE_CHILDREN.ru_maxrss` 实测；
- 生成合法 manifest：48 张图片、5 个候选组、无读取失败；
- 同时运行的后端接受 28 次 `/healthz`，0 次失败，最慢 0.015418 秒；
- CPU venv 无 CUDA/NVIDIA/Triton，`torch.version.cuda is None`，未加载 CUDA 路径。

### P1-3：Linux CPU 自动化发布门槛

已完成：

- `linux-cpu-fast.yml` 在 push/PR/手动触发：Shell 语法、依赖漂移、Python 3.11/3.14 后端
  完整测试、3.14 CPU 锁安装、根测试、CPU 纯净性和 health/ready smoke；
- `linux-cpu-real-models.yml` 每周和手动触发：缓存固定公开模型，校验 SSCD+DINOv2，
  并运行程序生成图片的真实 CPU worker 闭环；快速层不重复下载大模型；
- workflow 复用 setup、纯净性、服务 smoke 和真实模型脚本，未引用本机安装代理；
- 私人 `runtime/downloads` 真实变体测试仍可选并在样本缺失时跳过，但程序生成闭环已经提供
  独立公开证据，不再依赖私人样本作为唯一回归；
- 本地已解析两份 workflow 结构并执行其中关键命令；GitHub 托管调度本身只能在远端触发，
  不伪造本地调度结果。

### P1-4：应用级权限与秘密保护

已完成：

- Linux setup、doctor、run 和 Mihomo 安装脚本使用 `umask 077`；setup 安全修复明确的项目管理
  元数据/凭据/模型树，但不递归修改 `runtime/downloads` 或用户外部输出；
- 应用主动维护 runtime 元数据、SQLite/WAL/SHM、credentials/managed、浏览器授权文件、
  审核 manifest/日志、代理核心配置/日志和模型/embedding 缓存为目录 0700、文件 0600；
- 敏感文件和直接管理目录在创建/替换前拒绝现有路径组件中的明显符号链接，原子临时写使用 0600 与
  `O_NOFOLLOW`（平台支持时）；Windows ACL 逻辑保留；
- 外部输出根目录保持用户权限策略；doctor 只报告，不 chmod，并新增 SQLite、模型缓存、
  外部输出边界诊断；
- 公共配置中的带凭据授权代理会掩码；doctor 错误与输出不打印订阅 URL、Cookie、token、
  代理凭据或授权 Profile 内容；符号链接权限失败关键测试通过。

### P1 真实验收结果

环境：Arch Linux x86_64、Python 3.14.6、16 逻辑 CPU、无 NVIDIA GPU、已有 Chromium；
安装/下载阶段临时使用本机 HTTP 代理，未写入抓取代理池或 workflow。

- 在全新 `/tmp` 隔离目录由 `setup-linux.sh` 创建两个 venv 并安装完整 CPU 锁：后端关键包与锁
  一致，CPU 纯净性检查通过，配置 0600、敏感目录 0700；
- 后端完整测试 235/235 通过；根 CPU 测试 32 个通过，1 个私人样本测试明确跳过；
- doctor 为 ready，`/healthz` 与完整 `/readyz` 返回 200；另行 smoke 验证启用去重但模型缺失时
  `/healthz` 仍为 200、`/readyz` 为 503；
- SSCD+DINOv2 中等规模基准结果如 P1-2；CPU 环境只有 headless OpenCV；
- 所有修改 Shell 脚本通过 `bash -n`，锁 drift、workflow 结构和 `git diff --check` 通过；
- submodule 保持 `2790ceb303ee4986ef7f683cc16d3799bb4356ce`，模型、venv、配置、runtime、
  credentials、Mihomo 二进制、安装代理和其他秘密均未加入跟踪。

---

## P2：长期运行、升级与恢复

状态：**待 P1 完成后处理**。

### P2-1：缺少服务生命周期管理

当前只有前台启动脚本，尚无正式的：

- systemd unit 和非 root 专用用户；
- 自动重启与资源限制；
- 日志轮转；
- 服务停止、重启和遗留 worker 回收的部署级验证。

第一阶段优先 systemd，不急于引入 Docker；托管桌面 Chrome 与宿主图形会话会使容器方案更复杂。

### P2-2：缺少备份、升级和回滚流程

当前缺少：

- SQLite、配置、凭据和审核状态的统一备份命令；
- 数据库 schema 升级前备份；
- gallery-dl submodule、Mihomo、模型与 Python 依赖的协调升级步骤；
- 升级失败后的版本回退和数据恢复说明。

目标是在不丢任务、租约、审核进度、Cookie 和 `.part` 文件的前提下完成升级与恢复演练。

---

## 非当前部署路线图范围

以下内容不应混入 P1/P2 部署修复：

- 新增图片站点；
- 扩展搜索或去重算法；
- 重写 WebUI；
- 通用图库管理、标签生态或播放器；
- 为追求形式覆盖而新增大量细粒度 mock 测试。

部署工作的判断标准始终是：一台干净、无 GPU 的 Linux 主机能否可重复安装、准确诊断、稳定运行、
完成真实抓取与 CPU 去重，并能在升级或故障后恢复。
