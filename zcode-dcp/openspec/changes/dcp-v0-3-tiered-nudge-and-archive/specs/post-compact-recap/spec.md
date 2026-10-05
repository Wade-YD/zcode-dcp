# Spec Delta

## Purpose

在 ZCode 内核执行自动/手动压缩（compact）重写对话历史后，向新对话注入归档索引与当前占用，使模型立即知道"哪些知识已归档、如何取回"，兑现跨压缩不失忆。

## ADDED Requirements

### Requirement: 压缩后注入归档索引

当内核 compact 后插件会话启动钩子被触发时，插件 SHALL 注入包含以下内容的上下文：当前占用计量（若可用）、全部归档块的 ID 与主题索引、以及"通过 search_context 检索、decompress 取回"的使用说明。

#### Scenario: compact 后新轮次可见索引

- **WHEN** 内核完成一次压缩且压缩后的会话启动钩子被触发
- **THEN** 新对话上下文中出现归档块 ID 与主题列表

### Requirement: 无害退化

当压缩后钩子未触发、无计量数据或归档为空时，注入 SHALL 退化为常规会话说明（仅工具介绍），不得报错、不得注入空占位内容或阻塞会话。

#### Scenario: 无归档块时

- **WHEN** 压缩后钩子触发但归档存储为空
- **THEN** 仅注入工具说明，不含空索引段，会话正常开始
