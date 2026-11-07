---
description: 查看当前真实上下文占用
---
调用 mcp__plugin_zcode-dcp_dcp__context_usage 工具获取真实占用，展示：

- 上下文占用：`usedPercent%`（usedTokens / contextWindowTokens tokens）
- 提醒阈值：`nudgeThresholdPercent%`
- 数据更新时间与距现在的分钟数
- 占用趋势（trend）：最近 10 点平均增速 avgGrowthTokensPerTurn（tokens/轮）与距 tier3 阈值的预计轮数 turnsToTier3（线性外推，仅供参考）

若 available 为 false，说明 hook 尚未产生计量数据，提示用户：发一轮消息后自动计量会生效（或检查插件 hook 是否已批准启用）。

若占用超过阈值，建议：立即用 compress 归档旧内容；要看到占用条下降请执行 `/compact`。
