# ImageWeave 后端加固与多窗口改造开发计划

立项日期：2026-08-04
适用范围：`gallery-dl-backend/`（后端 + WebUI）
不适用范围：`dedup_core.py`、`dedup_models.py`、`dedup_review_worker.py`、`gallery-dl-codeberg/`

---

## 0. 本文档怎么用

本文档面向"逐个派发给独立 agent 实现"的流程：

1. 按 §4 的顺序取出**一个**任务，把该任务的完整小节内容作为任务提示派发；
2. agent 完成后按该任务的「验收标准」逐条核对；
3. 任一条不通过 → 退回并附上未通过的条目编号，不要继续下一个任务；
4. 全部通过 → 先勾选验收标准、**做一次 git commit**（见 §3 第 9 条），
   再派发下一个任务。

任务之间的依赖已在每个小节的「前置依赖」写明。**不要跳序执行**，尤其 T7 必须在 T8 之前，
T5 必须在 T6 之前。

---

## 1. 决策记录（已确认，实现时不得自行更改）

| 编号 | 决策 | 取值 |
| --- | --- | --- |
| D1 | 批次并行上限 | 全局最多 **4** 个批次同时推进 |
| D2 | 同站点「发现/规划」是否并行 | **串行**（同一 site 同一时刻只允许一个发现在跑） |
| D3 | 代理探活缓存 | 按**目标主机**缓存，TTL 默认 **600 秒** |
| D4 | 日志缓冲窗口 | **200ms 或 64 行**，先到先 flush |
| D5 | Host 白名单 | **只允许回环 Host + 配置端口**，不提供额外白名单配置项 |
| D6 | UI 方向 | **真多窗口**（可拖拽、可缩放、多任务栏按钮、z 序） |
| D7 | 去重算法与内存布局 | **完全不动**（本轮不做 no-upscale / SIFT LRU / memmap） |

D7 的理由：这三项都会改变去重管线的中间数据，无法在不做效果回归实验的前提下确认对
识别率的影响。本轮任何任务都不得修改 `dedup_core.py` / `dedup_models.py` /
`dedup_review_worker.py` 的任何一行。

---

## 2. 已确认的风险边界（写给实现者看的硬约束）

本轮改动**不得**改变以下任何一项，因为它们直接决定"打到目标站点的压力"与"去重效果"：

| 不变量 | 位置 | 说明 |
| --- | --- | --- |
| 全局下载并发上限 | `config.py` `SchedulerSettings.max_concurrent_tasks = 20` | 默认值和语义都不变 |
| 每站下载并发上限 | `scheduler.py` `active_sites[site] >= policy.max_concurrency` | 必须继续基于 `self._active` 全局计数，不得改成"每批次计数" |
| 重试退避算法 | `scheduler.py` `backoff_anchor_attempt` / `retry_backoff_cap_seconds` | 不变 |
| gallery-dl 命令行构造 | `gallery.py` `build_command` | 不变 |
| 去重一次只跑一个批次 | `review.py` `DedupReviewManager` 单循环 | 不得改成并行分析 |
| 去重范围 = 批次输出目录 | `review.py` / `resolve_review_file` | 不得引入跨批次去重 |
| 错误分类的输入来源 | `gallery.py` 内存 `tail` deque → `classify_result` | 不得改成从数据库读日志 |
| 部分成功自动重试的判据 | `scheduler.py` `task_artifacts` 非空 → `extraction_partial` | T4 必须保证这个集合仍然同步填充 |

任何任务如果发现自己必须动上面某一项才能完成，**停下来退回**，不要自行取舍。

---

## 3. 全局约束（每个任务都必须遵守）

1. **测试基线**：改动前后都必须跑
   ```bash
   (cd gallery-dl-backend && .venv/bin/python -m unittest discover -s tests -v)
   ```
   基线为 288 个测试全绿。任务完成后测试数只允许增加，不允许有 failure/error/skip 新增。
2. **不引入新的运行时依赖**。不改 `requirements.txt`。
3. **注释与文档用简体中文**；代码标识符、配置键、API 字段名沿用现有英文风格。
4. **脱敏纪律**：任何新增的日志、错误信息、API 响应都必须经过 `redaction.redact_text` /
   `redact_data`，不得回显订阅 URL、Cookie、代理凭据、完整用户路径。
5. **不得放宽现有安全校验**：路径逃逸检查、符号链接拒绝、`allowed_*_roots` 白名单、
   `forbidden_args` 前缀匹配，一律保持或加强。
6. **新增配置项必须**：写进 `config.example.json`、加入 `AppSettings.validate()` 的范围校验、
   加入 `public_dict()`（若属于可公开信息）、并在 `README.md` 对应表格补一行。
7. **异步纪律**：任何在 `async def` 里执行的阻塞调用（文件 I/O、`subprocess`、
   `requests`、SQLite 写）必须走 `asyncio.to_thread`。反之，任何从工作线程访问
   asyncio 拥有的可变状态（`scheduler._active`、`ordered_crawls._batch_tasks`、
   `gallery._active`）必须先在事件循环上取快照再传入线程。
8. **测试粒度**：每个任务的「测试要求」列出的是**必须锁住的行为契约**，
   覆盖主要正常路径与关键失败路径即可。具体写法与拆分粒度由实现者自己拿主意，
   不追求覆盖率指标。硬约束只有四条：
   - **不得用 chrome-devtools 拉起真实浏览器做测试**。前端一律用 Node 测试覆盖，
     优先测纯函数与 store reducer。
   - 不发真实网络请求，不真实拉起 torch / mihomo / gallery-dl 子进程，
     一律 fake 或 monkeypatch。
   - 不写压力测试或性能基准；不做硬编码耗时阈值断言（CI 会抖）。
     需要验证「没被串行阻塞」时，用完成顺序或 `asyncio.Event` / 假时钟，
     而不是固定时长的 `time.sleep`。
   - 优先断言可观察行为（API 响应、数据库行、状态机结果、调用次数），
     不断言私有属性名或内部调用顺序——否则 T5/T6 的连接重构会让一堆无关测试变红。
   套件应保持可以随手跑完的量级（起始约 38 秒）；若某个任务让总耗时显著变长，
   验收时应要求简化。复用 `tests/helpers.py` 现有 fixture，不要新造平行的一套。
9. **Git 提交（硬性要求）**：每个任务**验收通过后必须做一次 commit**，一任务一提交。
   - **提交由总协调者在验收通过后执行，实现者不提交**。这样被退回的中间态
     不会进入历史，每个 commit 都是已验证的全绿状态，出问题时可以干净地回到上一个任务。
   - 提交信息格式：首行 `T<编号>：<任务标题>`，空行后用中文列出改了什么、
     为什么。例：
     ```
     T1：/readyz 与诊断探测不再阻塞事件循环

     - readyz 整体改为 asyncio.to_thread，scheduler/ordered_crawls 快照在循环上取
     - dedup 探测缓存 TTL 30s -> 120s，过期路径改为返回旧值 + 后台单飞刷新
     - 原因：前端每 30s 轮询 /readyz，会把事件循环卡死一次 torch import 的时长
     ```
   - 只暂存本任务相关文件，**不要 `git add .`**；提交前用 `git status` 确认
     没有误入 `gallery-dl-backend/config.json`、`credentials/`、`runtime/`、
     `subscriptions/`、`.models/`、`*.venv/` 等本地敏感路径。
   - 本轮只本地提交，**不要 push、不要建分支、不要 amend/rebase/reset**。
   - 文档里的验收勾选与本任务代码一同提交。

---

## 4. 任务清单与派发顺序

| 序号 | 任务 | 主要文件 | 前置 |
| --- | --- | --- | --- |
| T1 | `/readyz` 与诊断探测不再阻塞事件循环 | `app.py` `diagnostics.py` | — |
| T2 | 目标地址校验改为严格模式 | `app.py` `config.py` | — |
| T3 | 回环 Host 与 fetch metadata 守卫 | `app.py` `tests/*` | — |
| T4 | 任务日志批量异步落库 | 新增 `log_writer.py` `scheduler.py` `database.py` | — |
| T5 | SQLite 读写连接分离：基础设施 + 热读路径 | `database.py` | — |
| T6 | SQLite 读写连接分离：剩余只读方法迁移与审计 | `database.py` | T5 |
| T7 | 代理探活按目标主机缓存 | `proxy.py` `config.py` `ordered_crawl.py` | — |
| T8 | 批次级并发（4 并行 + 同站发现串行） | `ordered_crawl.py` `config.py` `database.py` | T7 |
| T9 | 地址规划改为分块事务 + 主动让出 | `ordered_crawl.py` `database.py` `app.py` | — |
| T10 | 五个小缺陷收尾 | `review.py` `scheduler.py` `database.py` | — |
| T11 | 前端状态层：单窗口视图 → 窗口栈 | `webui/js/core/store.js` `router.js` | — |
| T12 | 窗口管理器重写：多实例 + 拖拽 + 缩放 + z 序 | `webui/js/core/window-manager.js` `index.html` `styles/desktop.css` | T11 |
| T13 | 任务栏多按钮、溢出折叠、移动端降级、占位应用归位 | `webui/js/components/taskbar-summary.js` `app-registry.js` | T12 |
| T14 | 非聚焦窗口轮询降频 + 应用生命周期适配 | `webui/js/core/polling.js` 各 `apps/*.js` | T13 |

推荐派发顺序即上表顺序。T1–T3 是安全/稳定性优先项，建议先做完再动结构性重构。

---

## T1 — `/readyz` 与诊断探测不再阻塞事件循环

### 背景

`app.py:565` 的 `readyz()` 是 `async def`，但同步调用了 `readiness_snapshot(...)`，调用链：

```
readyz() -> readiness_snapshot() -> dedup_components()
         -> subprocess.run([dedup_python, "-c", _DEDUP_PROBE], timeout=20)   # diagnostics.py:217
```

`_DEDUP_CACHE` TTL 只有 30 秒，而前端 `taskbar-summary.js:8` 每 30 秒轮询 `/readyz`，
`diagnostics-model.js:24` 在 DIAG.EXE 打开时每 20 秒再轮询一次。结果：只要 WebUI 开着，
事件循环每 30 秒左右就被一次 torch import 卡死 1–8 秒（CUDA 更久）。这段时间内 gallery-dl
子进程的 stdout 管道停止排空、所有 API 挂起、调度循环停摆。

同一个 handler 还同步调用了 `service.proxy.status()`（读 `managed-sources.json` + SHA-256 +
遍历全部节点），以及 `readiness_snapshot` 内部大量 `path.stat()` / `os.access()`。
`ServiceContainer._proxy_health_loop`（`app.py:270`）里也有一处裸 `self.proxy.status()`。

### 前置依赖

无。

### 实现要求

**1.1 `readyz` 整体挪进线程，但 asyncio 状态必须先在循环上取快照。**

`scheduler.active_summary()` 会遍历 `self._active` 字典，`ordered_crawls.status()` 会读
`self._loop_task`。两者都是事件循环拥有的可变状态，不能在工作线程里访问（会出现
`dictionary changed size during iteration`）。正确写法：

```python
@app.get("/readyz")
async def readyz():
    # 事件循环拥有的可变状态必须在循环上取快照，不能带进工作线程。
    scheduler_summary = service.scheduler.active_summary()
    ordered_summary = service.ordered_crawls.status()

    def snapshot() -> dict[str, Any]:
        return readiness_snapshot(
            settings,
            database_ok=service.db.ping(),
            live_proxy_status=service.proxy.status(),
            scheduler=scheduler_summary,
            ordered_crawls=ordered_summary,
        )

    payload = await asyncio.to_thread(snapshot)
    return JSONResponse(status_code=200 if payload["ready"] else 503, content=payload)
```

同时把 `TaskScheduler.active_summary()` 里的 `Counter(site for _, site in self._active.values())`
改成先 `list(self._active.values())` 再统计。

