# Database 读写路径审计

本文档记录 T6 收尾后 `gdl_backend.database.Database` 的公开方法读写属性。类型按公开方法的数据库行为划分：只查询为“读”，只修改为“写”，需要先读取状态再修改、存在幂等只读分支或写后返回查询结果为“读写混合”。

“是否使用 `_read()`”表示公开纯读主体是否使用线程本地只读连接。纯读方法全部标记为“是”；写方法和读写混合方法标记为“否”，并继续使用唯一写连接及 `_transaction()`，具体原因逐行记录。

## 公开方法清单

| 方法名 | 类型 | 是否使用 `_read()` | 未使用原因 |
| --- | --- | --- | --- |
| `close` | 读写混合 | 否 | 连接生命周期操作；必须关闭唯一写连接和 registry 中的全部读连接，不是查询迁移对象。 |
| `ping` | 读 | 是 | — |
| `create_task` | 读写混合 | 否 | 创建路径必须使用写事务；幂等命中只读已提交行，可安全间接使用已迁移的 `get_task()`。 |
| `create_crawl_media_tasks` | 读写混合 | 否 | 整块任务创建、排队事件、地址链接、来源键与批次计数必须在单一写事务内原子完成。 |
| `get_task` | 读 | 是 | — |
| `get_task_by_idempotency` | 读 | 是 | — |
| `list_tasks` | 读 | 是 | — |
| `queued_tasks` | 读 | 是 | — |
| `queued_task_ids` | 读 | 是 | — |
| `mark_task_credentials_unavailable` | 写 | 否 | 凭证状态与事件必须在单一写事务内原子提交。 |
| `claim_task` | 写 | 否 | 条件更新与事件写入必须在单一写事务内完成。 |
| `begin_attempt` | 读写混合 | 否 | 必须在同一写事务内读取任务状态并写入 attempt、任务状态与事件。 |
| `set_process` | 写 | 否 | attempt、任务进程字段与事件必须在单一写事务内更新。 |
| `finish_attempt` | 读写混合 | 否 | 必须在同一写事务内读取 attempt 归属并更新 attempt 与事件。 |
| `complete_task` | 读写混合 | 否 | 终态更新、lease 清理、事件及返回行必须共用 `_transaction()` 的 `conn`。 |
| `requeue_task` | 写 | 否 | 重新排队、lease 清理与事件必须在单一写事务内完成。 |
| `request_cancel` | 读写混合 | 否 | 状态判定、取消更新、事件及返回行必须共用 `_transaction()` 的 `conn`。 |
| `retry_task` | 读写混合 | 否 | 必须在同一写事务内读取终态与 attempt 计数，再更新预算并返回事务内行。 |
| `retry_failed_crawl_tasks` | 读写混合 | 否 | 批次、地址和任务的读取、重排与计数刷新必须保持一个写事务。 |
| `rerun_crawl_batch` | 读写混合 | 否 | 终态校验、任务重排、地址复位、审核清理和计数刷新必须原子完成。 |
| `set_lease` | 写 | 否 | lease 与事件必须在单一写事务内写入。 |
| `clear_lease` | 写 | 否 | lease 删除属于单一写连接路径。 |
| `append_logs_bulk` | 写 | 否 | 保留 T4 的单写连接批量日志事务、`_since_prune` 计数与确定性裁剪语义。 |
| `append_log` | 写 | 否 | 委托 `append_logs_bulk()`，必须沿用其单写事务。 |
| `get_logs` | 读 | 是 | — |
| `get_events` | 读 | 是 | — |
| `update_artifacts` | 写 | 否 | 产物计数更新属于单一写连接路径。 |
| `create_crawl_batch` | 读写混合 | 否 | 幂等检查与批次、地址创建必须在同一写事务内完成。 |
| `get_crawl_batch_by_idempotency` | 读 | 是 | — |
| `crawl_batch_tick_view` | 读 | 是 | — |
| `get_crawl_batch` | 读 | 是 | — |
| `list_crawl_batches` | 读 | 是 | — |
| `get_crawl_review` | 读 | 是 | — |
| `start_crawl_review` | 读写混合 | 否 | 批次终态校验与审核登记必须走写事务；提交后的详情读取间接使用已迁移的 `get_crawl_review()`。 |
| `recover_crawl_reviews` | 写 | 否 | 重启恢复状态更新属于单一写连接路径。 |
| `claim_next_crawl_review` | 读写混合 | 否 | 候选选择和条件 claim 必须在同一写事务内完成。 |
| `next_crawl_review_automatic` | 读 | 是 | — |
| `requeue_crawl_review` | 写 | 否 | 审核重新排队属于单一写连接路径。 |
| `fail_crawl_review` | 写 | 否 | 审核失败状态与脱敏错误必须通过写事务保存。 |
| `retry_crawl_review` | 读写混合 | 否 | 状态校验、旧清单删除和审核复位必须在同一写事务内完成。 |
| `replace_crawl_review_manifest` | 读写混合 | 否 | 状态校验、清单替换和汇总更新必须在同一写事务内完成。 |
| `list_crawl_review_groups` | 读 | 是 | — |
| `update_crawl_review_decisions` | 读写混合 | 否 | 审核状态、组和图片归属校验必须与选择更新原子完成。 |
| `get_crawl_review_image` | 读 | 是 | — |
| `begin_crawl_review_apply` | 读写混合 | 否 | 审核/批次状态与未决组检查必须和 applying 状态更新共用写事务。 |
| `crawl_review_apply_images` | 读 | 是 | — |
| `crawl_review_automatic_images` | 读 | 是 | — |
| `finish_crawl_review_automatic` | 读写混合 | 否 | 自动处理计数与审核状态更新必须在同一写事务内；提交后详情读取已走 `_read()`。 |
| `stage_crawl_review_image_move` | 写 | 否 | 文件移动阶段状态属于单一写连接路径。 |
| `finish_crawl_review_image` | 写 | 否 | 图片处置结果与脱敏错误属于单一写连接路径。 |
| `finish_crawl_review_apply` | 读写混合 | 否 | 处置计数与审核终态更新必须在同一写事务内；提交后详情读取已走 `_read()`。 |
| `active_crawl_batch_ids` | 读 | 是 | — |
| `next_crawl_address` | 读 | 是 | — |
| `save_crawl_address_proxy_probe` | 读写混合 | 否 | 探测汇总与节点集合替换必须原子写入；提交后结果读取已走 `_read()`。 |
| `get_crawl_address_proxy_probe` | 读 | 是 | — |
| `begin_crawl_address_planning` | 读写混合 | 否 | 地址存在性读取、条件状态更新与批次激活必须共用写事务。 |
| `task_crawl_batch_id` | 读 | 是 | — |
| `crawl_batch_cancel_requested` | 读 | 是 | — |
| `link_crawl_task` | 读写混合 | 否 | 链接/序号冲突读取、来源键写入与批次计数更新必须在同一写事务内完成。 |
| `succeeded_danbooru_source_keys` | 读 | 是 | — |
| `succeeded_danbooru_source_key_count` | 读 | 是 | — |
| `set_crawl_address_pre_dedup_skipped_count` | 写 | 否 | 地址预去重计数更新属于单一写连接路径。 |
| `finish_crawl_address_as_pre_deduplicated` | 读写混合 | 否 | 地址/批次状态校验、地址终态和批次计数刷新必须共用写事务。 |
| `mark_crawl_address_running` | 读写混合 | 否 | 已链接任务计数、地址状态和批次计数校准必须共用写事务。 |
| `reset_crawl_address_planning` | 写 | 否 | 地址规划状态复位属于单一写连接路径。 |
| `crawl_address_tasks` | 读 | 是 | — |
| `list_crawl_tasks` | 读 | 是 | — |
| `crawl_batch_task_count` | 读 | 是 | — |
| `crawl_address_task_count` | 读 | 是 | — |
| `finish_crawl_address_if_terminal` | 读写混合 | 否 | 地址、任务、批次状态读取和终态/计数更新必须在同一写事务内完成。 |
| `fail_crawl_address` | 读写混合 | 否 | 地址归属读取、失败状态和批次错误/计数更新必须共用写事务。 |
| `finish_crawl_batch_if_ready` | 读写混合 | 否 | 批次与地址状态读取、计数刷新和批次终态更新必须共用写事务。 |
| `request_cancel_crawl_batch` | 读写混合 | 否 | 批次状态读取、地址取消与待取消任务读取必须共用写事务。 |
| `recover_ordered_crawls` | 写 | 否 | 恢复地址和批次状态的多条更新必须在单一写事务内完成。 |
| `put_site_policy` | 写 | 否 | 站点策略 upsert 属于单一写连接路径。 |
| `get_site_policy` | 读 | 是 | — |
| `list_site_policies` | 读 | 是 | — |
| `delete_site_policy` | 写 | 否 | 站点策略删除属于单一写连接路径。 |
| `incomplete_processes` | 读 | 是 | — |
| `recover_incomplete` | 读写混合 | 否 | 必须在同一写事务内读取未完成任务并更新任务、attempt、lease 与事件。 |

