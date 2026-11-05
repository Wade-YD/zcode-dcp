# Proposal

## Why

三个长期 backlog（体检命令、节省统计、调试日志）与参照对象 billion-context 的可观测性体系（/__bili/health 健康检查、压缩经济学账本、bili.log 轮转日志）对位，是纯插件面能直接对齐的差距；占用趋势补齐"增长多快、还有几轮到压缩线"的用户感知。当前用户反馈"为什么没提醒/没数据"时只能猜：无体检、无日志、无趋势。

## What Changes

- **dcp_doctor 体检工具**：第七个 MCP 工具（无参数、纯只读），输出 checks[]（ok/warn/fail/skipped）与 verdict 聚合；覆盖状态目录/配置健全性（tier 递增+default 窗口误用+config 解析失败）/计量链路/归档健康/压缩统计/窗口校准/陈旧会话状态/调试日志/hook 命令形态十类检查；每检查独立 try/catch，状态目录缺失时依赖状态的检查短路为 skipped
- **节省账本**：compact-stats.json 增 totals（totalEvents/totalSaved/since/perModel/perDay），自启用起从零累计（不回填历史 events），detectCompact 增量累计、绝不从 events 重算；perDay 键用 UTC 日期（event.at 派生）；context_stats 展示 savings（近 7 天从 totals.perDay 取）；压缩召回文本历史次数 >1 时追加累计行；purge 清零（与全部状态同语义）
- **DCP_DEBUG 调试日志**：userConfig debug_log（boolean，默认 false）或 env DCP_DEBUG（优先于 config）；~/.zcode/dcp/dcp-debug.log JSON lines 追加，>512KB 轮转 .1（只留一代，rename 失败静默继续追加）；只记元数据（ts/mode/event/sid/modelId/tokens/窗口来源/决策与原因/错误摘要），严禁 prompt/tool_response 内容/归档摘要；所有写路径绝不 throw；dcp_reset 白名单纳入；关闭时零写盘开销
- **占用趋势（降维版）**：usage.json 内嵌 history 环（≤60 点），同会话且用量未变化的连续计量点去重（每轮 prompt+stop 双事件只记变化点），会话标识变更时重置环；context_usage 返回 trend（最近 ≤20 点 + 最近 10 点平均增速 tokens/轮 + 增速>0 时距 tier3 预计轮数）

## Capabilities

### New Capabilities

- `health-diagnostics`: dcp_doctor 只读体检——检查集、verdict 聚合、skipped 语义
- `savings-ledger`: 压缩节省账本——totals 增量累计（从零起算）、UTC perDay、context_stats 展示、purge 语义
- `debug-logging`: DCP_DEBUG 调试日志——双通道开关（env>config）、轮转、隐私红线、dcp_reset 纳管
- `usage-trend`: 占用趋势环——usage.json 内嵌 history、去重与会话重置、增速与 tier3 预测

### Modified Capabilities

（无既有需求语句被修改；计量写盘内容扩展 history 与 compact-stats 扩展 totals 均为新增需求）

## Impact

- 代码：`dist/dcp-common.cjs`（DEBUG_LOG_FILE + appendDebugLog，从不 throw）、`hooks/auto-watch.cjs`（loadConfig+debug_log、writeUsage+history 环、detectCompact+totals、关键决策点埋点）、`dist/mcp/server.js`（dcp_doctor 工具、context_stats+savings、usagePayload+trend、dcp_reset 白名单、SERVER_INFO 0.7.0）、`commands/dcp-doctor.md`（新增）
- 状态文件：dcp-debug.log(.1)（opt-in）；usage.json 增 history 字段（旧文件无字段容忍）；compact-stats.json 增 totals 字段（旧文件容忍缺省）；不新增其他状态文件
- 版本四处：plugin.json / package.json / server.js SERVER_INFO / 测试断言（仓库副本 marketplace.json 顺手）
- 兼容：无破坏性；dcp_doctor 不改变任何既有工具行为
