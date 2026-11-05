# Spec Delta

## Purpose

用户报"没提醒/没计量"时可自助取证：opt-in 的元数据级调试日志。

## ADDED Requirements

### Requirement: 双通道开关

调试日志 SHALL 由 userConfig debug_log（boolean，默认 false）或环境变量 DCP_DEBUG 开启；环境变量 SHALL 优先于配置（临时开关不改配置）；关闭时 MUST 无写盘开销。

#### Scenario: 配置开启

- **WHEN** debug_log 为 true
- **THEN** 每次 hook 执行向调试日志追加决策记录

#### Scenario: env 覆盖

- **WHEN** debug_log 为 false 但环境变量 DCP_DEBUG=1
- **THEN** 调试日志开启

#### Scenario: 关闭零开销

- **WHEN** 双通道均关闭
- **THEN** hook 不打开也不写调试日志文件

### Requirement: 日志内容与轮转

日志文件为状态目录下 dcp-debug.log，JSON lines 追加写，超过 512KB 轮转为 .1（只保留一代，轮转失败 MUST 静默继续追加）；记录 MUST 仅含元数据（时间/模式/事件/会话标识/模型标识/tokens/窗口来源/决策与原因/错误摘要），MUST NOT 记录 prompt 文本、工具响应内容或归档摘要；日志写路径 MUST NOT 抛出异常中断 hook 主流程；dcp_reset 白名单 SHALL 纳入该日志及其轮转文件。

#### Scenario: 轮转

- **WHEN** 日志超过 512KB 后再次追加
- **THEN** 原文件更名为 .1，新内容写回主文件

#### Scenario: 隐私红线

- **WHEN** 任意 hook 事件发生
- **THEN** 日志行不含 prompt 或工具结果正文

#### Scenario: purge 纳管

- **WHEN** dcp_reset list
- **THEN** dcp-debug.log 归类为插件状态且 purge 可清除