## 写事务内公开方法调用审计

对 `Database` 中所有 `with self._transaction() as conn:` 代码块进行审计后，只发现一处调用 `self.<公开方法>()`：

| 调用方 | 事务内公开调用 | 结论 |
| --- | --- | --- |
| `create_task` | 幂等命中分支调用 `self.get_task(...)` | 命中行必然在当前事务开始前已经提交，WAL 读连接可见；代码现场已有可见性说明。普通新建分支仍用事务 `conn` 读取本事务刚插入的行。 |

其余高危返回路径复核如下：

- `complete_task()`、`request_cancel()`、`retry_task()` 继续通过 `_transaction()` 产出的 `conn` 读取返回行，没有调用 `get_task()`。
- `requeue_task()` 当前返回 `bool(cur.rowcount)`，事务内更新、lease 删除和事件写入均继续使用同一个 `conn`，没有调用任何公开读方法。
- 除上述 `create_task()` 幂等命中外，没有其他写事务块调用公开方法。

## 仍在事件循环上的同步读

以下清单按生产执行路径盘点同步执行的 `Database` 纯读调用；同步 helper 若由 `async def` 直接调用，也按事件循环路径计入。典型数据量描述单次调用的返回量或扫描范围，不是性能阈值。已经显式走 `asyncio.to_thread` 的调用不列入表中。

