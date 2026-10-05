# ZCode DCP — Dynamic Context Pruning

[中文](#简介) | [English](#english)

<a id="简介"></a>

## 简介

ZCode DCP 是一个 [ZCode](https://zcode.ai) 插件，用于**动态管理对话上下文**：

- **真实计量** — 每轮对话自动读取 ZCode 模型 IO 日志，得到当前上下文的真实 token 占用（含缓存读取），而不是靠猜测
- **分级自动提醒** — 占用达到 50% / 70% / 80% 三级阈值时，自动向模型注入逐级升级的压缩提醒（温和归档 → 强制瘦身 → 建议手动压缩），无需你开口
- **承重提示词** — 提醒与工具描述内嵌逐字保留规则（完整路径+行号、报错原文、决策及理由……），归档摘要可 grep、可回溯
- **内容归档** — `compress` 工具把旧的搜索/探索结果、已解决的报错、重复调用归档为摘要，持久化到磁盘
- **随时回溯** — `search_context` 按关键词检索归档块（中英文），`decompress` 取回全文，跨会话有效
- **压缩后召回** — ZCode 内核压缩（compact）发生后，自动向新对话注入归档索引，会话重建不失忆（实验性）

> 一个诚实的说明：ZCode 插件**无法删除对话历史里的消息**（这是内核能力，任何插件都做不到）。本插件做的是「归档瘦身」——它不会让占用条下降；真正释放 token 的是 ZCode 内置压缩（占用约 83% 时自动触发，或手动 `/compact`）。本插件的价值在于：50% 就开始阻止垃圾内容堆积、把重要信息摘要化，让 83% 那次自动压缩丢的信息更少。

## 功能

| 工具 / 命令 | 说明 |
|---|---|
| `compress(topic, summary, tags?, type?)` | 归档不再需要的对话内容为摘要（描述内嵌承重规则） |
| `decompress(blockId)` | 查看已归档块的完整内容 |
| `search_context(query, limit?)` | 按关键词检索归档块（中英文，多词交集） |
| `context_usage` / `/dcp-usage` | 当前真实上下文占用（tokens 与百分比） |
| `context_stats` / `/dcp-stats` | 压缩统计 + 真实占用 |
| `sweep(action)` / `/dcp-sweep` | 扫描可去重的调用与可清理的错误 |
| 自动监控（hook） | 每轮计量；50/70/80% 三级阈值注入分级提醒；内核压缩后注入归档索引 |

## 安装

**方式一：插件市场（推荐）**

1. `git clone https://github.com/Wade-YD/zcode-dcp.git`（或下载解压）
2. ZCode 中打开 **插件市场 → 添加 → 添加插件市场**，粘贴本仓库根目录（含 `marketplace.json` 的那层）
3. 在 **个人** 页找到「DCP 动态上下文压缩」，点击 **安装**
4. 如果安装了官方旧版 `zcode-dcp`，请到 **设置 → 插件** 禁用它，避免重复注入

**方式二：手动**

把 `zcode-dcp/` 目录完整复制到你自己的插件市场目录即可。

## 配置

安装后在 **设置 → 插件 → DCP** 中调整：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `context_window_tokens` | 1000000 | 当前模型的上下文窗口。改准了百分比才算得对（GLM-5.3-Flash 实测约 968K） |
| `nudge_percent` | 50 | tier1 温和提醒阈值（归档旧内容） |
| `tier2_percent` | 70 | tier2 强提醒阈值（停止冗长输出、就地小结、立即归档） |
| `tier3_percent` | 80 | tier3 升级阈值（建议 /compact + 交接摘要） |
| `nudge_growth_tokens` | 30000 | 同级重复提醒的增长步进（与冷却时间双条件，防打扰） |
| `nudge_cooldown_minutes` | 10 | 同级提醒的时间冷却 |
| `auto_watch` | true | 关闭后回到纯手动模式 |

## 工作原理

```
用户发消息 / 一轮结束
        │
        ▼
hook（auto-watch.cjs）读取
~/.zcode/cli/rollout/model-io-sess_<会话ID>.jsonl 最后一行的 usage.inputTokens
        │
        ├─ 写入 ~/.zcode/dcp/usage.json（供 context_usage / context_stats 展示）
        │
        └─ 占用 ≥50% / ≥70% / ≥80% → 注入对应层级的压缩提醒
           （同级重复提醒需同时满足：冷却 10 分钟 且 增长 ≥30000 tokens；
             层级升级立即触发，跳过下级冷却）
                │
                ▼
        输出 additionalContext，向模型注入压缩指令
        （模型随后调用 compress 归档旧内容）
```

归档块持久化于 `~/.zcode/dcp/blocks.json`，跨会话可 `search_context` 检索、`decompress` 取回；内核 compact 发生后，会话启动 hook 会向新对话注入归档索引与当前占用。

## 致谢

分级提醒与压缩规则的提示词工程改写自 [acp-kernel](https://github.com/ranxianglei/acp-kernel)（MIT，@ranxianglei）——其 KEEP VERBATIM 承重规则、压缩优先级清单与防污染条款在生产环境打磨数月，并经事故报告修正（#309 / #442 / #493）。架构上本插件与其同源的 billion-context 代理方案互补：代理路线通过改写 API 请求实现物理压缩，本插件在 ZCode 的签名限制（ClientRequestSigningV4 强制 HTTPS）下提供纯插件面的引导式压缩。

## 已验证环境与已知限制

- ✅ Windows + ZCode 桌面版 + Git Bash + Node.js（hook 包装脚本为 `run-hook.cmd`）
- ⚠️ **macOS / Linux**：把 `hooks/hooks.json` 里的命令换成直接调用 `node auto-watch.cjs`（或写一个 `.sh` 包装）即可，欢迎 PR
- ⚠️ 上下文占用来自上一轮模型请求的 `inputTokens`，是「本轮开始时」的准确值；一轮内大量工具调用造成的增长要等下一轮才可见
- ⚠️ 归档不减少当前 token（见上文说明）
- ⚠️ **压缩后召回（实验性）**：内核 compact 后是否触发会话启动 hook 未经端到端实测（内核源码与官方插件 matcher `startup|clear|compact` 均支持该分支，但缺少真实压缩事件的现场观察）；即使不触发，本特性无害退化。欢迎在真实长会话中验证并反馈

## 开发

零依赖，纯 Node.js（无需 `npm install`）：

```bash
# MCP server 冒烟测试
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node zcode-dcp/dist/mcp/server.js

# 计量脚本测试（用任意真实会话 ID）
echo '{"session_id":"<你的会话ID>","hook_event_name":"UserPromptSubmit"}' \
  | node zcode-dcp/hooks/auto-watch.cjs
```

欢迎 PR：跨平台 hook 包装、压缩后召回的端到端实测反馈、更多压缩策略、占用趋势记录、更好看的统计输出……

## 致谢（Acknowledgements）

The load-bearing prompt rules (KEEP VERBATIM list, compression priority order, anti-contamination clauses) are adapted from [acp-kernel](https://github.com/ranxianglei/acp-kernel) by @ranxianglei (MIT), tuned over months of production use and incident reports (#309/#442/#493).

## License

[MIT](LICENSE)

---

<a id="english"></a>

## English

ZCode DCP is a [ZCode](https://zcode.ai) plugin for dynamic context management: it meters real context usage every turn (from ZCode's model-IO logs), injects tiered compression nudges at 50/70/80% thresholds, and archives stale content (old search results, resolved errors, duplicate tool calls) into searchable, persistent summaries (`search_context` + `decompress`, surviving restarts). After the kernel's built-in compact rewrites the conversation, DCP injects an archive index into the fresh context (experimental).

**Honest note:** ZCode plugins cannot delete messages from conversation history — only the kernel's built-in compact (~83% auto, or manual `/compact`) actually frees tokens. DCP's value is stopping junk accumulation early and summarizing important info before that compact happens.

**Install:** clone this repo → Plugin Marketplace → Add → paste the repo root (contains `marketplace.json`) → Install from Personal. Disable the official `zcode-dcp` if you have it.

**Verified on** Windows (hook wrapper is `run-hook.cmd`); macOS/Linux users: point `hooks/hooks.json` directly at `node auto-watch.cjs` — PRs welcome.

Licensed under MIT.
