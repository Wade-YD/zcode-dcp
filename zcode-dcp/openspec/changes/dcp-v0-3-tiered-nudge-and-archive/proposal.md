# Proposal

## Why

zcode-dcp v0.2.1 有四个实测问题：①计量基准错误——默认窗口 200000 与 GLM-5.3-Flash 实际窗口（约 968K，bili registry-peek 实证；内核从未触发 compact 亦为旁证）严重不符，插件报 99% 时真实占用仅约 20%，所有提醒失真；②nudge 与 compress 提示词过粗，无逐字保留规则，压缩质量不可控（对比 acp-kernel 数月生产打磨的承重规则）；③触发只有单级（50% + 时间冷却），无升级路径与增长步进；④归档仅存 MCP server 进程内存，重启即失，且内核 compact 后无索引召回，"跨压缩不失忆"的核心价值未兑现。

## What Changes

- 计量基准修正：`context_window_tokens` 默认值 200000 → 1000000（与实测 968K 偏差约 3%），配置描述强调按模型实际窗口设置
- 提示词工程（改写自 acp-kernel，MIT，需注明出处）：compress 工具描述与 nudge 文本重写——KEEP VERBATIM 逐字保留清单（带目录的完整路径+行号、签名、报错原文、数值+机制、决策+because、约束、精确值）；摘要=历史记录（"TASK AS OF THIS BLOCK"），未完成目标以 Open objectives 携带；禁止伪造逐字引语；语言保留（摘要保持源会话主语言）；nudge 附压缩优先级清单与"按需压缩"原则
- 三级触发：tier1（≥`nudge_percent`，默认 50%）温和提醒；tier2（≥`tier2_percent`，默认 70%）强提醒（停止冗长输出、就地小结、立即归档）；tier3（≥`tier3_percent`，默认 80%）建议用户 /compact 并要求模型先写交接摘要。tier1 重复触发需同时满足时间冷却（10min）与增长步进（`nudge_growth_tokens`=30000）；tier 升级跳过下级冷却
- 归档持久化：压缩块落盘 `~/.zcode/dcp/blocks.json`，MCP server 启动时加载、compress 时保存
- 新工具 `search_context(query, limit)`：对 topic/tags/summary 做关键词匹配（中文子串匹配，零依赖），返回可配合 decompress 的块列表
- 压缩后索引注入：SessionStart(compact) 注入文本 v2 = 工具说明 + 当前占用 + 归档索引（实验性，compact 分支未实测，失败为无害退化）

## Capabilities

### New Capabilities

- `context-metering`: 真实上下文占用计量——hook 每轮读取 ZCode 模型 IO 日志的 usage.inputTokens，写入 usage.json，按配置窗口计算百分比，经 context_usage / context_stats 查询
- `tiered-compression-nudge`: 分级压缩提醒——三级阈值与升级路径、时间+增长双条件冷却、承重级提示词（逐字保留/历史标注/Open objectives/语言保留）与压缩优先级清单
- `searchable-archive`: 可检索归档——压缩块持久化到 blocks.json、search_context 关键词检索、decompress 取回全文
- `post-compact-recap`: 压缩后召回——内核 compact 触发的 SessionStart 注入归档索引与当前占用

### Modified Capabilities

（无——本项目首个变更）

## Impact

- 代码：`plugin.json`（版本 0.3.0 + 新增 tier2_percent / tier3_percent / nudge_growth_tokens 配置）、`hooks/auto-watch.cjs`（分级逻辑、增长追踪、新文本）、`dist/mcp/server.js`（blocks.json 持久化 + search_context 工具）、`README.md`（acp-kernel 出处致谢、配置说明）
- 状态文件：blocks.json 为新增；nudge.json 结构升级为 `{lastNudgeAt, lastNudgeTokens, lastTier}`，旧文件缺失字段时按重置处理
- 兼容性：无破坏性变更；旧 usage.json 可直接被新版本读取
- 交付链：源码目录改动后同步至 GitHub 仓库（Wade-YD/zcode-dcp）并 push；marketplace.json 版本同步
- 成本：compress 工具描述约 +400 tokens（每会话一次），nudge 文本约 +200 tokens/次
- 明确不做：物理删除对话消息（仅内核有能力）；窗口自动探测（v0.4 候选）；macOS/Linux hook 包装（等社区 PR）
