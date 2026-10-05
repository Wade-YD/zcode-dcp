# Design

## Context

架构现状（v0.2.1）：hook（`hooks/auto-watch.cjs`，经 `run-hook.cmd` → node 调用）在每轮 UserPromptSubmit/Stop 读取 `~/.zcode/cli/rollout/model-io-sess_<sid>.jsonl` 最后一行的 `usage.inputTokens`，写入 `~/.zcode/dcp/usage.json`；占用 ≥ `nudge_percent` 时经 `additionalContext` 注入提醒（nudge 状态在 `~/.zcode/dcp/nudge.json`）；MCP server（`dist/mcp/server.js`，零依赖 JSON-RPC）提供 compress/decompress/context_stats/context_usage/sweep，压缩块仅存进程内存。约束：Windows 专用 cmd 包装；插件无删除对话消息能力（ZCode 内核限制）；内核自动 compact 阈值 = 真实窗口 − 34K，不可配置。动机见 proposal.md Why，不赘述。

## Goals / Non-Goals

**Goals:**

- 百分比与真实占用对齐（默认窗口改 1,000,000，实测 968K 偏差约 3%）
- 压缩产物可检索、可回溯：逐字保留清单保证 grep/decompress 可用；blocks.json 落盘保证重启不失
- 提醒分级且防打扰：三级阈值 + 时间/增长双条件冷却 + 升级跳级
- 内核 compact 后模型能立即看到归档索引（实验性）

**Non-Goals:**

- 物理删除对话消息或改写 API 请求（代理类方案在 ZCode 被 ClientRequestSigningV4 强制 HTTPS 挡死，见 billion-context 安装记录 #1621）
- 模型窗口自动探测（v0.4 候选：观测内核 compact 事件反推真实窗口）
- macOS/Linux hook 包装、cache 命中率账本、LSM 多级蒸馏（无物理介质，不适用）

## Decisions

### D1 默认窗口 = 1,000,000

与实测 968K 偏差约 3%（真用满 968K 时显示 96.8%），可接受；比 200K 的"报 99% 实则 20%"好一个数量级。备选 968000 被否：模型特化值不宜做通用默认，且用户已明确选择 1M。README 与配置描述必须强调"按模型实际窗口修改"；小窗口模型用户不改会导致提醒永不触发——这是文档责任，不做代码兜底。

### D2 提示词：改写 acp-kernel 承重规则，适配插件语义

来源：`acp-kernel/src/compression-rules.ts`（MIT，ranxianglei），README 注明 "adapted from acp-kernel"。三处适配：

1. bili 用消息编号 mNNNNN 引用区间——我们没有消息级引用，compress 描述改为"禁止伪造逐字引语：引用用户原话必须注明所处阶段/主题，记不清就转述"（防其事故 #309：编造引语被当现行指令导致任务死循环）
2. 压缩块语义对齐：摘要标注 "TASK AS OF THIS BLOCK"（历史非现行指令）；`Open objectives:` 逐条携带未完成目标（防其事故 #442）
3. 语言保留（其 #493，opt-in）在我们这里直接设为默认——中文用户刚需

备选"自写提示词"被否：承重规则经生产事故打磨，自写等于重交学费。

### D3 分级触发与冷却

```
占用%             动作
----------------------------------------
>= nudge_percent  tier1 温和：归档旧内容
 (50)             重复条件：距上次 >=10min 且
                  增长 >= nudge_growth_tokens(30k)
v
>= tier2_percent  tier2 强：上述 + 停止冗长输出/就地小结/立即归档
 (70)             首次触发跳过 tier1 冷却；同级按 tier2 冷却(10min)
v
>= tier3_percent  tier3 升级：建议用户 /compact（主动压比 83% 内核
 (80)             被动压可控）+ 要求模型先写交接摘要
```

- nudge.json 升级为 `{lastNudgeAt, lastNudgeTokens, lastTier}`；旧文件缺字段按重置处理（最多多提醒一次，无害）
- 增长步进与百分比**双条件**：只看百分比会打扰稳定会话，只看步进会在低占用时就响——两者取且
- tier 判定每轮都算（usage.json 照常更新），只是"是否注入"由冷却门控

### D4 归档持久化与检索

- `~/.zcode/dcp/blocks.json`：`{blocks: [...], nextBlockId}`；server 启动时存在即加载，compress 后同步写盘；写失败静默（保持内存可用）
- `search_context(query, limit=5)`：topic/tags/summary 拼接后做大小写不敏感的关键词子串匹配（中文无需分词，零依赖）；返回 `[{blockId, topic, type, createdAt, snippet}]`，snippet 为首个命中位置前后各 60 字符；多关键词按空格拆分取 AND，命中多的块排前
- 备选 SQLite 被否：零依赖原则，JSON 在百块规模足够

### D5 压缩后索引注入（实验性）

SessionStart hook 已配 matcher `startup|clear|compact`，注入文本 v2 = 工具说明 + 当前占用（usage.json）+ 归档索引（blocks.json 的 blockId+topic 列表，含 type）+ "细节用 search_context/decompress"。compact 分支未实测：若内核 compact 后不触发 SessionStart，特性空转但无害；实测方法为新会话推到 ~83% 观察一次。

## Risks / Trade-offs

- [提示词变长增加固定成本（compress 描述 +~400 tokens/会话，nudge +~200/次）] → 相对压缩收益可接受；nudge 文本只在超阈值时注入，平时零成本
- [tier 阈值默认值未必合所有用户习惯] → tier2_percent/tier3_percent/nudge_growth_tokens 全部进 userConfig 可调
- [blocks.json 并发写（hook 与 server 同时写）] → 写路径唯一（server 的 compress 与 hook 的 nudge 都只读写各自文件），无交叉；blocks.json 仅 server 写
- [1M 默认对小窗口模型失真] → 文档明示；后续可加"窗口白名单"提示（不进本版）
- [compact 后 SessionStart 不触发] → 特性空转无害，实测后再决定是否强化

## Migration Plan

1. 版本 0.3.0，marketplace.json 同步；用户在 UI"市场源刷新 → 更新"
2. 更新后首轮流：旧 nudge.json 缺新字段按重置处理；usage.json 直接兼容；blocks.json 首次 compress 生成（旧内存归档不迁移——接受丢失，历史价值低）
3. 回滚：UI 退回 0.2.0/0.2.1 安装包即可，状态文件向后兼容无需清理

## Open Questions

- kernel compact 后 SessionStart(compact) 是否实际触发——待实测（D5），不影响其他部分的实现与规格
- tier3 是否追加 Stop hook block 机制（强制模型先写交接摘要再停轮）——内核有 `stop_hook_active` 字段但输出契约未验证，留待 v0.4 实验
