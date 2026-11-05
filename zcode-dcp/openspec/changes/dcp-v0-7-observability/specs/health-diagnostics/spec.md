# Spec Delta

## Purpose

用户与运维无需翻文件即可判断插件各链路是否健康：一个只读工具给出逐项检查与总体结论。

## ADDED Requirements

### Requirement: 只读体检工具

插件 SHALL 提供 dcp_doctor MCP 工具（无参数），对状态目录、配置健全性、计量链路、归档健康、压缩统计、窗口校准、陈旧会话状态、调试日志与 hook 命令形态执行检查；工具 MUST NOT 写入或删除任何文件（读取配置与状态文件除外），每个检查 MUST 独立捕获异常，单检查失败 MUST NOT 影响其余检查输出。

#### Scenario: 全部健康

- **WHEN** 状态目录齐全、usage 新鲜、tier 递增、归档可解析
- **THEN** 各检查 status 为 ok，verdict 为 "ok"

#### Scenario: 单检查异常不拖垮整体

- **WHEN** 某状态文件损坏导致该检查抛错
- **THEN** 该检查 status 为 fail 并含错误摘要，其余检查照常输出

### Requirement: verdict 聚合与 skipped

verdict SHALL 按"任一 fail → fail，否则任一 warn → warn，否则 ok"聚合，skipped 不参与聚合；状态目录不存在时依赖状态文件的检查 SHALL 标记为 skipped 而非连环 warn。

#### Scenario: 刚安装用户

- **WHEN** 状态目录尚不存在
- **THEN** 依赖状态目录的检查为 skipped 且 detail 说明，verdict 不因 skipped 恶化

### Requirement: 计量链路与配置健全性检查

体检 SHALL 检查：模型 IO 日志目录存在与最新文件相对 usage.json 的更新时序（最新 rollout 文件比 usage.json 新超 10 分钟 → warn 提示 hook 未在跑；rollout 本身陈旧 → ok/info 注明当前无活跃会话）；tier 阈值严格递增（破坏 → fail，detail 注明不含环境变量覆盖）；窗口跑在默认值且占用已达提醒阈值 → warn 提示占用可能被低估；config.json 存在但不可解析 → warn 提示配置通道失效。

#### Scenario: hook 停止写入

- **WHEN** 最新 model-io 文件比 usage.json 新 10 分钟以上
- **THEN** metering 检查 warn 指向 hook 未运行或未批准启用

#### Scenario: tier 配置破坏

- **WHEN** tier2_percent 小于 nudge_percent
- **THEN** config 检查 fail 指出阈值顺序错误

### Requirement: hook 命令形态守卫

体检 SHALL 校验插件自身 hooks.json 的每条 hook 命令为 node 直调且包含 auto-watch.cjs，否则 fail（跨平台回归守卫）。

#### Scenario: 命令形态回归

- **WHEN** hooks.json 出现非 node 直调命令
- **THEN** hooks_shape 检查 fail
