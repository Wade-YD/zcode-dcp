# Tasks

## 1. 跨模型窗口隔离（model-scoped-metering）

- [x] 1.1 `hooks/auto-watch.cjs`：readLatestUsage 解析 `model.modelId`（清洗为 modelSlug）；recordCalibration/calibratedWindow 按 `window-calibration-<slug>.json` 读写，slug 文件缺失回退旧全局文件；effectiveWindow 接受当前模型；writeUsage/detectCompact 记录 modelId。验证：双模型模拟互不污染 + 回退 + 显式优先三态
- [x] 1.2 既有套件回归（v052 校准解锁用例必须仍绿——回退逻辑兼容旧全局文件）。验证：runner 全绿

## 2. 跨平台 hook

- [x] 2.1 `hooks/hooks.json`：命令改 `node "${CLAUDE_PLUGIN_ROOT}/hooks/auto-watch.cjs"`；删除 `hooks/run-hook.cmd`；README 移除平台限制条款、平台支持标注三平台。验证：静态断言 + 本机真实 hook 输入冒烟（node 直调路径）
- [x] 2.2 新套件 `tests/smoke-v06.js`（模型隔离/回退/显式优先/hooks.json 形态/版本）并入 run-all。验证：runner 全绿

## 3. 发布（验收后）

- [x] 3.1 版本 0.6.0 全套同步；Oracle 验收通过后 push + tag v0.6.0 + CI 绿。验证：远端一致
