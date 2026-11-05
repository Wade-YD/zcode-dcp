---
description: DCP 健康体检（纯只读）
---
调用 mcp__plugin_zcode-dcp_dcp__dcp_doctor 工具执行体检，把返回的 checks 以表格展示（列：检查项 id / 状态 / 说明 detail），并给出总结论：

- `ok`：各链路正常。
- `warn`：不影响运行，逐条按 warn 行的 detail 处理。
- `fail`：相关功能可能不工作，按 fail 行 detail 修复（常见：tier 阈值顺序破坏→设置里改回严格递增；计量停更→检查插件 hook 是否已批准启用；config.json 不可解析→备份后重置该文件）。

排查"为什么没提醒/没计量"时，可建议开启调试日志（设置 → 插件 → DCP → 调试日志，或环境变量 `DCP_DEBUG=1`）复现后查看 `~/.zcode/dcp/dcp-debug.log`。