**1.2 `_proxy_health_loop` 的 `status()` 也要下线程。** `app.py:265-272` 改为：

```python
status = await asyncio.to_thread(self.proxy.status)
if status.get("running"):
    await asyncio.to_thread(self.proxy.probe)
```

**1.3 `dedup_components` 改成「过期也先返回旧值，后台单飞刷新」。** 在 `diagnostics.py`：

- 新增模块常量 `_DEDUP_CACHE_FRESH_SECONDS = 120.0`，替换现在硬编码的 `30.0`。
- 新增模块级 `_DEDUP_REFRESH_INFLIGHT: set[str]`，与 `_DEDUP_CACHE` 共用 `_DEDUP_CACHE_LOCK`。
- `dedup_components(settings, *, use_cache=True)` 新逻辑：
  1. `use_cache=False`（doctor CLI 路径）→ 行为完全不变，同步探测，不读写单飞集合；
  2. 命中且未过期 → 直接返回副本；
  3. 命中但已过期 → **立即返回旧副本**；同时在锁保护下检查
     `key not in _DEDUP_REFRESH_INFLIGHT`，若不在则加入并启动一个 `daemon=True` 的
     `threading.Thread` 做真实探测，线程在 `try/finally` 里写回缓存并移出单飞集合；
  4. 未命中（首次调用）→ 同步探测（此时已在 `to_thread` 里，不阻塞事件循环）。
- 返回值必须仍是深拷贝（沿用 `{name: dict(value) for ...}`），避免调用方就地改动污染缓存。
- 过期返回旧值时，在每个 component 里加 `"stale": True` 与 `"age_seconds": round(age, 1)`；
  新鲜数据不带这两个键。

**1.4 单飞线程不得阻塞进程退出。** 必须 `daemon=True`，且不得持有 `_DEDUP_CACHE_LOCK`
跨越 `subprocess.run`（只在读写缓存的瞬间持锁）。

### 禁止事项

- 不要改 `_DEDUP_PROBE` 探测脚本，也不要改 `subprocess.run` 的 `timeout=20`。
- 不要给 `/healthz` 加 `to_thread`：它只做一次 `SELECT 1`，必须保持最低开销。
- 不要改 `mihomo_component` / `_directory_component` 的签名或语义。

### 测试要求

新增 `tests/test_diagnostics_cache.py`：

1. `test_readyz_does_not_block_event_loop`：monkeypatch `diagnostics.dedup_components`
   为一个“阻塞直到测试主动放行”的假实现（用 `threading.Event.wait()`，不要用
   固定时长的 `time.sleep`）；先发起 `/readyz`，在它还没返回时发起 `/healthz`，
   断言 `/healthz` 先返回（用完成顺序断言，**不做硬编码的耗时阈值断言**，
   避免 CI 抖动）。
2. `test_dedup_components_returns_stale_immediately`：预置已过期缓存，真实探测替换为
   一个阻塞在 `threading.Event` 上的假实现（测试末尾再放行并 join），
   断言调用立即返回且带 `stale=True`。不要用 `time.sleep(2)` 拖慢整个套件。
3. `test_dedup_components_single_flight`：并发调用 8 次，断言真实探测只被调用 1 次。
4. `test_dedup_components_fresh_has_no_stale_flag`。
5. `test_doctor_path_ignores_cache`：`use_cache=False` 必定执行真实探测。

### 验收标准

- [x] A1 `readyz` 中不再有任何同步的 `readiness_snapshot` / `proxy.status` / `db.ping` 调用。
- [x] A2 `scheduler_summary` 与 `ordered_summary` 在事件循环上取得，未留在线程函数里调用。
- [x] A3 `active_summary()` 不再直接遍历 `self._active`。
- [x] A4 `_proxy_health_loop` 中 `status` 与 `probe` 都走 `to_thread`。
- [x] A5 `_DEDUP_CACHE_FRESH_SECONDS == 120.0`，过期路径返回旧值且不阻塞。
- [x] A6 单飞刷新线程 `daemon=True`，`subprocess.run` 期间不持锁。
- [x] A7 doctor CLI（`use_cache=False`）行为零变化。
- [x] A8 上述测试要求的行为契约已被覆盖（条目可合并或拆分，数量不作硬性要求），
      新增测试全绿，288 个基线测试全绿。

---

## T2 — 目标地址校验改为严格模式

### 背景

`app.py:340-356` 的 `_validate_network_target` 现在是「只要有一个解析结果是公网就放行」：

```python
has_global = False
for entry in addresses:
    address = entry[4][0].split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        continue                     # 无法解析的条目被静默跳过
    if ip.is_global:
        has_global = True            # 有一个就够
if not has_global:
    raise ValueError("目标 URL 指向本机或私有网络")
```

攻击者控制的域名只要同时返回 `1.2.3.4` 和 `127.0.0.1` 即可通过校验；随后 gallery-dl
自己重新解析时可能连到私网地址。`server.allow_private_targets=False` 这道防线是可绕的。

### 前置依赖

无。

### 实现要求

**2.1 改为「任一非公网即拒绝」。**

```python
resolved_count = 0
for entry in addresses:
    address = entry[4][0].split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(address)
    except ValueError as exc:
        # 严格模式下不允许静默跳过无法识别的条目。
        raise ValueError("目标主机解析出无法识别的地址") from exc
    if not ip.is_global:
        raise ValueError(f"目标 URL 解析到非公网地址（IPv{ip.version}: {ip}），已拒绝")
    resolved_count += 1
if not resolved_count:
    raise ValueError("目标主机 DNS 未返回任何地址")
```

错误信息可以带 IP 与地址族（便于排障，IP 本身不敏感），但**不得**拼接完整 URL。

**2.2 加一个回退开关，防止误杀后无法自救。**

极小概率下会有合法 CDN 的 DNS 同时返回 Python 认为「非公网」的地址（6to4 `2002::/16`、
CGNAT `100.64.0.0/10` 等）。为了让用户不改代码就能自救：

- `config.py` `ServerSettings` 新增 `strict_target_dns: bool = True`；
- 从 `server.strict_target_dns` 读取，纳入 `public_dict()`；
- `_validate_network_target(url, allow_private, *, strict=True)` 增加参数，`strict=False`
  时退回旧的「有一个公网就放行」逻辑；
- 四个现有调用点（`_enqueue_task`、`run_source`、`_perform_crawl`、`proxy_probe`）统一传
  `strict=container.settings.server.strict_target_dns`；
- `AppSettings.validate()` 中：`strict_target_dns=False` 时向 stderr 打印一行醒目提示；
- `config.example.json` 与 `README.md` 的 `server` 区域各补一行，明确写「默认 true，
  仅在确认某个合法站点被误拒时才改为 false」。

**2.3 不要改 `allow_private_targets` 的短路。** 函数开头的 `if allow_private: return` 保持原样。

### 禁止事项

- 不要在这里实现「解析一次并把 IP 固定传给 gallery-dl」，那需要改 SNI/Host 处理，属后续议题。
- 不要改 hostname 层面的 `localhost` / `.local` 判断。
- 不要缓存 DNS 解析结果，缓存会引入新的 TOCTOU 面。

### 测试要求

扩充 `tests/test_api.py` 中现有的 `_validate_network_target` 测试：

1. `test_strict_rejects_mixed_global_and_loopback`：monkeypatch `socket.getaddrinfo` 返回
   `[公网 IPv4, 127.0.0.1]`，断言抛 `ValueError`（本任务核心回归）。
2. `test_strict_rejects_mixed_global_and_private_v6`：`[公网 IPv4, fd00::1]` 拒绝。
3. `test_strict_rejects_unparsable_entry`：返回非法地址字符串 拒绝。
4. `test_strict_allows_all_global`：`[公网 IPv4, 公网 IPv6]` 通过。
5. `test_non_strict_restores_legacy_behaviour`：`strict=False` 时混合结果通过。
6. `test_allow_private_short_circuits`：`allow_private=True` 时断言 `getaddrinfo` 未被调用。
7. `tests/test_config.py` 补 `strict_target_dns` 默认值与读取测试。

### 验收标准

- [x] B1 混合解析结果（公网 + 回环/私网）一律被拒绝。
- [x] B2 无法识别的解析条目不再被静默跳过。
- [x] B3 错误信息包含地址族与 IP，不包含完整目标 URL。
- [x] B4 `server.strict_target_dns` 默认 `true`，可从 config 读取，进入 `public_dict()`。
- [x] B5 `strict_target_dns=false` 时启动打印降级提示。
- [x] B6 `config.example.json` 与 `README.md` 都已补充说明。
- [x] B7 `allow_private_targets=True` 行为零变化。
- [x] B8 上述测试要求的行为契约已被覆盖（数量不作硬性要求），新增测试全绿，
      288 个基线测试全绿。

---

## T3 — 回环 Host 与 fetch metadata 守卫

### 背景

后端没有 `TrustedHostMiddleware`，没有 token，也没检查 fetch metadata（全项目 grep 零命中）。后果：

1. 用户浏览任意网页时，该网页可向无请求体的 POST 端点（`/tasks/{id}/cancel`、
   `/crawls/{id}/cancel`、`/crawls/{id}/review/start`、`/review/apply`）发起简单跳域请求。
   CORS 只阻止读响应，不阻止副作用。
2. 更严重的是 DNS rebinding：攻击者域名先解析到自己服务器、再 rebind 到 `127.0.0.1`，
   此时请求变成同源，**全部** API（含 `GET /api/v1/config`、代理源、授权状态）可读可写。
   而这个后端托管着 X / Pixiv / EH 的登录 Cookie。

### 前置依赖

无。

### 实现要求

**3.1 新增 `local_origin_guard` 中间件，作用于全部路径。**
包括 `/ui`、`/docs`、`/openapi.json`、`/healthz`、`/readyz`、`/api/v1/*`。
不得给任何路径开白名单——rebinding 同样可以先拉起 `/ui` 再从里面发同源请求。

**3.2 中间件必须处于最外层。** Starlette 的 `add_middleware` 使用
`user_middleware.insert(0, ...)`，建栈时 `reversed` 包裹，因此**最后添加的在最外层**。
所以本守卫必须在 `request_id_middleware` 之后声明。守卫自己负责在 403 响应上设
`X-Request-ID`（取请求头，缺失时用 `uuid4().hex`），保持响应形状一致。

**3.3 Host 允许集从 `settings.server` 推导（决策 D5，不提供额外白名单配置项）。**

```python
port = settings.server.port
_ALLOWED_HOSTS = frozenset({
    f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}",
    "127.0.0.1", "localhost", "[::1]",
})
```

匹配规则：取 `request.headers.get("host", "")`，`strip()` 后转小写，去掉主机名末尾的单个
`.`（`localhost.:8787` 也算合法），然后做集合包含判断。缺失或空 `Host` 一律拒绝。

**3.4 fetch metadata 判断。** 取 `Sec-Fetch-Site`：

- `cross-site` / `same-site` 拒绝（本服务只应有同源访问）；
- `same-origin` / `none` 放行；
- 头缺失放行（curl、`doctor.sh`、老浏览器都不发这个头，不能硬要求）。

**3.5 拒绝响应必须直接 `return JSONResponse(...)`，不要 `raise ApiError`。**
BaseHTTPMiddleware 里抛出的异常不会进入 `@app.exception_handler(ApiError)`。响应体：

```json
{"error": {"code": "forbidden_host",
           "message": "仅允许从本机回环地址访问",
           "details": null,
           "request_id": "..."}}
```

状态码 403。fetch metadata 拒绝用同样 403，code 为 `forbidden_cross_site`。
**消息不得回显客户端提交的 Host 值**（避免反射）。

**3.6 必须同步修正全部测试客户端。这是本任务最易遗漏的一步。**

`TestClient(app)` 默认 `base_url="http://testserver"`，会发出 `Host: testserver`，
加上守卫后**所有现有 API 测试会变 403**。需把下列位置全部改为显式传
`base_url=f"http://127.0.0.1:{port}"`（port 取对应测试 settings 的 `server.port`）：

