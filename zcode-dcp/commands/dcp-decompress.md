---
description: 解压指定的压缩块，查看完整摘要内容
argument-hint: "<block-id> 如 b001"
---
如果用户提供了块 ID: $ARGUMENTS，调用 mcp__plugin_zcode-dcp_dcp__decompress 工具解压该块。

如果用户没有提供块 ID，先调用 mcp__plugin_zcode-dcp_dcp__context_stats 展示所有可用块，然后提示用户指定要解压的块。

解压后展示：
- 块 ID 和主题
- 完整摘要内容
- 标签和类型
- 创建时间
