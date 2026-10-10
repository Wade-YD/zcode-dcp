# Spec Delta

## Purpose

归档的长期健康与边界：按项目隔离归档命名空间，控制块数量增长（蒸馏最旧块并保留开放目标），提示重复主题；并对超大工具结果提供即时蒸馏引导（absorb-lite，实验性）。

## ADDED Requirements

### Requirement: 归档按项目命名空间

归档块 SHALL 按 `archive_scope` 配置隔离：project（默认）时按项目目录哈希分文件存储，global 时全局共享；hook 与 server 对同一项目 SHALL 解析到同一命名空间；首次使用项目命名空间时 SHALL 从旧全局归档文件种子迁移（若存在）。

#### Scenario: 项目间互不可见

- **WHEN** 项目 A 归档块 b001 后，在项目 B 的会话中检索
- **THEN** 项目 B 的检索不命中 b001

#### Scenario: 同项目跨端一致

- **WHEN** hook（以 cwd）与 server（以项目目录）解析命名空间
- **THEN** 两者得到同一存储文件

### Requirement: 归档数量上限与蒸馏

归档块数量超过 `max_blocks`（默认 200）时，插件 SHALL 把最旧的约 20% 块蒸馏合并为一个新块：分节保留各块 topic 与截断摘要（每节至多 800 字符），且各块中开放目标（Open objectives）行 SHALL 逐字保留。

#### Scenario: 超限触发蒸馏

- **WHEN** max_blocks 为 5 且已有 5 块时再归档第 6 块
- **THEN** 最旧的 1 块被蒸馏合并，总块数回落到 5

#### Scenario: 开放目标逐字保留

- **WHEN** 被蒸馏块的摘要含 "Open objectives: 修复启动崩溃" 行
- **THEN** 蒸馏块的对应分节中原样包含该行

### Requirement: 重复主题提示

compress 的 topic 与既有块主题归一化后完全相同时，SHALL 在返回中列出既有的块 ID（possibleDuplicates）并建议考虑合并；SHALL NOT 自动删除或合并既有块。

#### Scenario: 同名主题提示

- **WHEN** 已存在 topic 为"压缩优先级研究"的块，再次以相同 topic（不同大小写/空白）归档
- **THEN** 返回中列出该既有块 ID

### Requirement: 超大工具结果即时蒸馏提示

当工具响应的估算 token 数达到 `absorb_min_tool_tokens`（默认 8000）且该会话距上次此类注入不少于 10 分钟时，插件 SHALL 在该工具调用后注入蒸馏提示：要求立即把该结果的要点（结论、精确值、路径:行号、报错原文）归档，其后以归档为准；未达阈值或冷却未到时 SHALL NOT 注入。

#### Scenario: 大结果触发提示

- **WHEN** 一个约 10000 tokens 的工具结果返回且本会话 10 分钟内无此类注入
- **THEN** 注入 absorb 蒸馏提示

#### Scenario: 冷却内不重复

- **WHEN** 5 分钟内另一个大结果返回
- **THEN** 不注入