- `tests/test_api.py:37`
- `tests/test_integration_local.py:42`、`:145`
- `tests/test_review.py:261`、`:322`、`:353`
- `tests/test_proxy_sources.py:399`、`:603`、`:757`

在 `tests/helpers.py` 新增 `local_test_client(app, settings)` 工厂函数统一处理。

### 禁止事项

- 不要新增 `server.allowed_hosts` 配置项（决策 D5 已明确不做）。
- 不要为了兼容测试而把 `testserver` 加进生产允许集。
- 不要动 `CORSMiddleware` 的现有行为与 `server.cors_origins` 语义。
- 不要引入任何 token / 会话 / 登录机制。

### 测试要求

新增 `tests/test_local_origin_guard.py`：

1. `test_allows_loopback_hosts`：`127.0.0.1:PORT`、`localhost:PORT`、`[::1]:PORT`、
   `localhost.:PORT` 均返回非 403。
2. `test_rejects_foreign_host`：`Host: evil.example.com` 403，code 为 `forbidden_host`。
3. `test_rejects_lan_host`：`Host: 192.168.1.5:PORT` 403。
4. `test_rejects_missing_host`。
5. `test_rejects_cross_site_fetch`：合法 Host + `Sec-Fetch-Site: cross-site` 403，
   code 为 `forbidden_cross_site`。
6. `test_allows_same_origin_and_none_fetch_site`。
7. `test_guard_covers_ui_and_docs`：`GET /ui/`、`GET /docs`、`GET /healthz` 在非法 Host 下均 403。
8. `test_forbidden_response_does_not_echo_host`。
9. `test_forbidden_response_has_request_id`。

### 验收标准

- [x] C1 守卫覆盖全部路径，无任何路径白名单。
- [x] C2 守卫处于中间件栈最外层（在 `request_id_middleware` 之后注册）。
- [x] C3 允许集从 `settings.server.port` 推导，未新增配置项。
- [x] C4 Host 匹配大小写不敏感、容忍末尾点、缺失即拒。
- [x] C5 `Sec-Fetch-Site` 为 `cross-site`/`same-site` 拒绝，其余（含缺失）放行。
- [x] C6 拒绝响应为 403 + 标准 error 包络，带 `X-Request-ID`，不回显 Host。
- [x] C7 上列 9 处 `TestClient` 全部改为回环 `base_url`，`helpers.py` 提供统一工厂。
- [x] C8 上述测试要求的行为契约已被覆盖（数量不作硬性要求），新增测试全绿，
      288 个基线测试全绿。
- [x] C9 `README.md` 的「本地网络与安全边界」小节补一条：仅接受回环 Host，
      反向代理/自定义域名访问不受支持（SSH 本地端口转发仍可用）。

---

## T4 — 任务日志批量异步落库

### 背景

`scheduler.py:237` 的日志回调是同步的：

```python
async def log(stream: str, line: str) -> None:
    self.db.append_log(task_id, attempt_id, stream, line)   # 同步，未 to_thread
```

`append_log` 走 `_transaction()` → `BEGIN IMMEDIATE` + INSERT + COMMIT，还要抢全局
`Database._lock`。 20 个并发下载、每个每秒几十行输出，就是每秒上千次串行化的写事务
压在事件循环上。

### 前置依赖

无。（与 T5/T6 同改 `database.py`，但触及的方法不同。先做 T4。）

### 实现要求

**4.1 新增 `gdl_backend/log_writer.py`，定义 `TaskLogWriter`。**

接口：

```python
class TaskLogWriter:
    def __init__(self, db: Database, *,
                 flush_interval: float = 0.2,
                 flush_rows: int = 64,
                 max_pending: int = 20000) -> None: ...
    async def start(self) -> None: ...
    async def stop(self) -> None: ...        # 内部先 flush 再退出
    def push(self, task_id: str, attempt_id: str | None,
             stream: str, line: str) -> None: ...   # 同步、非阻塞、不碰数据库
    async def flush(self) -> None: ...       # 等待当前缓冲全部落库
```

行为要求：

- `push` 将 `(task_id, attempt_id, ts, stream, line)` 追加到一个 `collections.deque`
  （`maxlen=max_pending`），并在达到 `flush_rows` 时 `set()` 一个 `asyncio.Event`；
- `ts` 必须在 `push` 时取 `time.time()`，**不能**等到 flush 时才取，否则日志时间戳会偏；
- `push` 不调用 `redact_text`（该工作已经在 `gallery.py` 的 `read_stream` 里做过一次）；
  但 `Database.append_logs_bulk` 内部仍需对每行做 `redact_text(line, limit=8000)`，
  保持与现有 `append_log` 一致的双重保险；
- 后台循环：`await asyncio.wait_for(event.wait(), timeout=flush_interval)` 超时或被唤醒
  即 flush；每次 flush 把队列里的行一次性取出，调
  `await asyncio.to_thread(self.db.append_logs_bulk, rows)`；
- **阴影处理**：`deque(maxlen=...)` 溢出时静默丢头部。必须自己计数：超限时自己
  `popleft()` 并累加 `dropped_count`，下一次 flush 时插入一行
  `因日志缓冲溢出已丢弃 N 行输出`（stream 为 `backend`）并归零；
- flush 失败（SQLite 异常）：记一次 `logging.warning`，**丢弃**这批行，继续循环。
  绝不得因为日志写入失败而使任务失败或让循环退出。
- 单个任务内部的日志顺序必须严格保持（单队列 FIFO 天然成立，不要改成按 task 分组并行写）。

**4.2 `Database.append_logs_bulk(rows)`。**

- 一个 `_transaction()`，`executemany` 插入全部行；
- 修剪：不再用 `random.random() < 0.01`。改成确定式——writer 维护
  `self._since_prune: dict[str, int]`，某个 `task_id` 自上次修剪后新增行数超过
  `max_logs_per_task // 4` 时，在**同一事务**里对该 task 执行现有的保留 N 条 DELETE
  并归零计数。这比概率修剪更可预测也更便宜。
- 保留原 `append_log(...)` 单行方法（其他调用点仍在用，例如 `scheduler` 的代理释放
  异常日志、托管授权失效日志），但它们也应改为走 writer，除非调用处不在事件循环上。

**4.3 `scheduler.py` 接入。**

- `TaskScheduler.__init__` 新增参数 `log_writer: TaskLogWriter`（由
  `ServiceContainer` 构造并传入）；`start()` 里 `await self.log_writer.start()`，
  `stop()` 里在 `gallery.stop_all()` 之后 `await self.log_writer.stop()`。
- `log()` 回调改为：

```python
async def log(stream: str, line: str) -> None:
    self.log_writer.push(task_id, attempt_id, stream, line)
    if stream == "stdout" and task is not None:
        artifact = self._artifact_from_output(line, task["output_dir"])
        if artifact is not None and artifact not in task_artifacts:
            task_artifacts.add(artifact)     # 必须保持同步！
            ...以下保持原样...
```

**关键不变量**：`task_artifacts` 集合必须仍在回调里同步填充。`scheduler` 的
「extraction_error + 有产物 → 升级为 extraction_partial 并重试」逻辑完全依赖它；
如果把整个回调挖到后台，部分成功的任务会被误判为终态失败，**造成漏图**。

- 在 `self.db.finish_attempt(...)` 之前插入 `await self.log_writer.flush()`，
  保证任务进入终态时 UI 看到的日志尾部是完整的。

**4.4 `app.py` 接线。** `ServiceContainer.__init__` 创建 `self.log_writer = TaskLogWriter(self.db)`
并传给 `TaskScheduler`。`ServiceContainer.stop()` 不需要额外处理（由 scheduler.stop 负责）。

### 禁止事项

- 不要把 `redact_text` 从 `gallery.py` 的 `read_stream` 里移除。
- 不要改 `gallery.py` 内存 `tail` deque（`maxlen=250`），错误分类依赖它。
- 不要把 `update_artifacts` 的 1 秒节流改成也进缓冲（它已经是节流的，且频率很低）。
- 不要引入 `queue.Queue` 等需要跳线程的结构；`push` 必须是纯内存操作。

### 测试要求

新增 `tests/test_log_writer.py`：

1. `test_flush_by_row_count`：push 64 行后无需等待 200ms 即已落库。
2. `test_flush_by_interval`：push 1 行，等待 > 200ms 后已落库。
3. `test_order_preserved`：push 500 行，flush 后 `get_logs` 返回顺序与 push 顺序一致。
4. `test_overflow_emits_marker`：`max_pending=10`，push 50 行，断言落库结果里有一条
   包含「已丢弃」的 `backend` 行，且总行数可控。
5. `test_bulk_insert_prunes_deterministically`：`max_logs_per_task=100`，push 500 行，
   flush 后该 task 的日志条数 <= 100 + 一个安全余量，且保留的是最新的。
6. `test_flush_failure_does_not_break_loop`：monkeypatch `append_logs_bulk` 抛异常一次，
   后续 push 仍能正常落库。
7. `test_stop_flushes_pending`。

在 `tests/test_scheduler.py` 补：

8. `test_artifacts_still_tracked_with_buffered_logs`：模拟一个输出多个文件路径、
   但退出码带 extraction 错误位的任务，断言最终分类仍为 `extraction_partial`
   且任务被重新排队（这是本任务最重要的回归测试）。
9. `test_logs_complete_when_task_reaches_terminal`：任务进入终态后立即读 `get_logs`，
   断言最后一行已在库里。

### 验收标准

- [x] D1 `scheduler` 的 `log()` 回调不再直接调用任何 `Database` 写方法。
- [x] D2 `task_artifacts.add(...)` 仍在回调里同步执行。
- [x] D3 flush 触发条件为 200ms 或 64 行，两者取先到（决策 D4）。
- [x] D4 缓冲溢出会产生一条可见的丢弃提示行，不静默丢数据。
- [x] D5 日志修剪改为确定式计数触发，不再用 `random.random()`。
- [x] D6 `finish_attempt` 之前有一次 `flush()`。
- [x] D7 flush 失败不会使任务失败也不会终止写入循环。
- [x] D8 `scheduler.stop()` 会 flush 并关闭 writer。
- [x] D9 上述测试要求的行为契约已被覆盖（数量不作硬性要求），其中
      `test_artifacts_still_tracked_with_buffered_logs` 是不可省略的核心回归；
      新增测试全绿，288 个基线测试全绿。

---

## T5 — SQLite 读写连接分离：基础设施 + 热读路径

### 背景

`Database` 只有一个连接（`self._conn`）加一把全局 `threading.RLock`，所以所有
`asyncio.to_thread(db.xxx)` 的并行化其实是假的——全部串行。既然已经开了 WAL，
就应该让读路径真正并发。这是后续 T8（批次并行）能不能兼现收益的前提。

### 前置依赖

建议在 T4 之后做，避开 `database.py` 的写路径冲突。

### 实现要求

**5.1 连接拆分。**

- `self._conn` 保留，改名语义为「**写**连接」；`self._lock` 只再保护写路径（`_transaction()`）。
- 新增 `self._reader_local = threading.local()` 与 `self._reader_registry: list[sqlite3.Connection]`
  （配一把独立的 `threading.Lock` 保护 registry）。
- 新增私有方法 `_reader() -> sqlite3.Connection`：当前线程首次调用时创建连接，
  参数与写连接一致（`timeout=30.0`、`isolation_level=None`、`check_same_thread=False`、
  `row_factory=sqlite3.Row`），并执行：
  ```sql
  PRAGMA busy_timeout=10000;
  PRAGMA foreign_keys=ON;
  PRAGMA query_only=ON;      -- 关键：误写会立即报错而不是静默损坏
  ```
  创建后登记到 registry。
