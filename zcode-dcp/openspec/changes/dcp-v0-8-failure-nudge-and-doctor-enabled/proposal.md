# Proposal

## Why

两个真实支持场景尚无抓手：①"工具反复失败走不出死胡同"是压缩优先级③"走不通的探索"的前置信号，但插件只在 PostToolUse 成功路径上有 absorb 提醒，失败路径完全沉默；②"装了没启用"与"官方旧版 + dev 版双开导致提醒重复注入"（README 明确警告过的场景）无法自查——doctor 十一项检查里没有启用状态。

## What Changes

- **PostToolUseFailure 死胡同提醒**：hooks.json 注册第 5 个事件（mode "failure"）；同会话同工具失败计数达阈值（userConfig `failure_nudge_threshold`，默认 2，0=关闭）时注入 additionalContext——报告连续失败次数，引导 compress 归档教训（报错原文逐字保留）后换路径或继续修复；is_interrupt 不计数；同工具成功清零计数（在 auto_watch 门控之外，且仅 failure 文件存在时读写）；距上次失败超 30 分钟重置重计；触发后计数归零并进入 15 分钟冷却（具名常量，不进 userConfig）；状态文件 failure-<sid>.json 仅存工具名/计数/时间戳（不含报错原文），纳入 dcp_reset 白名单与 doctor stale_sessions
- **doctor 第 12 检查 plugin_enabled**：读 config.json 的 plugins.enabledPlugins（文件缺失/解析失败/键缺失 → skipped）；以"精确 key（安装目录名拼 id@marketplace）→ 唯一 zcode-dcp 条目回退 → 多条目按启用数裁决"三层定位自身；自身被禁 → fail（注明正常不可达）；≥2 个启用 → warn 提醒重复注入；唯一启用 → ok；无任何条目 → warn。启用判定抽成 dcp-common 纯函数（可不起进程直测）
- **文档欠账**：commands/dcp-usage.md 补 trend 展示、dcp-stats.md 补 savings 展示；search_context 零命中提示补"中文长句请拆成 2-3 个关键词"引导

## Capabilities

### New Capabilities

- `dead-end-failure-nudge`: PostToolUseFailure 死胡同提醒——per-tool 计数、成功清零、陈旧衰减、冷却与阈值、状态治理与隐私红线

### Modified Capabilities

- `health-diagnostics`: 新增"插件启用状态检查"需求（基于 dcp-v0-7 同一能力的增量，该变更尚未归档）

## Impact

- 代码：`hooks/hooks.json`（+PostToolUseFailure）、`hooks/auto-watch.cjs`（failure 分支 + 成功重置 + failureFileFor + threshold 配置）、`dist/dcp-common.cjs`（pluginEnabledStatus 纯函数）、`dist/mcp/server.js`（doctor 第 12 检查、dcp_reset OWNED/CATEGORY 加 failure-、stale_sessions 正则、search 零命中文案）、`commands/dcp-usage.md`/`dcp-stats.md`
- 状态文件：failure-<sid>.json（新）
- 清单：plugin.json userConfig 加 failure_nudge_threshold（四键合规）；版本五处 0.8.0（plugin.json/package.json/SERVER_INFO/测试断言×7/marketplace.json）
- 旧套件：smoke-v06 T4 事件数 4→5 + failure 命令形态断言；smoke-v07 checks 11→12 两处 + DBG_KEYS 加 count；版本断言 7 处
