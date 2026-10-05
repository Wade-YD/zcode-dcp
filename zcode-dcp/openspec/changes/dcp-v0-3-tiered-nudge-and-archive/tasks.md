# Tasks

## 1. 计量基准（context-metering）

- [x] 1.1 `plugin.json`：`context_window_tokens` 默认值改为 1000000，描述注明"按所用模型实际窗口设置"；版本号升到 0.3.0；新增 `tier2_percent`(70)、`tier3_percent`(80)、`nudge_growth_tokens`(30000) 三个配置项。验证：`node -e "JSON.parse(...)"` 解析通过且默认值正确
- [x] 1.2 `hooks/auto-watch.cjs`：DEFAULTS 与配置读取同步 1M 默认与新配置项；usage.json 写入 tier2/tier3 阈值。验证：模拟 stdin 跑一次 stop 模式，检查 usage.json 字段
- [x] 1.3 `dist/mcp/server.js`：context_usage / context_stats 的返回包含基准说明字段（百分比相对配置窗口）。验证：冒烟脚本调用 context_usage 检查输出字段

## 2. 提示词工程（tiered-compression-nudge 文本）

- [x] 2.1 `dist/mcp/server.js`：重写 compress 工具 description——KEEP VERBATIM 逐字保留清单（完整路径+行号/签名/报错原文/数值+机制/决策+because/约束/精确值）、摘要=历史记录（TASK AS OF THIS BLOCK）、Open objectives 携带、禁伪造引语、语言保留。验证：tools/list 输出包含上述要素
- [x] 2.2 `hooks/auto-watch.cjs`：编写三级提醒文本生成函数，tier1/tier2/tier3 分别含压缩优先级清单与逐字保留要求（tier2 增加停止冗长输出，tier3 增加 /compact 建议与交接摘要要求）。验证：三种事件模拟输入下检查 additionalContext 文本要素

## 3. 分级触发逻辑（tiered-compression-nudge 行为）

- [x] 3.1 `hooks/auto-watch.cjs`：实现三级判定与注入；tier1 双条件冷却（距上次 ≥10min 且增长 ≥nudge_growth_tokens）；tier 升级跳过下级冷却；nudge.json 升级为 {lastNudgeAt, lastNudgeTokens, lastTier}，旧文件缺字段按重置处理。验证：模拟脚本覆盖 tier1 触发/冷却拒绝/升级跳级三例
- [x] 3.2 全链路回归：`printf` 模拟 hook 输入跑 prompt/stop/session-start 三种模式，确认无崩溃、静默失效（坏输入、缺文件）符合 spec。验证：所有用例 exit 0 且输出符合预期

## 4. 归档持久化与检索（searchable-archive）

- [x] 4.1 `dist/mcp/server.js`：blocks 持久化到 `~/.zcode/dcp/blocks.json`（启动加载、compress 后写盘、写失败静默降级）。验证：compress 后杀进程重开，decompress 仍可取回
- [x] 4.2 `dist/mcp/server.js`：新增 search_context(query, limit=5) 工具——关键词子串匹配（大小写不敏感、多词交集）、返回 blockId/topic/类型/时间/命中片段、无命中返回空并说明。验证：冒烟脚本写入中文与英文块后检索命中，无命中用例返回空

## 5. 压缩后索引注入（post-compact-recap，实验性）

- [x] 5.1 `hooks/auto-watch.cjs`：session-start 注入文本 v2——工具说明 + 当前占用（usage.json）+ 归档索引（blocks.json 的 blockId+topic）+ 检索/取回说明；无数据时分段退化为常规说明。验证：分别以"有 blocks.json/无 blocks.json"两种状态跑 session-start 模式检查输出
- [ ] 5.2 实测 compact 分支：新会话推高占用等待内核压缩，观察压缩后 SessionStart 是否触发、注入内容是否含索引。验证：记录实测结论（触发或不触发均记录），若不触发在 README 标注实验性

## 6. 交付

- [x] 6.1 `README.md`：更新配置表（4 个新配置项 + 1M 默认）、提示词出处致谢（adapted from acp-kernel, MIT, @ranxianglei）、post-compact-recap 实测结论；同步 `marketplace.json` 版本。验证：README 渲染检查、版本三处一致（plugin.json/marketplace.json/README）
- [ ] 6.2 全量冒烟：MCP 握手 + tools/list（6 个工具）+ compress/decompress/search_context/context_usage/sweep 各调用一遍；按发布链同步源码目录 → GitHub 仓库副本 → commit/push。验证：远端 main 包含全部改动且版本一致