- 新增 `@contextmanager _read()`：`yield self._reader()`，**不取任何锁**。
- `close()` 必须关闭写连接**与** registry 里的全部读连接，然后清空 registry，
  最后仍调 `secure_sqlite_files(self.path)`。
- `journal_mode=WAL` 是数据库级属性，读连接**不需要**重复设置。

**5.2 可见性铁律（必须写成代码注释放在 `_read()` 上方）。**

> 任何需要观察「当前未提交事务写入」的读，必须使用 `_transaction()` 产出的 `conn`，
> 绝不能调用基于 `_read()` 的公开方法。WAL 下读连接只能看到已提交快照。

具体需要审查的高危点（实现时逐个确认）：

- `create_task()` 末尾在 `_transaction()` 内部调了 `self.get_task(...)`。
  幂等命中分支读的是已提交行，改完仍然正确；但必须在代码里加注释说明这一点，
  防止以后有人把它改成读本事务内新建的行。
- `complete_task()` / `requeue_task()` / `request_cancel()` / `retry_task()` 末尾的
  `return self._task(conn.execute(...))` 必须继续用 `conn`，不得改成 `get_task()`。
- 全文搜 `with self._transaction() as conn:` 块内部是否还有其他对 `self.<公开方法>()` 的调用，
  逐个列入审计文档。

**5.3 本任务需转成 `_read()` 的方法（热路径，优先）：**

`ping`、`get_task`、`get_task_by_idempotency`、`list_tasks`、`queued_tasks`、
`get_logs`、`get_events`、`incomplete_processes`、`get_site_policy`、`list_site_policies`、
`get_crawl_batch`、`list_crawl_batches`、`list_crawl_tasks`、`active_crawl_batch_ids`、
`crawl_batch_cancel_requested`、`crawl_batch_task_count`、`crawl_address_task_count`、
`crawl_address_tasks`、`get_crawl_address_proxy_probe`、`task_crawl_batch_id`、
`get_crawl_review`、`list_crawl_review_groups`、`get_crawl_review_image`。

**5.4 产出审计文档 `gallery-dl-backend/docs/database-read-write-audit.md`。**

表格形式，一行一个 `Database` 公开方法，列：方法名 / 类型（读、写、读写混合）/
本轮是否已转 `_read()` / 未转的原因。T6 直接拿这份文档收尾。

### 禁止事项

- 不要把写路径也改成多连接（SQLite 只允许单写，多写连接只会制造 `SQLITE_BUSY`）。
- 不要去掉 `_transaction()` 的 `BEGIN IMMEDIATE`（它是写串行化的保障）。
- 不要改 `PRAGMA synchronous=NORMAL` / `journal_mode=WAL` 的现有取值。
- 不要引入第三方连接池库。

### 测试要求

在 `tests/test_database.py` 补：

1. `test_reader_connection_rejects_writes`：取 `_read()` 连接执行一次 `INSERT`，
   断言抛 `sqlite3.OperationalError`（`query_only`生效）。
2. `test_reader_is_per_thread`：两个线程各自 `_read()`，断言得到不同对象。
3. `test_reader_sees_committed_writes`：主线程写入并提交后，另一线程 `get_task` 能读到。
4. `test_concurrent_reads_are_not_serialized`：少量线程（例如 3 个）并发读，
   同时主线程写入；断言全部完成且无异常。**这是正确性烟雾测试，不是压力测试**：
   不要堆线程数与循环次数，也不做任何计时断言。
5. `test_close_closes_all_reader_connections`：多线程各建读连接后 `close()`，
   断言再用任一连接报 `ProgrammingError`。
6. `test_create_task_idempotent_hit_returns_full_shape`：同一 idempotency key 两次
   `create_task`，第二次返回值必须包含 `latest_attempt` 与 `lease` 键且不为 `None`
   （防止回归成返回 `None`）。

### 验收标准

- [x] E1 读连接为 `threading.local()` 按线程创建，并开了 `PRAGMA query_only=ON`。
- [x] E2 `_read()` 不取任何锁；`_transaction()` 仍取 `self._lock` 且仍 `BEGIN IMMEDIATE`。
- [x] E3 `close()` 关闭全部读连接。
- [x] E4 §5.3 列出的 23 个方法已全部转为 `_read()`。
- [x] E5 `_read()` 上方有可见性铁律注释；`create_task` 内部调用处有解释注释。
- [x] E6 已产出 `docs/database-read-write-audit.md`，覆盖全部公开方法。
- [x] E7 上述测试要求的行为契约已被覆盖（数量不作硬性要求），新增测试全绿，
      288 个基线测试全绿。

---

## T6 — SQLite 读写分离：剩余只读方法迁移与审计收尾

### 前置依赖

**T5 必须已验收通过。**

### 实现要求

**6.1** 按 `docs/database-read-write-audit.md` 把剩下标记为「纯读、可转」的方法
全部从 `with self._lock:` 改为 `with self._read() as conn:`，并把审计表对应行标为已完成。

**6.2** 对标记为「不可转」的方法，在方法上方加一行中文注释说明不可转的原因
（例如「需要在同一写事务内读取未提交状态」）。

**6.3 新增一个结构性回归测试，防止以后倒退。**

在 `tests/test_database.py` 新增 `test_read_methods_do_not_take_write_lock`：
用 `inspect.getsource(Database.<method>)` 逐个检查审计表中标为「纯读」的方法，
断言源码里不包含 `self._lock`；允许的例外名单以模块级 `frozenset` 的形式写在
测试文件里，新增例外必须同时改测试。

**6.4** 把 `ordered_crawl.py` / `scheduler.py` / `review.py` 中仍在事件循环上同步调用的
**读**方法盘一遍，列入审计文档的一个新小节「仍在事件循环上的同步读」，
注明每个的典型数据量。**本任务不要改它们**，只产出清单（T8 会处理其中的热点）。

### 禁止事项

- 不要在本任务里附带任何行为变更。这是一个纯重构任务，任何 API 响应字段、
  状态机转换、默认值都不得变。
- 不要为了让测试通过而把方法拆成新名字。

### 验收标准

- [x] F1 审计表中标为「可转」的方法 100% 已转，无遗留。
- [x] F2 不可转的方法均有中文原因注释。
- [x] F3 `test_read_methods_do_not_take_write_lock` 存在且通过。
- [x] F4 审计文档新增「仍在事件循环上的同步读」小节。
- [x] F5 本任务零行为变更（diff 中不出现新的条件分支、新字段、新默认值）。
- [x] F6 288 个基线测试全绿，加上 T5 新增的测试也全绿。

---

## T7 — 代理探活按目标主机缓存

### 背景

`ordered_crawl.py` 的 `_probe_address_policy` 对**每一个地址**都把**全部节点**拿去探活一次
目标站点首页（`probe_workers` 默认 32，实际节点可能 45+）。一个 50 地址的 danbooru
批次，光探活就是 50 × 45 ≈ 2250 次对 `danbooru.donmai.us/` 的请求。

另一个关键问题：`ProxyPoolAdapter.probe()` 持有 `_lifecycle_lock`，一次全量探活
（32 worker × 10s 超时）可能十几秒。因此**不先解决探活，T8 的批次并行收益会被
探活排队吃掉大半**。

### 前置依赖

无，但**必须在 T8 之前完成**。

### 实现要求

**7.1 新增配置 `proxy.probe_cache_ttl_seconds: float = 600.0`（决策 D3）。**
`AppSettings.validate()` 校验 `>= 0`，`0` 表示禁用缓存（退回当前行为）。
同步补 `config.example.json` 与 `README.md` 的 `proxy` 区域。

**7.2 `ProxyPoolAdapter` 新增缓存。**

- 新增 `self._probe_cache: dict[tuple[str, str, int], tuple[float, dict[str, Any]]]`，
  key 为 `(scheme, hostname.lower(), port)`，由一个静态方法 `_probe_cache_key(url)` 产出；
  value 为 `(monotonic_timestamp, probe_result)`。缓存读写统一在 `self._lock` 下。
- **key 不得包含 path**：`https://danbooru.donmai.us/` 与
  `https://danbooru.donmai.us/posts` 必须命中同一条，否则缓存基本失效。

**7.3 新增 `probe_for_target(target_url: str) -> dict[str, Any]`。**

```
if ttl > 0:
    在 self._lock 下查缓存；命中且 age < ttl -> 直接返回副本
                                     （额外带 "cached": True, "age_seconds": age）
                                     不取 _lifecycle_lock、不发任何网络请求
with self._lifecycle_lock:
    再查一次缓存（double-checked，避免排队期间已有人探完）
    result = self.probe(target_url=target_url)
    存入缓存，返回 result（"cached": False）
```

**7.4 失效策略（必须完整实现，否则会把已死节点分配给任务）。**

1. `start()`、`reload()`、`stop()`、`_set_records()` 里全量清空 `_probe_cache`；
2. `release(task_id, proxy_fault=True, ...)` 时：从**每一条**缓存项的
   `results` 列表里把该 `node_id` 的条目改为 `healthy=False`，并重算该项的 `healthy` 计数；
3. 经步骤 2 后 `healthy` 降到 0 的缓存项**直接删除**，使下一个地址重新探活；
4. `_probe_endpoint` 单节点探活失败时同样执行步骤 2、3。

**7.5 手动探活必须绕过缓存读。**

- `POST /api/v1/proxy/probe`（用户在 PROXY.CPL 主动点的）仍调 `probe()`，
  **不读**缓存，但结果写入缓存；
- `_proxy_health_loop` 同理（它打的是 `settings.probe_url`，与站点 key 不冲突）。

**7.6 `status()` 暴露缓存可观测数据。** 新增
`"probe_cache": {"entries": n, "ttl_seconds": ttl}`，供 DIAG.EXE 展示。
**不得**把缓存的 key（含主机名）放进去——那会泄露用户在抓哪些站。

**7.7 `ordered_crawl.py` 切换调用点。**
`_probe_address_policy` 中 `await asyncio.to_thread(self.proxy.probe, target_url=target)`
改为 `await asyncio.to_thread(self.proxy.probe_for_target, target)`。
`save_crawl_address_proxy_probe` 仍照常记录（包括命中缓存的情况），
这样每个地址仍有自己的 `allowed_proxy_ids` 快照。

### 禁止事项

- 不要改 `probe_workers`、`probe_timeout_seconds`、`fail_cooldown_seconds` 的默认值。
- 不要改 `NativeProxyPool` 的租约/冷却逻辑。
- 不要把缓存持久化到磁盘（重启后必须重新探活）。
- 不要因为缓存就跳过 `proxy_mode == "required"` 时「无健康节点则报错」的判断。

### 测试要求

在 `tests/test_proxy_core.py` 或新增 `tests/test_proxy_probe_cache.py`：

1. `test_second_address_same_host_hits_cache`：两次 `probe_for_target` 同主机，
   断言底层 `_probe_endpoint` 只被调用了第一轮的数量，第二次返回 `cached=True`。
2. `test_cache_key_ignores_path`：`https://h/` 与 `https://h/posts` 命中同一条。
3. `test_cache_key_separates_port_and_scheme`。
4. `test_ttl_expiry_triggers_real_probe`：把 TTL 设成 0.01s，等待后再调会真探。
5. `test_ttl_zero_disables_cache`。
6. `test_proxy_fault_release_marks_node_unhealthy_in_cache`：缓存有 3 个健康节点，
   `release(proxy_fault=True)` 其中一个后再读缓存，断言该节点 `healthy=False`
   且 `healthy` 计数变成 2。
7. `test_cache_entry_removed_when_no_healthy_node_left`：逐个 fault 到 0，断言条目被删，
   下一次调用会真探。
8. `test_start_and_reload_clear_cache`。
9. `test_manual_probe_endpoint_bypasses_cache`：通过 API `POST /proxy/probe` 断言真探。
10. `test_status_reports_cache_entries_without_hostnames`：`status()["probe_cache"]`
    存在且不含任何主机名字符串。
11. `tests/test_config.py` 补 `probe_cache_ttl_seconds` 默认值与负值报错。

