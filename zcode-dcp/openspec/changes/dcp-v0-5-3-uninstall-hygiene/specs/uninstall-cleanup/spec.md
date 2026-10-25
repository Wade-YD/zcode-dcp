# Spec Delta

## Purpose

让插件的卸载与数据清理有明确的工具面与文档路径：状态残留可列举、经确认可清除，用户不必盲猜磁盘文件。

## ADDED Requirements

### Requirement: 状态残留列举

`dcp_reset(mode="list")` SHALL 返回状态目录下全部文件（文件名、字节大小、最后修改时间）与总大小，并附各文件类别说明（归档/计量/校准/提醒状态等），供卸载前评估将丢失什么。

#### Scenario: 列举残留

- **WHEN** 状态目录存在 usage.json 与归档文件时调用 dcp_reset(mode="list")
- **THEN** 返回包含这两个文件的名称、大小与类别说明及总量

### Requirement: 确认后清除

`dcp_reset(mode="purge")` SHALL 删除状态目录下的全部状态文件并重置 server 内存归档态（块列表清空、块号归一）；清除范围 SHALL 严格限定于插件状态目录，不得触碰其他路径；工具描述 SHALL 包含"不可逆、仅在用户明确要求清理或卸载时调用"的护栏。

#### Scenario: 清除后归档为空

- **WHEN** 用户明确确认后调用 dcp_reset(mode="purge")
- **THEN** 状态目录文件被删除，随后的 search_context 无命中、context_stats 块数为 0

#### Scenario: 目录不存在时安全

- **WHEN** 状态目录不存在时调用 purge
- **THEN** 返回无需清理的成功结果，不报错
