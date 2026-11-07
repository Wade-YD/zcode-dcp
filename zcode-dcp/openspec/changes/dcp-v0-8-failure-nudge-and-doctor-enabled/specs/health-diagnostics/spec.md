# Spec Delta

## Purpose

覆盖"装了没启用"与"多个 zcode-dcp 双开导致提醒重复注入"两个真实故障面（补 dcp-v0-7 引入的体检能力）。

## ADDED Requirements

### Requirement: 插件启用状态检查

体检 SHALL 检查插件启用状态：读取 config.json 的 plugins.enabledPlugins（config 文件缺失、解析失败或键缺失时 SHALL 标记 skipped）；以三层规则定位自身——安装目录名拼出的精确 key、唯一 zcode-dcp 条目回退、多条目按启用数裁决；自身条目为禁用 SHALL fail（detail 注明此分支正常不可达，出现即配置语义异常）；存在两个及以上启用的 zcode-dcp SHALL warn 提醒重复注入（列出冲突条目）；仅一个启用条目 SHALL ok；无任何 zcode-dcp 条目 SHALL warn。检查 MUST 保持纯只读。

#### Scenario: 双开重复注入

- **WHEN** enabledPlugins 中两个 zcode-dcp 条目均为 true
- **THEN** plugin_enabled 检查 warn 并列出冲突条目，提示设置 → 插件只保留一个

#### Scenario: config 缺失降级

- **WHEN** config.json 不存在或不可解析或无 enabledPlugins 键
- **THEN** plugin_enabled 检查为 skipped，verdict 不因 skipped 恶化

#### Scenario: 自身被禁

- **WHEN** 定位到的自身条目为 false
- **THEN** plugin_enabled 检查 fail