### 验收标准

- [x] G1 `proxy.probe_cache_ttl_seconds` 默认 600.0，可配置，`0` 禁用。
- [x] G2 缓存 key 为 `(scheme, host, port)`，不含 path。
- [x] G3 缓存命中路径**不取** `_lifecycle_lock`、**不发**网络请求。
- [x] G4 `start`/`reload`/`stop`/`_set_records` 均清空缓存。
- [x] G5 `proxy_fault` 释放与单节点探活失败均会降级缓存中的对应节点。
- [x] G6 缓存项健康数降至 0 时被删除。
- [x] G7 `POST /api/v1/proxy/probe` 仍强制真探。
- [x] G8 `status()["probe_cache"]` 不泄露主机名。
- [x] G9 `ordered_crawl._probe_address_policy` 已切换到 `probe_for_target`。
- [x] G10 上述测试要求的行为契约已被覆盖（数量不作硬性要求），新增测试全绿，
      288 个基线测试全绿。

---

## T8 — 批次级并行（4 并行 + 同站发现串行）

### 背景

`OrderedCrawlManager._loop` 里 `run_once()` 顺序遍历所有活跃批次，而 `_activate_address`
会 `await` 完整的发现 + 规划（可能几分钟）。设计意图是「批次内地址串行」，
但实现上变成了「**所有批次全局串行**」——一个批次在做 EH 画廊发现时，
另一个批次连第一个地址都启动不了。

### 前置依赖

**T7 必须已验收通过**（否则探活持 `_lifecycle_lock` 会把并行收益吃掉）。
建议 T9 也先做完（两者同改 `ordered_crawl.py` 但不同函数；T9 更局部）。

### 实现要求

**8.1 新增配置 `scheduler.max_concurrent_batches: int = 4`（决策 D1）。**
`AppSettings.validate()` 校验 `1 <= v <= 16`。同步补 `config.example.json` 与 `README.md`。

**8.2 `_loop` 拆成「监督循环 + 每批次一个 Task」。**

- 新增 `self._batch_tasks: dict[str, asyncio.Task]` 与
  `self._batch_wakes: dict[str, asyncio.Event]`。
- `_supervisor_loop()`：每 `poll_interval` 读一次 `active_crawl_batch_ids()`；
  对不在 `_batch_tasks` 中的 id，在 `len(self._batch_tasks) < max_concurrent_batches`
  时创建 `asyncio.create_task(self._batch_loop(batch_id), name=f"ordered-crawl-{batch_id}")`。
  超额的 id 本轮跳过，下一轮再试。
- `_batch_loop(batch_id)`：循环 `await self._tick_batch(batch_id)`，直到该批次不再活跃
  （`crawl_batch_tick_view` 返回 `None` 或 status 已终态），然后从 `_batch_tasks` /
  `_batch_wakes` 里移除自己。循环等待用自己的 `asyncio.Event`，超时 `poll_interval`。
- **异常隔离**：单个 `_batch_loop` 内部需有 `except Exception: await asyncio.sleep(poll_interval)`
  的容错，不得因一个批次报错而影响其他批次或监督循环。
- `notify()` 必须同时唤醒监督循环和**全部** `_batch_wakes`。
- `stop()` 必须：先置 `_stopping`，再 cancel 监督循环，然后 cancel 全部批次 Task 并
  `await asyncio.gather(..., return_exceptions=True)`。`_activate_address` 里现有的
  `except asyncio.CancelledError` 分支（保留已 link 的任务、标记 running）必须保持不变。

**8.3 同站发现串行（决策 D2）。**

- 新增 `self._site_planning_locks: dict[str, asyncio.Lock]`（按需创建，不预先列举站点）。
- 锁的覆盖范围：**仅** `_probe_address_policy(...)` 与 `_plan_address(...)` 这两步。
- 锁**不要**覆盖后面的入队循环（那是纯数据库操作、不碰站点）。否则一个 5000 单元的
  入队会白白堵住另一个批次的发现。
- 锁的 key 用 `address["site"]`。`begin_crawl_address_planning` 已经防住了同一地址
  被重复规划，所以不需额外的地址级锁。

**8.4 新增轻量轮询查询，取代每次 tick 的 `get_crawl_batch()`。**

`_tick_batch` 现在每 0.5 秒调一次 `get_crawl_batch()`，而后者会加载全部地址 +
LEFT JOIN 代理探活 + review + 在 Python 侧重新分组。批次并行后这个开销乘 4。

新增 `Database.crawl_batch_tick_view(batch_id) -> dict | None`，只返回：
`{id, status, cancel_requested, max_tasks, concurrency, output_dir}`，走 `_read()`。
`_tick_batch` 与 `_activate_address` 内部的**轮询型**读全部改用它。
`get_crawl_batch()` 保留给 HTTP handler（`GET /crawls/{id}` 等），行为不变。

注意：`_activate_address` 开头传进来的 `batch` 参数仍需包含 `max_tasks`、
`concurrency`、`output_dir`、`id`、`cancel_requested`，新视图已覆盖。

**8.5 `status()` 扩展。** 返回：

```python
{
    "running": ...,
    "active_batches": len(self.db.active_crawl_batch_ids()),
    "running_batch_loops": len(self._batch_tasks),
    "max_concurrent_batches": settings.max_concurrent_batches,
    "site_planning_locked": sorted(site for site, lock in self._site_planning_locks.items()
                                   if lock.locked()),
    "execution_order": "source_then_address",
    "address_parallelism": "media_tasks",
}
```

保留现有键（`execution_order`、`address_parallelism`）不变，以免前端 DIAG 与
`/readyz` 快照回归。

### 禁止事项

- 不要改 `scheduler.max_concurrent_tasks` 默认值，也不要改
  `active_sites[site] >= policy.max_concurrency` 基于 `self._active` 全局计数的语义。
  这是「不会因为批次并行而加大下载并发」的唯一保障。
- 不要把「批次内地址串行」改成并行。一个批次仍然一次只推进一个地址。
- 不要把 `DedupReviewManager` 改成并行分析。
- 不要引入跨批次的共享去重或共享任务去重。

### 测试要求

在 `tests/test_crawl.py` 或新增 `tests/test_ordered_crawl_concurrency.py`：

1. `test_two_batches_different_sites_overlap`：两个批次分别是 danbooru 与 exhentai，
   用一个带 `asyncio.Event` 的假 discovery 记录进入/退出时间，断言两者发现区间重叠。
2. `test_two_batches_same_site_serialize`：两个批次都是 danbooru，断言发现区间**不**重叠
   （这是风控相关的核心断言）。
3. `test_batch_loop_count_capped`：创建 8 个活跃批次，`max_concurrent_batches=4`，
   断言 `len(_batch_tasks) <= 4`。
4. `test_site_download_concurrency_still_capped`：4 个 danbooru 批次并行，
   `policy.max_concurrency=2`，断言全局同时 running 的 danbooru 任务数峰值 <= 2
   （这是「不增加下载并发」的回归断言）。
5. `test_one_batch_exception_does_not_stop_others`。
6. `test_stop_cancels_all_batch_loops`：断言 `stop()` 后 `_batch_tasks` 为空且无
   “Task was destroyed but it is pending” 警告。
7. `test_notify_wakes_all_batch_loops`。
8. `test_tick_view_used_in_poll_path`：monkeypatch `get_crawl_batch` 为抛异常，
   断言轮询仍能正常推进（证明轮询路径已不依赖它）。
9. `tests/test_config.py` 补 `max_concurrent_batches` 默认值与越界报错。

### 验收标准

- [x] H1 `scheduler.max_concurrent_batches` 默认 4，校验 1..16。
- [x] H2 每个活跃批次一个独立 `asyncio.Task`，监督循环只负责投放与回收。
- [x] H3 同一 site 的 `_probe_address_policy` + `_plan_address` 串行；不同 site 并行。
- [x] H4 站点锁不覆盖入队循环。
- [x] H5 单批次异常不影响其他批次与监督循环。
- [x] H6 `stop()` 完整 cancel 并 await 所有批次 Task；`CancelledError` 分支行为未变。
- [x] H7 `notify()` 唤醒监督循环与全部批次循环。
- [x] H8 轮询路径已改用 `crawl_batch_tick_view`，`get_crawl_batch` 仅用于 HTTP。
- [x] H9 `status()` 保留原有键并新增 3 个并行可观测键。
- [x] H10 测试 4（站点下载并发上限）与测试 2（同站发现串行）必须通过。
- [x] H11 上述测试要求的行为契约已被覆盖（数量不作硬性要求），其中同站发现串行与
      站点下载并发上限两条不可省略；新增测试全绿，288 个基线测试全绿。

---

## T9 — 地址规划改为分块事务 + 主动让出

### 背景

`ordered_crawl.py` `_activate_address` 的入队循环，**每个 media unit** 都要做：

1. `self.db.crawl_batch_cancel_requested(...)` 一次读；
2. `self._enqueue(...)` → `_enqueue_task` → `create_task` 一个写事务，
   且内部还有一次 `await asyncio.to_thread(container.resolver.resolve, url)` 线程跳转；
3. `self.db.link_crawl_task(...)` 另一个写事务。

`max_tasks` 上千时就是几千次事务 + 几千次线程跳转在事件循环上连续跑完，
期间整个后端无响应。另外 create 与 link 分两事务，进程在中间死掉会留下孤儿任务。

### 前置依赖

无（建议在 T8 之前）。

### 实现要求

**9.1 新增 `Database.create_crawl_media_tasks(...)`，一个事务完成一整块。**

签名建议：

```python
def create_crawl_media_tasks(
    self,
    address_id: str,
    items: list[dict[str, Any]],   # 每项含 task 字段 + idempotency_key +
                                  # sequence_no + source_key + source_url
) -> list[dict[str, Any]]:        # 返回每项的 {"task_id": ..., "created": bool}
```

实现要点：

- 单个 `_transaction()` 内完成全块：逐项 `INSERT INTO tasks ... ON CONFLICT(idempotency_key)
  DO NOTHING`，然后回读实际 `task_id`（命中已存在则取旧 id、`created=False`）；
- 同事务内写 `crawl_address_tasks`（保留现有 `link_crawl_task` 的完整语义，包括
  `UNIQUE(address_id, sequence_no)` 的冲突处理方式）与 `crawl_task_source_keys`；
- 同事务内写入对应的 `queued` 事件（与现有 `create_task` 一致）；
- **实现前必须先阅读现有的 `create_task` 与 `link_crawl_task` 源码，逐字段比对，
  保证新方法写入的列与默认值完全一致**。不得丢字段、不得改默认值。
- 保留旧的 `create_task` 与 `link_crawl_task`（单任务 API `POST /tasks` 仍在用）。

**9.2 `_activate_address` 入队循环改为分块。**

- 块大小常量 `_ENQUEUE_CHUNK_SIZE = 50`（模块级，不进配置）。
- 每块流程：
  1. `crawl_batch_cancel_requested(batch_id)` 检查一次（**整块一次**，不是每 unit 一次）；
  2. 把本块全部 URL 的 extractor 解析放进**一次** `asyncio.to_thread`，而不是每 unit 一次
     （现在每 unit 一次 `to_thread(resolver.resolve)`，5000 unit = 5000 次线程跳转）；
  3. 调 `create_crawl_media_tasks` 一次写入本块；
  4. 把返回的 task_id 追加到 `linked_tasks`；
  5. `await asyncio.sleep(0)` 主动让出一次。
- 块内任何异常 → 整块事务回滚（这比现在的「create 完了但 link 失败」更安全），
  异常继续向外抛，由已有的 `except Exception` / `except asyncio.CancelledError`
  处理分支接手。

**9.3 `_enqueue_task` 需提供一个可复用的「只构造不写库」路径。**

