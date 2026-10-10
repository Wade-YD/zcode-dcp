# Proposal

## Why

v0.3.0 归档后的复查发现四个正确性/健壮性问题：①多会话并发时全局单文件状态互相覆盖，且计量在会话日志缺失时会兜底读"最近修改"的其他会话日志——两个 ZCode 窗口并行时计量与提醒互相污染（冒烟测试中实测踩到）；②归档块全局共享，项目 A 的路径/决策会漂进项目 B 的会话上下文；③blocks.json 只增不减，长期使用会膨胀且产生近似重复块（acp-kernel #442 事故同类风险）；④压缩后召回依赖未证实的 SessionStart(compact) matcher，且内核每次压缩"省了多少"无从统计。

## What Changes

- **压缩检测（骤降法）**：内核无 PostCompact hook 事件（内核源码证实仅为内部事件），改在计量 hook 中检测相邻两轮 inputTokens 骤降（<60% 且前值>20K）判定压缩发生：记录压缩统计（前后 token、节省量）、重置提醒层级、prompt 模式下即时注入归档索引召回（不再单赌 SessionStart matcher）
- **窗口自动校准**：压缩触发点 ≈ 真实窗口 − 34K，由压缩前用量推算观测窗口（保留最近 5 个观测取中位数）；仅在用户未显式配置窗口时生效，context_usage 标注 windowSource
- **会话隔离**：提醒状态按 session_id 分文件；计量严格匹配会话日志（有 session_id 且文件缺失→不计量，废除跨会话兜底）
- **归档项目命名空间**：`archive_scope` 配置（默认 project）——MCP 侧按 DCP_PROJECT_DIR 哈希分文件，hook 侧按 cwd 同规则；旧全局 blocks.json 一次性种子迁移；scope=global 保留旧行为
- **归档生命周期**：`max_blocks`（默认 200）超限时把最旧 20% 蒸馏合并为单块（逐字保留各块的 Open objectives 行，遵 acp-kernel #442）；compress 命中同名主题时返回 possibleDuplicates 提示（不自动合并）
- **absorb-lite（实验性）**：新增 PostToolUse hook——工具结果超过 `absorb_min_tool_tokens`（默认 8000）时提醒模型立即蒸馏归档（改写自 acp-kernel absorb 的提示注入半层；隐藏原文那一半插件做不到），带会话级 10 分钟冷却

## Capabilities

### New Capabilities

- `compact-detection`: 骤降法压缩检测——压缩统计、窗口自动校准、压缩后即时召回
- `session-isolation`: 会话隔离——按会话分文件的提醒状态与严格会话日志匹配
- `archive-lifecycle`: 归档生命周期——项目命名空间、max_blocks 蒸馏、重复主题提示、absorb-lite 即时蒸馏提示

### Modified Capabilities

（无——v0.3.0 四能力的需求不变，本变更全部为新增行为）

## Impact

- 代码：`plugin.json`（0.4.0 + archive_scope/max_blocks/absorb_min_tool_tokens 配置 + PostToolUse hook env 传递）、`hooks/hooks.json`（+PostToolUse）、`hooks/auto-watch.cjs`（骤降检测/校准/隔离/absorb/召回注入）、`dist/mcp/server.js`（命名空间/蒸馏/重复提示）、README/marketplace
- 状态文件：新增 compact-stats.json、window-calibration.json、nudge-\<sid\>.json、absorb-\<sid\>.json、blocks-\<projhash\>.json；旧 nudge.json/blocks.json 兼容（种子迁移/重置）
- 风险：骤降检测的误报（用户回退会话也会呈现骤降）——后果仅是多注入一次召回，无害；PostToolUse 注入有冷却与阈值双重限流
- 明确不做：PostCompact hook 注册（非 hook 事件）；absorb 的原文隐藏（内核独占）
