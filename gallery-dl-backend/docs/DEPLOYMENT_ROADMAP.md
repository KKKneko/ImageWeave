# Linux 部署问题与修复路线图

本文记录 ImageWeave 在 Linux、特别是无 GPU 的 CPU-only 主机上的部署问题、优先级和完成状态。
问题按同类能力归组，避免把一个部署目标拆成过多零散事项。

## 范围与验收基线

当前优先支持：

- Linux x86_64；
- Python 3.10 及以上；
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

状态：**待处理，下一阶段**。

### P1-1：依赖不可复现，支持矩阵仍不明确

当前问题：

- 后端 `requirements.txt` 使用宽松下限，传递依赖会随安装日期变化；
- `pyproject.toml` 与 `requirements.txt` 重复维护，未来可能漂移；
- CPU/CUDA 清单只固定直接依赖，没有统一锁定完整传递依赖；
- 虽然声明 Python 3.10+，但缺少明确的发行版、Python 版本和架构验证矩阵；
- 没有标准化的依赖更新与回滚流程。

目标：

- 确定唯一依赖事实来源；
- 提交可审查、可更新的后端与 CPU/CUDA 锁定结果；
- 安装器默认使用锁定依赖，同时保留显式更新流程；
- 明确 Linux x86_64、Python 最低版本与当前推荐版本；
- 在支持矩阵外的环境给出清晰提示，而不是隐式承诺。

### P1-2：CPU 去重缺少资源边界和服务器默认值

当前问题：

- 图片预处理线程、Torch intra-op/inter-op 线程和 OpenMP/MKL 线程可能叠加；
- CPU-only 主机可能因线程过度订阅影响后端响应；
- 深度 batch、近邻分块和线程数没有统一的 CPU profile；
- 缺少一组真实但适度规模的 CPU 时间、内存和吞吐基准。

目标：

- 为 CPU 模式提供保守且可配置的 worker、Torch 线程和 batch 默认值；
- 避免 API、下载任务与去重 worker 无限制争用所有 CPU；
- 在 manifest/日志中记录关键资源参数和阶段耗时；
- 使用一组中等规模本地样本做一次基准，避免构造大量细粒度性能测试。

### P1-3：Linux CPU 支持尚未成为自动化发布门槛

当前问题：

- 仓库没有 CI workflow；
- 没有从干净环境安装、启动和检查 `/readyz` 的自动验证；
- 真实模型测试依赖外部网络，不适合每个提交都强制下载；
- 现有真实变体回归依赖开发机未跟踪样本。

目标：

- 每次提交执行 Linux 后端测试、根 CPU 测试和最小启动 smoke；
- CI 验证 CPU 环境不含 CUDA/NVIDIA 包；
- 定时或手动 workflow 下载真实模型并执行一次 CPU 去重闭环；
- 将必要的最小回归图片作为小型、许可清晰的测试夹具管理；
- 测试保持少而真实，不建立无意义的微型组合矩阵。

### P1-4：应用自身的权限保护仍依赖安装脚本

当前问题：

- setup 已设置配置 `0600`、敏感目录 `0700`，但直接调用 Python 或使用自定义路径时，
  应用创建目录仍可能受到宽松 umask 影响；
- 数据库、日志、模型缓存和自定义 runtime 路径缺少统一的权限策略与诊断；
- 现有文件权限异常时，应用与 doctor 的修复边界尚未明确。

目标：

- 应用创建敏感目录和文件时主动使用安全权限，不只依赖 setup；
- setup 使用安全 umask，并安全修复自己管理的既有路径；
- doctor 继续只报告，不擅自修改用户提供的外部目录；
- 不泄露订阅 URL、Cookie、Token、代理凭据或授权 Profile 内容。

### P1 建议实施顺序

1. 确定支持矩阵和唯一依赖事实来源；
2. 生成并接入可复现锁定依赖；
3. 增加 CPU 资源 profile 与一次真实基准；
4. 建立快速 CI 和定时真实模型 smoke；
5. 收紧应用级权限创建逻辑；
6. 在干净 Linux CPU 环境重新执行安装、doctor、启动和去重闭环。

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