在 `app.py` 新增一个内部函数，把 `_enqueue_task` 中「校验 + 算出 `output_dir` /
`policy` / `cookies` / `config_file` / `credentials_ref` / `site` / `max_attempts`」的部分
抽出成 `_build_task_row(body, site_info, container, ...) -> dict`，
然后：

- `_enqueue_task` 单任务路径继续用它 + `db.create_task`（行为不变）；
- `ordered_crawls` 的新批量入队回调用它构造整块 rows，再一次写入。

`OrderedCrawlManager.set_enqueue` 的回调类型改为批量版：

```python
EnqueueBatch = Callable[
    [list[TaskCreate], list[str], int],   # bodies, idempotency_keys, concurrency
    Awaitable[list[dict]],                # 每项 {"task_id": ..., "created": bool}
]
```

**保持不变的语义**：`network_validated=True`（地址已在 `_perform_crawl` 验过）、
`notify=False`（由 `_activate_address` 末尾统一 `scheduler.notify()`）、
`concurrency_override=batch["concurrency"]` 与 `max_concurrent_tasks` 取 min。

### 禁止事项

- 不要改幂等键的生成规则（`f"crawl:{batch_id}:{address_id}:{digest[:48]}"`）。
  改了会让重规划时重复创建任务，直接造成重复下载。
- 不要改 `_deduplicate` 的 digest 计算方式。
- 不要把 `_ENQUEUE_CHUNK_SIZE` 做成配置项。
- 不要跳过 `container.gallery.validate_args` 等任何现有校验（可以批量做，不能不做）。

### 测试要求

1. `test_chunked_enqueue_creates_same_tasks_as_before`：预先用旧路径（可在测试里直接
   逐个 `create_task`+`link_crawl_task`）产生一组预期，再用新批量路径跑一次，
   逐字段比对 `tasks` 与 `crawl_address_tasks` 与 `crawl_task_source_keys` 三张表。
2. `test_chunk_rollback_on_failure`：让第 2 块中间报错，断言第 2 块**一个任务都没落库**
   （第 1 块已提交则保留）。
3. `test_idempotent_replan_creates_no_duplicates`：同一地址规划两次，断言 task 总数不增，
   且第二次全部 `created=False`。
4. `test_resolver_called_once_per_chunk`：统计 `to_thread` 包裹的解析函数调用次数，
   120 个 unit 时应为 3 次（chunk=50）而不是 120 次。
5. `test_cancel_between_chunks_stops_enqueue`：第 1 块后置 cancel_requested，
   断言后续块不再创建且已创建的被 `cancel_linked()` 取消。
6. `test_event_loop_yields_between_chunks`：在规划 200 unit 期间并发跑一个
   `asyncio.sleep(0)` 计数循环，断言它至少被调度 4 次（证明有让出）。

### 验收标准

- [x] I1 `create_crawl_media_tasks` 存在，单事务完成 tasks + 链接 + source_keys + 事件。
- [x] I2 写入列与默认值与旧路径逐字段一致（由测试 1 保证）。
- [x] I3 `_ENQUEUE_CHUNK_SIZE = 50`，每块一次 cancel 检查、一次解析 `to_thread`、一次写入、
      一次 `await asyncio.sleep(0)`。
- [x] I4 幂等键生成规则与 `_deduplicate` 未变。
- [x] I5 块内失败整块回滚。
- [x] I6 所有现有参数校验仍然执行。
- [x] I7 上述测试要求的行为契约已被覆盖（数量不作硬性要求），新增测试全绿，
      288 个基线测试全绿。

---

## T10 — 五个小缺陷收尾

### 前置依赖

无。可以在 T1–T3 之后任意时机插入。

### 实现要求

**10.1 `review.py:123` 的 `NoneType` 下标。**

```python
self.db.replace_crawl_review_manifest(batch_id, manifest, log_path=log_path)
if self.db.get_crawl_review(batch_id)["status"] == "auto_applying":   # 可能是 None
```

批次被并发删除时 `get_crawl_review` 返回 `None`，直接 `TypeError`，被外层
`except Exception` 兑住后给用户一条误导性的 `TypeError`。改为：

```python
review = self.db.get_crawl_review(batch_id)
if review is not None and review["status"] == "auto_applying":
    ...
```

**10.2 `review.py:232` `_log_tail` 把整个日志读进内存。**

现在 `data = path.read_bytes()` 后取 `data[-4000:]`。一次大目录去重分析的日志可能上百 MB。
改为：

```python
with path.open("rb") as handle:
    handle.seek(0, os.SEEK_END)
    size = handle.tell()
    handle.seek(max(0, size - limit))
    data = handle.read(limit)
```

包在 `try/except OSError: return ""` 里，保持现有容错行为。注意文件小于 `limit` 的情况。

**10.3 required 代理获取失败被误分类为 `backend_error`。**

`scheduler._execute` 中 `proxy_mode == "required"` 时，`acquire()` 的非
`ProxyPoolUnavailable` 异常会 `raise` 到最外层的 `except Exception`，被归为
`backend_error`。用户在 TASKMGR 里看到的是「后端错误」而不是「代理不可用」。

改为在 `except Exception as exc:` 分支内（即现有的
`if proxy_mode == "required": raise` 位置）改成：

```python
if proxy_mode == "required":
    decision = FailureDecision(
        "proxy_unavailable", True, True,
        f"required 模式下代理租约获取失败：{redact_text(exc, limit=500)}",
    )
    await log("backend", decision.message)
    raise _ExecutionFinished
```

`retryable=True`（与现有的「无健康节点」分支一致），`proxy_fault=True`。
**不要**动 `ProxyPoolUnavailable` 分支（它必须保持 `retryable=False` 的终止语义）。

**10.4 凭证失效时任务静默滞留。**

`_dispatch_loop` 里 `credential_validator` 返回 False 就 `continue`，任务永远停在
`queued`，**不写 event、不写日志、状态不变**。用户视角就是「任务卡住但什么都没说」。

改法：

- `TaskScheduler` 新增 `self._credential_blocked: set[str]`；
- 某任务首次因凭证被跳过时，写一条 `task_events`（`event_type="credentials_unavailable"`，
  payload 含 `site`），并把 `last_error_class` 置为 `credentials_unavailable`、
  `last_error` 置为「站点托管授权已失效，等待在 VAULT.CPL 重新授权」；
  然后把 task_id 加入 `_credential_blocked`；
- 后续轮询发现该 task_id 已在集合里就安静跳过（不重复写）；
- 某任务不再被跳过（凭证恢复）或已不在 queued 列表中时，从集合移除；
- **状态绝不能改**（仍为 `queued`），也不能消耗 attempt 次数。重新授权后必须能自动继续。
- 新增一个 `Database` 方法写这条提示（一个事务同时写 event 与两个 `last_error*` 列）。

**10.5 队列窗口 200 导致的站点饥饿。**

`queued_tasks(limit=200)` 取前 200 条，若这 200 条全被同站 `max_concurrency` 挡住，
即使还有全局容量，第 201 条之后的其他站点任务也不会被派发。

改法：

- `queued_tasks` 新增参数 `exclude_sites: set[str] | None = None`，在 SQL 里用
  `AND site NOT IN (...)`（参数个数上限取 64，超出则只用前 64 个）；
- `_dispatch_loop` 在一轮扫完后，若 `capacity > 0` 且本轮有站点因达到
  `max_concurrency` 而被跳过，则最多再查 **2 次**（共 3 轮）`queued_tasks(200,
  exclude_sites=已饱和站点)`，直到 capacity 耗尽或无新任务；
- 轮数上限写成模块级常量 `_DISPATCH_REFILL_ROUNDS = 2`。

### 禁止事项

- 10.4 不得把任务改成 `failed`。用户重新授权后必须能自动继续跑。
- 10.5 不得提高 `limit` 默认值（200），也不得取消 `ORDER BY priority DESC, created_at ASC`。
- 10.3 不得修改 `classify_result` 或 `FailureDecision` 的字段定义。

### 测试要求

1. `test_review_handles_missing_review_row`（`tests/test_review.py`）。
2. `test_log_tail_reads_only_tail`：写一个明显大于 `limit` 的日志（几十 KB 就够了，
   不需要造 MB 级文件），断言返回长度 <= 4000 且内容为尾部；
   另测一个远小于 `limit` 的文件仍能完整返回。
3. `test_required_proxy_acquire_failure_classified_as_proxy_unavailable`（`tests/test_scheduler.py`）。
4. `test_proxy_pool_unavailable_still_terminal`：回归保护，确认 10.3 没把终止语义改坏。
5. `test_credential_blocked_task_emits_event_once`：进 5 轮调度，断言 event 只有 1 条、
   `last_error_class == "credentials_unavailable"`、任务仍为 `queued`、`attempt_count` 仍为 0。
6. `test_credential_recovery_resumes_task`：凭证恢复后任务能被正常 claim。
7. `test_dispatch_refills_across_sites`：造略多于查询窗口（> 200）的 danbooru 排队任务
   （`max_concurrency=1`）+ 1 个 exhentai 任务排在最后，断言 exhentai 任务在同一轮
   调度内被派发（这是本项的核心断言）。行数必须超过 200，否则测不到饥饿；
   但不要造得更多，也不要给这些行造真实的 attempt / 日志数据。
8. `test_exclude_sites_caps_parameter_count`：传 100 个站点时不报错。

### 验收标准

- [x] J1 `review.py` 的 `get_crawl_review` 返回值已做 `None` 保护。
- [x] J2 `_log_tail` 使用 `seek`，不再全文读取；小文件行为正确。
- [x] J3 required 模式 acquire 异常分类为 `proxy_unavailable`，`ProxyPoolUnavailable`
      仍为不可重试终态。
- [x] J4 凭证被限任务有一条可见 event + `last_error`，且不重复写。
- [x] J5 凭证被限任务状态仍为 `queued`，`attempt_count` 未增长，恢复后可自动继续。
- [x] J6 调度循环最多额外补抽 2 轮，不同站点不再互相饥饿。
- [x] J7 上述测试要求的行为契约已被覆盖（数量不作硬性要求），新增测试全绿，
      288 个基线测试全绿。

---

## 前置说明：T11–T14 的共同背景（派发时附带）

当前 WebUI 是一个「穿着桌面系统外衣的单页应用」：`webui/index.html` 里只有
**一个** `.application-window`、**一个** taskbar 按钮（`data-task-window`），
`core/window-manager.js`（197 行）只管理这一个实例。结果是最小化/最大化/关闭、
START 菜单、`CRAWL.EXE` 命名、`C:\IMAGEWEAVE\...` 标题栏全部存在，
但**永远只能同时看一个应用**——桌面隐喻真正的价值（CRAWL 与 TASKMGR 并排、
边审核去重边盯进度）一个都没实现。

决策 D6：把隐喻做真。T11–T14 是一条完整链，**不得跳序**；每一步完成后
界面都必须仍然可用（可以功能不完整，但不能白屏）。

前端测试入口：`tests/webui_modules.test.mjs`（Node `--test`，由
`tests/test_webui_modules.py` 调起）。新增的纯逻辑测试写到这个文件。
`tests/test_webui_modules.py` 里还有一个静态安全边界检查（逐模块白名单 API 端点），
改动应用模块时必须同步维护它。

---

## T11 — 前端状态层：单窗口视图 → 窗口栈

### 前置依赖

无（但建议在后端 T1–T10 完成后再动前端）。

### 实现要求

**11.1 `core/store.js` 状态形状改造。**

现有 `state.ui` 是 `{ windowState, windowVisibility, ... }` 加一个当前 appId。新形状：

```js
state.ui = {
  windows: [
    { appId, windowState: "normal" | "maximized" | "minimized",
      rect: { x, y, w, h }, zIndex },
  ],
  focusedAppId: string | null,
}
```

关键规则：

- **一个 appId 最多一个窗口**。打开已开的应用 = 聚焦它，不创建第二个。
  这一条是硬约束：重复的 REVIEW.EXE 会把轮询和文件移动逻辑翻倍，因此 `appId`
  直接当窗口主键，不引入单独的 windowId。
