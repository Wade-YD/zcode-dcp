---
name: dcp
description: Dynamic Context Pruning v2 - 当对话变长、上下文占用达到阈值、token 不足，或用户提到"压缩上下文"、"清理上下文"、"查占用"时触发。真实计量上下文占用，归档不再需要的内容。
---

# ZCode DCP v2 (Dynamic Context Pruning)

管理对话上下文：**计量真实占用 → 达阈值自动提醒 → 归档旧内容**。

## 工具

### mcp__plugin_zcode-dcp_dcp__compress(topic, summary, tags?, type?)
归档不再需要的对话内容。调用时机：
- 旧的搜索/探索结果已被更精确的结果替代
- 已完成的调试过程不再需要完整保留
- 重复的工具调用只保留最新的
- 已解决的错误不再需要完整错误日志
- 自动监控提醒上下文超过阈值时

**注意**：归档是把内容记入存档并写摘要，**不减少当前上下文 token**；真正释放发生在 ZCode 内置 compact（约 83% 自动触发，或用户执行 `/compact`）。

### mcp__plugin_zcode-dcp_dcp__decompress(blockId)
查看已归档块的完整内容。

### mcp__plugin_zcode-dcp_dcp__context_stats()
压缩统计 + 当前真实上下文占用。

### mcp__plugin_zcode-dcp_dcp__context_usage()
当前真实上下文占用（tokens 与百分比），来自每轮自动计量（hook 读取 ZCode 模型 IO 日志）。

### mcp__plugin_zcode-dcp_dcp__sweep(action)
扫描对话，识别可去重/清理的内容。action: "deduplicate" | "purge_errors" | "all"。

## 自动监控（v2 新增）

插件 hook 在每轮（用户发消息时、每轮结束时）自动读取 `~/.zcode/cli/rollout/model-io-sess_<会话ID>.jsonl` 最新一行的 `usage.inputTokens`，写入 `~/.zcode/dcp/usage.json`。占用超过阈值（默认 50%）时自动注入压缩提醒，提醒文本会出现在对话上下文中——看到 `[dcp 自动上下文监控]` 时**立即**执行压缩。

## 压缩原则

1. **主动压缩**：判断内容不再需要时就归档，不要等上下文满
2. **保留关键信息**：摘要必须包含所有可能在后续对话中需要的信息
3. **语义清晰**：topic 准确描述被压缩内容的范围
4. **分类正确**：type 使用 general/tool_result/error/duplicate
5. **诚实告知**：归档不等于释放；用户想看到占用条下降时，建议执行 `/compact`
