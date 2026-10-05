# searchable-archive Specification

## Purpose

让归档内容成为可检索的持久知识：压缩块跨进程重启保留，支持关键词检索定位后再取回全文，使"归档"真正承担跨压缩记忆职责。

## Requirements

### Requirement: 归档块创建

调用 compress 并提供 topic 与 summary 时，插件 SHALL 创建带唯一递增块 ID 的归档块，记录 topic、summary、tags、type 与创建时间，并返回该块 ID。

#### Scenario: 归档返回可引用的块 ID

- **WHEN** 调用 compress 归档一段旧搜索过程
- **THEN** 返回唯一块 ID（如 b003），后续可用其检索或取回

### Requirement: 归档持久化

归档块 SHALL 持久化存储，在插件 MCP server 进程重启（含新会话开始）后仍可通过 search_context 与 decompress 访问；持久化写失败时 SHALL 静默降级为仅内存保留，归档功能不中断。

#### Scenario: 重启后归档仍在

- **WHEN** 会话 A 中归档块 b001，之后开启新会话（server 进程重启）
- **THEN** 新会话中 search_context 仍能命中 b001，decompress 能取回其完整摘要

### Requirement: 关键词检索

`search_context(query, limit)` SHALL 对归档块的 topic、tags 与 summary 做大小写不敏感的关键词匹配（查询词按空白拆分，多词取交集），返回命中块的 ID、topic、类型、时间与命中片段，按相关度排序，默认上限 5 条；中英文关键词均 SHALL 可匹配。

#### Scenario: 中文关键词命中

- **WHEN** 存在 summary 含"压缩优先级"的归档块，调用 search_context("压缩优先级")
- **THEN** 返回该块及含关键词的片段

#### Scenario: 无命中

- **WHEN** 查询词不匹配任何归档块
- **THEN** 返回空结果并说明无命中，而非报错

### Requirement: 按块取回全文

`decompress(blockId)` SHALL 返回指定归档块的完整摘要与元数据；传入不存在的块 ID 时 SHALL 返回错误并列出当前可用块。

#### Scenario: 取回完整摘要

- **WHEN** 调用 decompress("b001") 且 b001 存在
- **THEN** 返回 b001 的完整 summary、tags、type 与创建时间