- `zIndex` 不存绝对数，而是由 `windows` 数组顺序推导（数组尾部 = 最上层），
  避免 z 值无限增长。`focusedAppId` 必须始终等于数组最后一个非 minimized 窗口。
- 全部窗口都 minimized 时 `focusedAppId` 为 `null`。

**11.2 新增/改造 actions。**

- `windowOpened(appId)`：不存在则追加并聚焦；已存在则提到数组尾部、
  `windowState` 从 `minimized` 恢复为 `normal`、聚焦。
- `windowClosed(appId)`、`windowFocused(appId)`、`windowMoved(appId, rect)`、
  `windowStateChanged(appId, windowState)`。
- 所有 action 必须沿用现有的严格校验风格：非法 appId / windowState / rect 一律
  `throw new TypeError("...")`（与现有 `WINDOW_STATES.has(...)` 判断一致）。
- `rect` 校验：`x/y/w/h` 必须是有限数；`w >= 360`、`h >= 240`。

**11.3 保留兼容选择器，降低 T12 的改动面。**

`selectors.windowView` 保留，改为推导「当前聚焦窗口」的视图（形状与现在一致：
`{ appId, windowState, visibility }`），使未迁移的调用方在 T11 后仍能跑。
新增 `selectors.windowStack` 返回完整数组。

**11.4 路由与布局持久化分工。**

- `core/router.js`：hash 只反映**聚焦窗口**（仍为 `#/crawl` 这种形式）。
  **不要**把打开集序列到 URL 里——那会把内部布局泄露到浏览器历史与分享链接里，
  也让 `parseHashRoute` 的白名单校验变复杂。
- 打开集与 rect 存在 localStorage，走现有 `core/storage.js`，key 带版本号
  （例如 `imageweave.window-layout.v1`）。
- 加载时必须做**完整校验与修复**：
  1. 未知 appId 丢弃；
  2. `availability !== "ready"` 的应用丢弃；
  3. rect 超出当前视口则 clamp 回可见区（至少 32px 在视口内）；
  4. 解析失败/结构非法 → 静默回退到默认布局，不抛错、不白屏。

### 禁止事项

- 不要在本任务里改 `window-manager.js` 的 DOM 渲染（那是 T12）。
  本任务结束时界面应仍是单窗口表现，但状态层已支持多窗口。
- 不要引入 windowId（用 appId 作主键）。
- 不要把布局存到后端（`DESKTOP.CPL` 的个性化也是纯本地的，保持一致）。
- 不要改动任何 `apps/*.js` 的业务逻辑与 API 调用。

### 测试要求

在 `tests/webui_modules.test.mjs` 新增：

1. `windowOpened 重复打开同一 appId 不会产生第二个窗口`。
2. `windowOpened 已存在时会提到栈顶且从 minimized 恢复`。
3. `focusedAppId 始终为栈顶非 minimized 窗口`。
4. `全部 minimized 时 focusedAppId 为 null`。
5. `windowClosed 后聚焦回落到新栈顶`。
6. `非法 windowState / 非法 rect / 未知 appId 均 throw TypeError`。
7. `rect 小于最小尺寸时 throw`。
8. `selectors.windowView 仍返回与旧形状一致的聚焦视图`。
9. `布局反序列化：未知 appId / 非 ready 应用 / 超出视口的 rect 均被修复`。
10. `损坏的 localStorage 内容回退到默认布局而不抛错`。

### 验收标准

- [x] K1 `state.ui.windows` 为数组，`focusedAppId` 由栈顶推导，无绝对 zIndex 存储。
- [x] K2 一个 appId 最多一个窗口（测试 1 保证）。
- [x] K3 全部新 action 有严格校验且非法输入 throw。
- [x] K4 `selectors.windowView` 保留且形状不变；新增 `selectors.windowStack`。
- [x] K5 hash 只包含聚焦应用路由，未序列化打开集。
- [x] K6 布局持久化带版本号 key，反序列化具备四项修复能力。
- [x] K7 本任务结束后界面仍可正常使用（单窗口表现）。
- [x] K8 上述测试要求的行为契约已被覆盖（数量不作硬性要求），新增前端测试全绿，
      288 个后端基线测试全绿。

---

## T12 — 窗口管理器重写：多实例 + 拖拽 + 缩放 + z 序

### 前置依赖

**T11 必须已验收通过。**

### 实现要求

**12.1 `index.html` 把单窗口改为模板。**

现有 `<section class="application-window" data-application-window>` 整段改成
`<template data-window-template>` 内的内容，外面新增一个容器
`<div class="window-layer" data-window-layer></div>`。

模板内必须保留现有的无障碍结构：标题栏 `<strong>` + 三个带 `aria-label` 的
按钮（minimize / maximize 带 `aria-pressed` / close）+ `class="window-body"`
且 `tabindex="-1"` 的主体。`id` 属性必须改为按 appId 生成（例如
`window-title-crawl` / `app-content-crawl`），因为现在会有多个实例，
**重复 id 会直接破坏 `aria-labelledby` 与 skip-link**。

`data-skip-link` 的目标改为「当前聚焦窗口的 body」。

**12.2 `window-manager.js` 改为多实例渲染。**

- 维护 `Map<appId, { element, titleEl, bodyEl, buttons }>`。
- 订阅 store，每次 `windowStack` 变化时：新增的 appId 从模板克隆并 mount 应用；
  移除的 appId 先调应用的 unmount/`onBeforeHide` 再从 DOM 删除；
  z 序按数组下标写 `style.zIndex`。
- 保留现有的 `notifyVisibility` / `onBeforeHide` / `onCloseFocus` 生命周期回调语义，
  只是参数从全局单窗口变为每个 appId 一份。

**12.3 拖拽。**

- 只能从标题栏拖（标题栏按钮区域除外：`pointerdown` 时如果
  `event.target.closest("button")` 存在则不启动拖拽）。
- 用 Pointer Events + `setPointerCapture`，**不要**用 mousemove on document（触屏/笔会挂）。
- 拖拽中只改 `element.style` 的 transform/left/top，**不派 action**；
  `pointerup` 时才派一次 `windowMoved(appId, rect)`。否则每帧一次 store dispatch +
  localStorage 写入会卡。
- localStorage 持久化必须防抖（>= 300ms）。

**12.4 缩放。**

- 右下角一个主手柄 + 右/下两个边手柄，均为真正的 `<button>` 且带 `aria-label`，
  否则无法键盘操作。键盘：手柄获焦时方向键以 16px 步长调整尺寸。
- 约束：最小 360×240；窗口至少 32px 保留在视口内；不得覆盖任务栏
  （底部可用高度 = `100dvh - var(--imageweave-taskbar-height)`）。
- `maximized` 时忽略 rect，铺满可用区；从 maximized 恢复时还原到之前的 rect。

**12.5 聚焦与 z 序。**

- 窗口任何位置 `pointerdown` （包括窗体内容）→ `windowFocused(appId)`。
  用捕获阶段监听，且**不要** `preventDefault`（否则窗体内的输入框无法点击定位）。
- 聚焦变更后把焦点移到新聚焦窗口的 `.window-body`（`focus()`），
  但**仅当聚焦是由键盘/任务栏触发**时。鼠标点击窗体内容时不得抢焦点。
- 窗口之间**不做焦点囚笼**（它们不是模态对话框）。对应地，窗口容器用
  `<section role="group" aria-labelledby="window-title-<appId>">`，**不要**用
  `role="dialog"`。

**12.6 动效与高对比度必须尊重现有约定。**

- `:root[data-motion="off"]` 或 `prefers-reduced-motion: reduce` 时，窗口出现/聚焦/
  最大化均无过渡。拖拽与缩放本身不算动效（直接跟随指针）。
- `@media (forced-colors: active)` 下窗口边框、标题栏、手柄必须仍可见
  （沿用 `tokens.css` 里已有的 `CanvasText`/`Canvas` 回退）。
- 现有的窗口不透明度档位（100%/96%/92%）必须对**每个**窗口生效。

**12.7 CSS。** `styles/desktop.css` 新增 `.window-layer`（`position: absolute; inset: 0`）与
`.application-window` 的绝对定位、`.window-resize-handle` 样式。
保留现有 `--imageweave-window-title-height`、`--imageweave-taskbar-height`、
`--imageweave-hard-shadow` 等 token 的用法，**不要**在本任务里改设计语言。

### 禁止事项

- 不要引入任何拖拽/缩放的第三方库（全局约束：不新增依赖）。
- 不要在拖拽/缩放过程中派 store action 或写 localStorage。
- 不要把窗口改成 `role="dialog"` 或加焦点囚笼。
- 不要在本任务里动任务栏（那是 T13）或轮询（那是 T14）。
- 不要修改 `styles/tokens.css` 的两个颜色 token 与字体栈。

### 测试要求

拖拽/缩放难以在 Node `--test` 里测，所以把**几何计算抽成纯函数**单独测：

新增 `webui/js/core/window-geometry.js`，导出纯函数：
`clampRect(rect, viewport, { minW, minH, taskbarHeight })`、
`nextRectForDrag(startRect, delta, viewport, opts)`、
`nextRectForResize(startRect, delta, viewport, opts)`、
`maximizedRect(viewport, opts)`。
在 `tests/webui_modules.test.mjs` 测：

1. `clampRect 保证至少 32px 在视口内`。
2. `clampRect 不允许窗口伸入任务栏区域`。
3. `nextRectForResize 遵守最小 360x240`。
4. `nextRectForDrag 在视口边缘被正确 clamp`。
5. `maximizedRect 铺满可用区且不覆盖任务栏`。
6. `从 maximized 恢复后 rect 与最大化前一致`（store 层测试）。

另在 `tests/test_webui_modules.py` 的静态检查里新增两条断言：

7. `index.html` 中不存在硬编码的 `id="window-title"` / `id="app-content"`
   （已改为按 appId 生成）。
8. `window-manager.js` 不包含 `role="dialog"` 字符串。

### 验收标准

- [x] L1 可同时打开至少 3 个窗口并各自独立渲染、各自正常刷新数据。
- [x] L2 标题栏拖拽、右下角与右/下边缩放均可用，且手柄可键盘操作。
- [x] L3 拖拽/缩放过程不派 action、不写 localStorage；`pointerup` 后才持久化（防抖 >= 300ms）。
- [x] L4 窗口 id 按 appId 生成，无重复 id；skip-link 指向当前聚焦窗口。
- [x] L5 窗口为 `role="group"` + `aria-labelledby`，无焦点囚笼；
      鼠标点击窗体内容不抢焦点。
- [x] L6 `data-motion="off"` 与 `prefers-reduced-motion` 下无过渡；
      forced-colors 下边框与手柄可见；不透明度档位对每个窗口生效。
- [x] L7 未引入新依赖；未改 `tokens.css`。
- [x] L8 `window-geometry.js` 为纯函数模块，上述测试要求的行为契约已被覆盖
      （数量不作硬性要求），新增测试全绿，288 个后端基线测试全绿。

---

## T13 — 任务栏多按钮、溢出折叠、移动端降级、占位应用归位

### 前置依赖

**T12 必须已验收通过。**

### 实现要求

**13.1 任务栏按窗口栈渲染多个按钮。**

- `index.html` 里单个 `data-task-window` 改成容器 `data-task-window-list`。
- 每个已开窗口一个按钮，文本用 `app.label`（中文，比 `windowTitle` 的
  `C:\IMAGEWEAVE\CRAWL.EXE` 简短得多），`title` 属性用 `windowTitle`。
- 聚焦窗口的按钮 `aria-pressed="true"` 且有可见的按下样式；
  minimized 窗口的按钮额外带一个 `data-minimized` 标记。
- 点击行为：非聚焦 → 聚焦（并从 minimized 恢复）；已聚焦 → 最小化。
  （与现有单按钮的切换语义一致）

