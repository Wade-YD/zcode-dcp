---
description: 扫描对话，识别可去重/清理的压缩内容
---
调用 mcp__plugin_zcode-dcp_dcp__sweep 工具执行清理扫描。action 参数: $ARGUMENTS

如果用户没有指定 action，默认使用 "all"。

展示扫描结果和建议，然后根据建议使用 mcp__plugin_zcode-dcp_dcp__compress 工具执行归档操作。
