# Proposal

## Why

两个遗留问题：①窗口与校准是全局的——用户切换模型（如 968K 的 GLM-5.3-Flash ↔ 128K/200K 模型）时百分比整体失真，且高窗口模型的压缩观测会污染低窗口模型的校准（观测中位数被拉飞，分级提醒随之失准）；②hook 经 Windows 专用 `run-hook.cmd` 包装，macOS/Linux 无法开箱使用——README 承诺社区 PR 半年未至，而 mcpServers 本就以 `command: "node"` 运行，证明 ZCode 可直接解析 node，包装层是多余的。

## What Changes

- **计量携带模型**：readLatestUsage 解析 rollout 日志行的 `model.modelId`，usage.json / compact-stats 事件记录 modelId；context_usage 返回当前模型
- **校准按模型隔离**：窗口校准观测写入 `window-calibration-<modelSlug>.json`；查询按当前模型的观测文件取中位；该模型无专属观测时回退读旧全局 `window-calibration.json`（平滑迁移，旧用户零感知）；显式配置（非默认值）仍全局优先
- **跨平台 hook**：hooks.json 的命令改为直接 `node "${CLAUDE_PLUGIN_ROOT}/hooks/auto-watch.cjs"`（模式推断兜底 argv 丢失已有）；删除 Windows 专用 `run-hook.cmd`；README 移除"macOS/Linux 需改 hooks.json"限制条款

## Capabilities

### New Capabilities

- `model-scoped-metering`: 计量与窗口校准按模型隔离——usage/压缩事件携带模型，校准观测与生效窗口按当前模型解析，跨模型不污染

### Modified Capabilities

（无——hook 命令跨平台化为实现细节，session-isolation/tiered-compression-nudge 的既有需求不变）

## Impact

- 代码：`hooks/auto-watch.cjs`（readLatestUsage 带 model、校准读写按 modelSlug 分文件+回退、writeUsage/detectCompact 带模型）、`hooks/hooks.json`（node 直调）、删除 `hooks/run-hook.cmd`、README（平台支持与限制条款）
- 状态文件：新增 `window-calibration-<modelSlug>.json`；旧 `window-calibration.json` 保留为回退源不迁移；usage.json/compact-stats 增 modelId 字段（旧文件缺字段按 null 容忍）
- 平台：Windows/macOS/Linux 开箱可用（CI ubuntu 矩阵已证脚本无平台依赖）
- 兼容：无破坏性；v0.5.2 的校准解锁语义不变（显式非默认配置 > 按模型校准 > 默认）