**13.2 溢出折叠。** 打开窗口 > 6 个时，前 6 个正常显示，其余收进一个 `⋯` 按钮弹出的
列表（用现有 `components/dialog.js` 的轻量弹层能力或与 START 菜单一致的模式）。
`⋯` 按钮需有 `aria-expanded` 与 `aria-controls`，与现有 START 按钮的写法一致。
常量 `_TASKBAR_VISIBLE_LIMIT = 6` 写在模块里，不进配置。

**13.3 移动端降级（必项）。**

现有 `window-manager.js` 已有 `mobileViewport = matchMedia("(max-width: 767px)")` 与
`isForcedMobileMaximized`（仅对 review 生效）。推广为：

- `max-width: 767px` 时，**所有**窗口强制最大化，且只渲染聚焦窗口（其余置
  `hidden`，但**不销毁**，以保留应用内部状态）；
- 拖拽与缩放手柄在这个断点下隐藏且不可聚焦（`hidden` 而非仅 CSS 隐藏）；
- 任务栏按钮成为切换窗口的唯一方式；
- 断点变化（旋转屏幕/缩放浏览器）时必须正确恢复或重施加限制，
  且不得丢失 T11 存的 rect。

**13.4 占位应用归位。**

`app-registry.js` 里 `gallery`、`schedule`、`export` 三个 `availability !== "ready"`
的占位应用，占了桌面图标区将近一半面积。改为：

- 桌面图标区（`data-desktop-icons`）**只**渲染 `availability === "ready"` 的应用；
- START 菜单分两组：可用应用 + 一个标题为「即将推出」的分组，后者的项
  `aria-disabled="true"` 且点击无副作用；
- 直接访问 `#/gallery` 等 hash 时仍沿用现有 `parseHashRoute` 的回退行为
  （回 `DEFAULT_ROUTE`），**不要**改路由白名单。

### 禁止事项

- 不要删除 `gallery` / `schedule` / `export` 的注册项（以后要实现）。
- 不要为了移动端降级而销毁非聚焦窗口的 DOM（会丢失 CRAWL 的搜索结果、
  REVIEW 的未保存选择）。
- 不要改现有的 `taskbar-status` 三个状态徐与 `DIAG` / `↻` 按钮的行为。

### 测试要求

1. `每个已开窗口产生一个任务栏按钮`（测纯函数：从 windowStack 推导按钮描述数组）。
2. `聚焦窗口按钮 aria-pressed 为 true，其他为 false`。
3. `minimized 窗口按钮带 data-minimized`。
4. `> 6 个窗口时前 6 个可见、其余进溢出列表`。
5. `点击已聚焦按钮产生 minimize，点击非聚焦按钮产生 focus + 从 minimized 恢复`。
6. `移动断点下推导出的窗口视图：全部 maximized、仅聚焦窗口可见`。
7. `退出移动断点后 rect 被正确恢复`。
8. `桌面图标列表只包含 availability === "ready" 的应用`。
9. `START 菜单包含即将推出分组且其项 aria-disabled`。
10. `#/gallery 仍回退到 DEFAULT_ROUTE`（回归保护）。

### 验收标准

- [ ] M1 任务栏每个已开窗口一个按钮，文本用中文 `label`。
- [ ] M2 聚焦/最小化状态在按钮上可见且有正确的 `aria-pressed`。
- [ ] M3 溢出折叠在 > 6 窗口时生效，`⋯` 按钮有 `aria-expanded`/`aria-controls`。
- [ ] M4 `max-width: 767px` 下全部窗口强制最大化、仅聚焦窗口可见、
      手柄 `hidden` 不可聚焦。
- [ ] M5 断点往返不丢 rect、不销毁非聚焦窗口 DOM。
- [ ] M6 桌面图标区不再出现三个「开发中」占位，它们移到 START 菜单分组。
- [ ] M7 占位应用仍在 `app-registry.js` 注册，路由回退行为未变。
- [ ] M8 上述测试要求的行为契约已被覆盖（数量不作硬性要求），新增前端测试全绿，
      288 个后端基线测试全绿。

---

## T14 — 非聚焦窗口轮询降频 + 应用生命周期适配

### 背景

多窗口后，同时开着 CRAWL + TASKMGR + REVIEW 就是三套轮询器同时跑：
`TASK_POLL_INTERVAL_MS = 1500`、`REVIEW_POLL_INTERVAL_MS = 1500`、
PROXY `10_000`、VAULT `800`（授权进行中）。后端请求量会涨约 3 倍。
P0/P1/P2 修完后这不致命，但没必要白花。

### 前置依赖

**T13 必须已验收通过。**

### 实现要求

**14.1 `core/polling.js` 新增聚焦感知。**

现有已有 `visibilitySource`（页面隐藏时挂起）与 per-entry `scope`。新增：

- `createPollingManager({ ..., focusSource })`，`focusSource` 提供
  `getFocusedScope()` 与 `subscribe(listener)`，由 shell 从 store 的 `focusedAppId` 适配；
- 每个 entry 的 `scope` 已经对应应用（现有字段），因此判定规则为：
  - `scope === focusedScope` → 用原 `intervalMs`；
  - 对应窗口已打开但未聚焦 → `intervalMs * UNFOCUSED_POLL_MULTIPLIER`，
    常量 `UNFOCUSED_POLL_MULTIPLIER = 4`；
  - 对应窗口 minimized 或已关闭 → 完全 `suspend`（沿用现有 suspend 机制）；
  - 页面整体 hidden → 保持现有行为优先（全部挂起）。
- 从降频/挂起恢复到聚焦时，必须沿用现有的 `RESUME_POLICIES`：
  `immediate` 的 entry 立即拉一次，`interval` 的等下一个周期。
  这一条很重要：用户切回 TASKMGR 时应立即看到最新进度，而不是等 6 秒。

**14.2 VAULT 的 800ms 轮询不受降频影响。**

`apps/vault.js` 的 `AUTHORIZATION_POLL_INTERVAL_MS = 800` 是活跃授权会话的轮询，
用户此时正在另一个浏览器窗口里登录，ImageWeave 窗口很可能**不是聚焦的**。
降频会让授权完成后半天不刷新。因此：

- 给 entry 增加一个 `alwaysFocusRate: true` 选项，`vault` 的授权会话轮询设为 `true`；
- 但页面整体 hidden 时仍然遵守现有挂起行为（不变）。

**14.3 应用模块生命周期适配。**

逐个检查 `webui/js/apps/*.js`（crawl / tasks / proxy / vault / review / policy /
diagnostics / personalization / placeholder）：

- 确认每个模块的 mount 接口接受一个**根元素参数**，而不是用
  `document.querySelector` 全局拿固定选择器。任何全局查询都必须改为在
  本窗口根元素内查询——否则多窗口下会互相抢 DOM。
  **这是本任务最容易出隐形 bug 的地方，需逐文件 grep `document.querySelector`
  与 `document.getElementById` 并逐个改掉**。
- 因为一个 appId 只一个实例，模块级变量可以保留；但它们必须在 unmount 时
  正确清理（abort 未完成请求、停轮询、解绑事件），否则关闭再打开会泄漏。

**14.4 补一份简短的文档。** 新增/补充 `docs/webui-multi-window.md`：窗口栈状态形状、
布局持久化 key 与版本、轮询降频规则、移动端降级规则、无障碍约定。
不要写流水账式的开发过程记录。同时更新根 `README.md` 的桌面应用小节：
说明现在支持多窗口并列。

### 禁止事项

- 不要改任何轮询的**基础** interval 常量（`1500` / `10_000` / `30_000` / `20_000` /
  `800` 全部保留原值）。只动倍率。
- 不要降低 `SHELL_POLL_INTERVAL_MS`（30s）对应的任务栏轮询优先级——它不属于任何
  窗口，应保持原频率。
- 不要引入全局请求合并/去重层（超出本轮范围）。

### 测试要求

1. `聚焦窗口的 entry 使用原 interval`。
2. `已打开未聚焦的 entry interval 为原值×4`。
3. `minimized 窗口的 entry 被 suspend`。
4. `已关闭窗口的 entry 被 suspend 或移除`。
5. `alwaysFocusRate 的 entry 在未聚焦时仍用原 interval`。
6. `页面 hidden 时全部挂起，优先于聚焦规则`。
7. `从未聚焦恢复为聚焦时 immediate 策略的 entry 立即拉一次`。
8. `任务栏 30s 轮询不受聚焦规则影响`。
9. `聚焦切换不会泄漏定时器`：反复切焦 50 次后断言活动定时器数量与初始一致。
10. 在 `tests/test_webui_modules.py` 静态检查新增：断言 `webui/js/apps/*.js` 与
    `webui/js/components/*.js` 中**不存在** `document.querySelector` /
    `document.getElementById` 调用（允许的例外写成显式白名单，例如
    `personalization.js` 对 `:root` 的操作）。这条是防止多窗口互抢 DOM 的结构护栏。

### 验收标准

- [ ] N1 `UNFOCUSED_POLL_MULTIPLIER = 4`，基础 interval 常量全部未改。
- [ ] N2 minimized / 已关闭窗口的轮询完全挂起。
- [ ] N3 VAULT 授权会话轮询带 `alwaysFocusRate` 且不被降频。
- [ ] N4 页面 hidden 优先于聚焦规则；恢复时 `RESUME_POLICIES` 行为不变。
- [ ] N5 任务栏 30s 轮询不受影响。
- [ ] N6 全部 `apps/*.js` 与 `components/*.js` 不再使用全局 DOM 查询
      （白名单除外），且有静态测试护栏。
- [ ] N7 每个应用 unmount 时正确 abort 请求、停轮询、解绑事件，无定时器泄漏。
- [ ] N8 已产出 `docs/webui-multi-window.md`，`README.md` 桌面应用小节已更新。
- [ ] N9 上述测试要求的行为契约已被覆盖（数量不作硬性要求），新增测试全绿，
      288 个后端基线测试全绿。

---

## 5. 全部完成后的收尾检查

不属于单个任务，在 T14 验收后统一跑一遗：

- [ ] Z1 `(cd gallery-dl-backend && .venv/bin/python -m unittest discover -s tests -v)` 全绿，
      测试数相比 288 基线只增不减（具体数量不作硬性要求），
      总耗时仍在可随手跑完的量级。
- [ ] Z2 `.venv/bin/python -m unittest discover -s tests -v`（根目录去重测试）全绿，
      且与本轮开始前结果完全一致（去重代码本轮一行未改）。
- [ ] Z3 `./scripts/doctor.sh` 通过。
- [ ] Z4 `./scripts/lock-dependencies.sh --check` 通过（确认未引入新依赖）。
- [ ] Z5 `git diff --stat` 确认 `dedup_core.py`、`dedup_models.py`、
      `dedup_review_worker.py`、`gallery-dl-codeberg/` 零改动（决策 D7）。
- [x] Z6 ~~手工烟雾：浏览器里并排三个窗口、拖拽缩放、刷新后布局恢复。~~
      **本轮跳过**：不拉起真实浏览器，改由 T11–T14 的 Node 测试（窗口栈 action、
      `window-geometry.js` 纯函数、布局反序列化修复）覆盖。
- [ ] Z7 `curl -H "Host: evil.com" http://127.0.0.1:8787/api/v1/config` 返回 403；
      不带异常 Host 的同一请求正常返回。（两条命令，保留执行）
- [x] Z8 ~~手工烟雾：跑一个真实小批次验证全链路。~~
      **本轮跳过**：不打真实站点，改由 `tests/test_integration_local.py` 与 T8/T9 的
      批次并行 / 分块事务测试覆盖。
- [ ] Z9 本文档所有任务的验收标准全部勾选。
- [ ] Z10 `git log --oneline` 确认 14 个任务对应 14 个提交（T1…T14 各一个，
      顺序与派发顺序一致），且工作区干净（`git status` 无未提交的改动）。
      本轮不执行 push。
