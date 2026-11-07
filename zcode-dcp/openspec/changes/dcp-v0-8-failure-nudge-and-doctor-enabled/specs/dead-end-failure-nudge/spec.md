# Spec Delta

## Purpose

工具反复失败是"走不通的探索"的前置信号——在失败路径上及时提醒归档教训，别等压缩时才丢。

## ADDED Requirements

### Requirement: 死胡同失败提醒

插件 SHALL 注册 PostToolUseFailure hook：同会话同一工具的失败计数达到阈值（userConfig failure_nudge_threshold，默认 2，0=关闭）时注入 additionalContext 提醒（报告连续失败次数，引导 compress 归档教训——报错原文逐字保留——后换路径或继续修复）；is_interrupt 为真 SHALL 不计数不提醒；同工具成功 SHALL 清零该工具计数；距上次失败超 30 分钟 SHALL 重置计数重计；触发提醒后计数 SHALL 归零并进入 15 分钟冷却（冷却期内重新积满不再提醒）；auto_watch 为 false 时 SHALL 整条跳过；所有写路径 MUST NOT 抛出异常中断 hook 主流程。

#### Scenario: 两连败触发

- **WHEN** 同会话同一工具累计失败达到阈值 2
- **THEN** 注入提醒文本，含工具名、失败次数与 compress 归档指引

#### Scenario: 触发后需重新积满

- **WHEN** 提醒触发后同工具再次失败 1 次（冷却 15 分钟已过）
- **THEN** 不提醒（计数从零重计，未再积满阈值）

#### Scenario: 冷却期内不重复

- **WHEN** 提醒触发后 15 分钟内同工具再次积满阈值
- **THEN** 不注入提醒，计数重置

#### Scenario: interrupt 不计

- **WHEN** 事件携带 is_interrupt=true
- **THEN** 不写失败计数、不提醒

#### Scenario: 成功清零

- **WHEN** 同工具此前有失败计数，随后该工具一次成功调用（PostToolUse）
- **THEN** 该工具计数清除

#### Scenario: 陈旧衰减

- **WHEN** 同工具两次失败间隔超过 30 分钟
- **THEN** 计数从 1 重计（不叠加旧值）

#### Scenario: 阈值关闭与配置通道

- **WHEN** failure_nudge_threshold 为 0（env 或 config）
- **THEN** 不写失败状态、不提醒；threshold=3 时两次失败不触发

### Requirement: 失败状态治理与隐私

失败状态存于 failure-<sid>.json（仅工具名/计数/时间戳），SHALL 纳入 dcp_reset 白名单、归类与 purge 覆盖，并计入体检的陈旧会话检查；记录 MUST NOT 包含报错原文或错误对象内容。

#### Scenario: purge 纳管

- **WHEN** dcp_reset list
- **THEN** failure-*.json 归类为插件状态（owned=true）且 purge 可清除

#### Scenario: 不落报错原文

- **WHEN** 任意失败事件发生（含调试日志开启）
- **THEN** 状态文件与调试日志均不含 error 原文片段
