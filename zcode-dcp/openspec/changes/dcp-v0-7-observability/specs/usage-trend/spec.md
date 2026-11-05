# Spec Delta

## Purpose

让用户看到"增长多快、还有几轮到压缩线"，无需新增状态文件。

## ADDED Requirements

### Requirement: 计量内嵌趋势环

计量状态文件 SHALL 内嵌 history 数组（上限 60 点，每点含时间/用量/百分比/模型标识/会话标识）；同会话且用量未变化的连续计量点 SHALL 去重（每轮 prompt+stop 双事件只记变化点）；会话标识或模型标识变更时 SHALL 重置环；趋势写路径 MUST NOT 抛出异常影响计量主流程。

#### Scenario: 双事件去重

- **WHEN** 同一会话 prompt 与 stop 相继计量且用量相同
- **THEN** history 仅新增一个点

#### Scenario: 会话切换重置

- **WHEN** 另一会话接管最近活跃写入
- **THEN** history 从该会话重新累积

#### Scenario: 同会话换模型重置

- **WHEN** 同一会话内模型标识发生变化
- **THEN** history 重置，模型切换跳变不进入增速估计

### Requirement: 趋势展示

context_usage SHALL 返回 trend（最近 ≤20 点、最近最多 10 点的平均增速 tokens/轮；增速>0 时给出距 tier3 阈值的预计轮数）；无趋势数据时 MUST NOT 报错。

#### Scenario: 增速与预测

- **WHEN** 最近 10 点用量等差增长 G tokens/轮
- **THEN** trend.avgGrowthTokensPerTurn ≈ G 且 turnsToTier3 为正整数估计

#### Scenario: 无趋势不报错

- **WHEN** usage.json 为旧版本无 history 字段
- **THEN** context_usage 正常返回，无 trend 字段
