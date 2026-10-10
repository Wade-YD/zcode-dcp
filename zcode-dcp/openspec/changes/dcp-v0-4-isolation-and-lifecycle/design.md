# Design

## Context

v0.3.0 架构与内核事实见已归档变更 dcp-v0-3-tiered-nudge-and-archive。新增关键事实：内核 hook 事件枚举不含 PostCompact（压缩事件只是内部事件，payload 含 pre/postCompactTokenCount）；PostToolUse hook 的 stdin 含 tool_name/tool_input/tool_response；hook stdin 基础字段含 cwd 与 session_id。

## Goals / Non-Goals

**Goals:** 多会话/多项目并发正确性；归档长期健康；压缩事件可观测；真实窗口自动逼近；大工具结果即时蒸馏引导。

**Non-Goals:** 隐藏或删除工具结果原文（内核独占）；PostCompact hook 注册（非 hook 事件）；跨项目全局记忆模式的产品化（仅保留 global 开关）；自动合并重复归档（只提示，遵 #442 教训）。

## Decisions

### D1 骤降检测替代 PostCompact
判定：`used < prev.used * 0.6 且 prev.used > 20000`。误报来源（会话回退、换模型）后果仅是多一次召回注入，无害。检测到后：记 compact-stats（保存最近 20 条）、重置该会话提醒状态、prompt 模式即时注入归档索引。SessionStart(compact) 召回保留（两条腿走路）。

### D2 窗口校准
压缩触发点 ≈ window − 34K（内核常量），observedWindow = compact 前用量 + 34000；保留最近 5 观测取中位数。生效优先级：显式 userConfig（config.json 存在值）> env > 校准值（≥2 观测）> 默认 1M。context_usage 返回 windowSource 字段。

### D3 会话隔离
nudge 状态文件 `nudge-<sid 清洗>.json`；计量严格匹配——session_id 存在但其 rollout 文件不存在时不计量（废除跨会话兜底，这是并发污染根源）；无 session_id 时保留"最近修改"兜底。全局 usage.json 仍写（server 显示最近活跃会话）。

### D4 项目命名空间
`archive_scope`=project（默认）|global。命名空间文件 `blocks-<sha1(cwd|DCP_PROJECT_DIR) 前 12 位>.json`；hook 与 server 用同一规则（hook 用 input.cwd，server 用 env DCP_PROJECT_DIR）；namespace 文件缺失而旧全局 blocks.json 存在时一次性种子迁移。scope=global 时行为与 v0.3.0 一致。

### D5 归档蒸馏与重复提示
超过 max_blocks（默认 200）时蒸馏最旧 ceil(20%) 块：合并块 summary 按 `## <topic>` 分节（每节截断 800 字符）+ 逐字保留各块匹配 /^open objectives/im 的行（#442）。compress 返回 possibleDuplicates（topic 归一化后完全相等才提示，不自动合并）。

### D6 absorb-lite
PostToolUse hook（tool 模式）：tool_response 字符数/4 ≈ tokens，≥ absorb_min_tool_tokens（默认 8000）且该会话距上次注入 ≥10 分钟 → 注入蒸馏提示（要点：结论/精确值/路径:行号/报错原文；"以归档为准，不要重跑该工具"）。改写自 acp-kernel absorb.ts 的 buildAbsorbPrompt（MIT）。

## Risks / Trade-offs

- [tool_response 体积大导致 hook 读取慢] → stdin 全量读取仅字符串处理，实测 JSON 序列化由 ZCode 完成，hook 8s 超时兜底
- [命名空间哈希冲突] → sha1 前 12 位，实际不可行碰撞，忽略
- [蒸馏丢信息] → 每节截断 800 字符 + Open objectives 逐字保留；蒸馏块 type=general 可 search_context 命中后按块名追溯
- [absorb 提示打扰] → 双重限流（token 阈值 + 会话级冷却），配置可关

## Migration Plan

0.4.0 安装后首轮流：旧 nudge.json 自动废弃（新文件按 sid 命名）；旧 blocks.json 在首个 compress/session-start 时种子迁移到命名空间文件。回滚：UI 退回 0.3.0，命名空间文件成为孤儿可手删。

## Open Questions

- 骤降阈值 0.6 与 20K 下限在真实压缩事件上的命中率——待实测（compact-stats 会累积数据验证）
