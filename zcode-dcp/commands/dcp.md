---
description: 显示 DCP 状态概览（含真实上下文占用）
---
调用 mcp__plugin_zcode-dcp_dcp__context_stats 工具查看当前状态，以简洁格式展示：

1. **真实上下文占用**（若有计量数据）：usedPercent%（usedTokens / contextWindowTokens tokens），以及距提醒阈值（nudgeThresholdPercent%）的距离
2. 当前压缩块数量、重复主题/错误块洞察与主题列表
3. 可用的 DCP 命令：
   - `/dcp-usage` - 只看真实占用
   - `/dcp-stats` - 详细统计
   - `/dcp-decompress <id>` - 解压指定块

如果占用已超过阈值，主动建议执行一次 compress 归档旧内容，并说明"归档不减少占用，立即释放可执行 /compact"。
如果没有压缩块，显示"暂无压缩内容"并提示可以通过 compress 工具主动归档。
