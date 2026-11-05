# Spec Delta

## Purpose

把"内核压缩到底省了多少"变成可查的累计账本，对位 billion-context 的压缩经济学。

## ADDED Requirements

### Requirement: 节省账本增量累计

压缩统计文件 SHALL 维护 totals（totalEvents/totalSaved/since/perModel/perDay）：每次检出压缩事件时增量累计；totals SHALL 自启用版本从零起算（不回填历史 events，since 记录首条累计起点）；MUST NOT 每次从 events 数组重算 totals（events 仅保留近期条数，重算会系统性低估）；perDay 键 SHALL 从事件时间戳的 UTC 日期派生。

#### Scenario: 连续压缩累计

- **WHEN** 同一进程先后检出 2 次压缩（节省 X1、X2）
- **THEN** totals.totalEvents 为 2 且 totalSaved 为 X1+X2，与 events 数组当前条数无关

#### Scenario: perDay 按 UTC 分桶

- **WHEN** 事件时间戳为 UTC 23 时与次日 01 时
- **THEN** perDay 落在两个不同 UTC 日期键

### Requirement: 账本展示与清理

context_stats SHALL 展示 savings（含 since、总数与近 7 天 perDay，近 7 天 SHALL 从 totals.perDay 取而非 events）；压缩召回文本在历史累计次数 >1 时 SHALL 追加累计行；dcp_reset purge 清除账本（与全部插件状态同语义）。

#### Scenario: 展示近 7 天

- **WHEN** totals.perDay 含 10 个日期键
- **THEN** context_stats 的 savings 仅含最近 7 个 UTC 日期的键

#### Scenario: purge 后归零

- **WHEN** 用户确认 purge
- **THEN** 账本随压缩统计文件一并清除