| 模块 | 调用上下文 | 数据库读方法 | 典型数据量 |
| --- | --- | --- | --- |
| `ordered_crawl.py` | `status()`；由异步 `/readyz` 与调度诊断 handler 在事件循环上取快照 | `active_crawl_batch_ids` | 返回全部活跃批次 ID，通常为 0 至少量批次，随排队/运行/取消中批次数增长。 |
| `ordered_crawl.py` | `_activate_address()` 计算重新规划预算 | `crawl_address_task_count` | 1 个标量计数，扫描当前地址的任务链接。 |
| `ordered_crawl.py` | `_activate_address()` 计算批次剩余额度 | `crawl_batch_task_count` | 1 个标量计数，扫描批次全部任务链接；默认规模上限 10,000。 |
| `ordered_crawl.py` | `_plan_address()` 计算跨站预去重发现余量 | `succeeded_danbooru_source_key_count` | 1 个标量计数，扫描本批次已成功的 Danbooru 来源键。 |
| `ordered_crawl.py` | `_plan_address()` 直接调用同步 `_filter_previously_downloaded_danbooru_sources()` | `succeeded_danbooru_source_keys` | 候选来源键按 500 个分块查询；常见可到批次媒体规模（默认 `max_tasks=10,000`）。 |
| `scheduler.py` | `start()` 启动恢复前读取遗留进程 | `incomplete_processes` | 全部 `starting/running/cancelling` 任务；正常运行通常不超过全局并发默认值 20，崩溃恢复时可能包含遗留行。 |
| `scheduler.py` | `_dispatch_loop()` 每轮补充待调度任务 | `queued_tasks` | 每次最多 200 条任务；一次唤醒最多 3 个 refill round。 |
| `scheduler.py` | `_execute()` 直接调用同步 `_allowed_proxy_ids()` 获取地址探测范围 | `get_crawl_address_proxy_probe` | 1 条探测汇总及该地址全部允许节点 ID，通常为几十个以内。 |
| `scheduler.py` | `cancel()` 在取消动作后读取返回详情 | `get_task` | 1 个任务、最新 attempt 与可选 lease。 |
| `scheduler.py` | `_execute()` 在运行前、gallery-dl 返回后、无 attempt 收尾及 attempt 完成后检查状态 | `get_task` | 每次 1 个任务、最新 attempt 与可选 lease；单次执行路径最多 4 次。 |
| `review.py` | `run_once()` 轮询严格自动处置队列 | `next_crawl_review_automatic` | 至多 1 条审核批次记录。 |
| `review.py` | `run_once()` 写入 manifest 后读取审核状态 | `get_crawl_review` | 1 条审核记录，并聚合扫描该批次全部审核图片与组；规模随批次图片数增长。 |

明确排除的现有线程路径：`ordered_crawl.py` 的监督循环与兼容 `run_once()` 均通过 `asyncio.to_thread` 调用 `active_crawl_batch_ids()`；`_tick_batch()` 的 `crawl_batch_tick_view()`、`next_crawl_address()`、取消分支 `crawl_address_tasks()`，以及 `_activate_address()` 的全部 `crawl_batch_tick_view()` 和每块一次 `crawl_batch_cancel_requested()` 也都在线程中执行。轮询不再调用会聚合全部地址、探活与审核信息的 `get_crawl_batch()`。`scheduler.py` 的 `queued_task_ids()` 已通过 `asyncio.to_thread` 调用；`review.py` 的 `_apply_automatic_rejections()` 在两个生产分支均整体下线程，手动 `apply()` 也由 `app.py` 通过 `asyncio.to_thread` 调用，因此其中的 `crawl_review_automatic_images()`、`get_crawl_batch()` 与 `crawl_review_apply_images()` 不属于“仍在事件循环上的同步读”。

## T6 收尾结论

T5 留下的 8 个长尾纯读方法均已迁移到 `_read()`：`queued_task_ids`、`get_crawl_batch_by_idempotency`、`next_crawl_review_automatic`、`crawl_review_apply_images`、`crawl_review_automatic_images`、`next_crawl_address`、`succeeded_danbooru_source_keys`、`succeeded_danbooru_source_key_count`。

最终审计覆盖全部 80 个公开方法，其中 32 个纯读方法全部使用 `_read()`；19 个纯写方法和 29 个读写混合/连接生命周期方法均在各自 `def` 紧邻上方保留一行中文原因注释。`tests/test_database.py` 的 `test_read_methods_do_not_take_write_lock` 使用 `inspect.getsource()` 检查全部纯读方法不引用 `self._lock`，模块级例外名单为 `frozenset` 且当前为空。
