# Database 读写路径审计

本文档记录 T5 完成时 `gdl_backend.database.Database` 的公开方法读写属性。类型按公开方法的数据库行为划分：只查询为“读”，只修改为“写”，需要先读取状态再修改、存在幂等只读分支或写后返回查询结果为“读写混合”。

“本轮是否已转 `_read()`”仅表示公开方法的纯读主体是否已使用线程本地读连接。写方法和读写混合方法必须继续使用唯一写连接及 `_transaction()`；标为 T6 的纯读方法是有意保留，并非遗漏。

## 公开方法清单

| 方法名 | 类型 | 本轮是否已转 `_read()` | 未转的原因 |
| --- | --- | --- | --- |
| `close` | 读写混合 | 否 | 连接生命周期操作；必须关闭唯一写连接和 registry 中的全部读连接，不是查询迁移对象。 |
| `ping` | 读 | 是 | — |
| `create_task` | 读写混合 | 否 | 创建路径必须使用写事务；幂等命中只读已提交行，可安全间接使用已迁移的 `get_task()`。 |
| `get_task` | 读 | 是 | — |
| `get_task_by_idempotency` | 读 | 是 | — |
| `list_tasks` | 读 | 是 | — |
| `queued_tasks` | 读 | 是 | — |
| `queued_task_ids` | 读 | 否 | T6 范围：纯读可转，本轮严格按 §5.3 暂不迁移。 |
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
| `get_crawl_batch_by_idempotency` | 读 | 否 | T6 范围：纯读可转，本轮严格按 §5.3 暂不迁移。 |
| `get_crawl_batch` | 读 | 是 | — |
| `list_crawl_batches` | 读 | 是 | — |
| `get_crawl_review` | 读 | 是 | — |
| `start_crawl_review` | 读写混合 | 否 | 批次终态校验与审核登记必须走写事务；提交后的详情读取间接使用已迁移的 `get_crawl_review()`。 |
| `recover_crawl_reviews` | 写 | 否 | 重启恢复状态更新属于单一写连接路径。 |
| `claim_next_crawl_review` | 读写混合 | 否 | 候选选择和条件 claim 必须在同一写事务内完成。 |
| `next_crawl_review_automatic` | 读 | 否 | T6 范围：纯读可转，本轮严格按 §5.3 暂不迁移。 |
| `requeue_crawl_review` | 写 | 否 | 审核重新排队属于单一写连接路径。 |
| `fail_crawl_review` | 写 | 否 | 审核失败状态与脱敏错误必须通过写事务保存。 |
| `retry_crawl_review` | 读写混合 | 否 | 状态校验、旧清单删除和审核复位必须在同一写事务内完成。 |
| `replace_crawl_review_manifest` | 读写混合 | 否 | 状态校验、清单替换和汇总更新必须在同一写事务内完成。 |
| `list_crawl_review_groups` | 读 | 是 | — |
| `update_crawl_review_decisions` | 读写混合 | 否 | 审核状态、组和图片归属校验必须与选择更新原子完成。 |
| `get_crawl_review_image` | 读 | 是 | — |
| `begin_crawl_review_apply` | 读写混合 | 否 | 审核/批次状态与未决组检查必须和 applying 状态更新共用写事务。 |
| `crawl_review_apply_images` | 读 | 否 | T6 范围：纯读可转，本轮严格按 §5.3 暂不迁移。 |
| `crawl_review_automatic_images` | 读 | 否 | T6 范围：纯读可转，本轮严格按 §5.3 暂不迁移。 |
| `finish_crawl_review_automatic` | 读写混合 | 否 | 自动处理计数与审核状态更新必须在同一写事务内；提交后详情读取已走 `_read()`。 |
| `stage_crawl_review_image_move` | 写 | 否 | 文件移动阶段状态属于单一写连接路径。 |
| `finish_crawl_review_image` | 写 | 否 | 图片处置结果与脱敏错误属于单一写连接路径。 |
| `finish_crawl_review_apply` | 读写混合 | 否 | 处置计数与审核终态更新必须在同一写事务内；提交后详情读取已走 `_read()`。 |
| `active_crawl_batch_ids` | 读 | 是 | — |
| `next_crawl_address` | 读 | 否 | T6 范围：纯读可转，本轮严格按 §5.3 暂不迁移。 |
| `save_crawl_address_proxy_probe` | 读写混合 | 否 | 探测汇总与节点集合替换必须原子写入；提交后结果读取已走 `_read()`。 |
| `get_crawl_address_proxy_probe` | 读 | 是 | — |
| `begin_crawl_address_planning` | 读写混合 | 否 | 地址存在性读取、条件状态更新与批次激活必须共用写事务。 |
| `task_crawl_batch_id` | 读 | 是 | — |
| `crawl_batch_cancel_requested` | 读 | 是 | — |
| `link_crawl_task` | 读写混合 | 否 | 链接/序号冲突读取、来源键写入与批次计数更新必须在同一写事务内完成。 |
| `succeeded_danbooru_source_keys` | 读 | 否 | T6 范围：纯读可转，本轮严格按 §5.3 暂不迁移。 |
| `succeeded_danbooru_source_key_count` | 读 | 否 | T6 范围：纯读可转，本轮严格按 §5.3 暂不迁移。 |
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

对 `Database` 中所有 `with self._transaction() as conn:` 代码块进行 AST 审计后，只发现一处调用 `self.<公开方法>()`：

| 调用方 | 事务内公开调用 | 结论 |
| --- | --- | --- |
| `create_task` | 幂等命中分支调用 `self.get_task(...)` | 命中行必然在当前事务开始前已经提交，WAL 读连接可见；代码现场已有可见性说明。普通新建分支仍用事务 `conn` 读取本事务刚插入的行。 |

其余高危返回路径复核如下：

- `complete_task()`、`request_cancel()`、`retry_task()` 继续通过 `_transaction()` 产出的 `conn` 读取返回行，没有调用 `get_task()`。
- `requeue_task()` 当前返回 `bool(cur.rowcount)`，事务内更新、lease 删除和事件写入均继续使用同一个 `conn`，没有调用任何公开读方法。
- 除上述 `create_task()` 幂等命中外，没有其他写事务块调用公开方法。

## T6 待迁纯读方法

以下 8 个纯读方法有意留待 T6：`queued_task_ids`、`get_crawl_batch_by_idempotency`、`next_crawl_review_automatic`、`crawl_review_apply_images`、`crawl_review_automatic_images`、`next_crawl_address`、`succeeded_danbooru_source_keys`、`succeeded_danbooru_source_key_count`。
