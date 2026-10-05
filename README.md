# ZCode DCP — Dynamic Context Pruning

[中文](#简介) | [English](#english)

<a id="简介"></a>

## 简介

ZCode DCP 是一个 [ZCode](https://zcode.ai) 插件，用于**动态管理对话上下文**：

- **真实计量** — 每轮对话自动读取 ZCode 模型 IO 日志，得到当前上下文的真实 token 占用（含缓存读取），而不是靠猜测
- **阈值自动提醒** — 占用超过阈值（默认 50%）时，自动向模型注入压缩提醒，让模型立即归档旧内容，无需你开口
- **内容归档** — `compress` 工具把旧的搜索/探索结果、已解决的报错、重复调用归档为可检索的摘要，重要信息永不丢
- **随时回溯** — `decompress` 可以找回任何归档块的完整内容

> 一个诚实的说明：ZCode 插件**无法删除对话历史里的消息**（这是内核能力，任何插件都做不到）。本插件做的是「归档瘦身」——它不会让占用条下降；真正释放 token 的是 ZCode 内置压缩（占用约 83% 时自动触发，或手动 `/compact`）。本插件的价值在于：50% 就开始阻止垃圾内容堆积、把重要信息摘要化，让 83% 那次自动压缩丢的信息更少。

## 功能

| 工具 / 命令 | 说明 |
|---|---|
| `compress(topic, summary, tags?, type?)` | 归档不再需要的对话内容为摘要 |
| `decompress(blockId)` | 查看已归档块的完整内容 |
| `context_usage` / `/dcp-usage` | 当前真实上下文占用（tokens 与百分比） |
| `context_stats` / `/dcp-stats` | 压缩统计 + 真实占用 |
| `sweep(action)` / `/dcp-sweep` | 扫描可去重的调用与可清理的错误 |
| 自动监控（hook） | 每轮计量；≥阈值自动注入压缩提醒 |

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
| `nudge_percent` | 50 | 自动提醒阈值（占用百分比）。嫌提醒频繁可调到 60–70 |
| `context_window_tokens` | 200000 | 当前模型的上下文窗口。改准了百分比才算得对 |
| `nudge_cooldown_minutes` | 10 | 两次自动提醒的最小间隔 |
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
        └─ 占用 ≥ nudge_percent 且已过冷却期
                │
                ▼
        输出 additionalContext，向模型注入压缩指令
        （模型随后调用 compress 归档旧内容）
```

压缩块存于 MCP server 进程内存（会话内有效），新会话从空状态开始；ZCode 内置 compact 不会影响归档（server 进程存活于整个会话周期）。

## 已验证环境与已知限制

- ✅ Windows + ZCode 桌面版 + Git Bash + Node.js（hook 包装脚本为 `run-hook.cmd`）
- ⚠️ **macOS / Linux**：把 `hooks/hooks.json` 里的命令换成直接调用 `node auto-watch.cjs`（或写一个 `.sh` 包装）即可，欢迎 PR
- ⚠️ 上下文占用来自上一轮模型请求的 `inputTokens`，是「本轮开始时」的准确值；一轮内大量工具调用造成的增长要等下一轮才可见
- ⚠️ 归档不减少当前 token（见上文说明）

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

欢迎 PR：跨平台 hook 包装、更多压缩策略、占用趋势记录、更好看的统计输出……

## License

[MIT](LICENSE)

---

<a id="english"></a>

## English

ZCode DCP is a [ZCode](https://zcode.ai) plugin for dynamic context management: it meters real context usage every turn (from ZCode's model-IO logs), auto-injects a compression nudge into the conversation once usage crosses a threshold (default 50%), and archives stale content (old search results, resolved errors, duplicate tool calls) into retrievable summaries.

**Honest note:** ZCode plugins cannot delete messages from conversation history — only the kernel's built-in compact (~83% auto, or manual `/compact`) actually frees tokens. DCP's value is stopping junk accumulation early and summarizing important info before that compact happens.

**Install:** clone this repo → Plugin Marketplace → Add → paste the repo root (contains `marketplace.json`) → Install from Personal. Disable the official `zcode-dcp` if you have it.

**Verified on** Windows (hook wrapper is `run-hook.cmd`); macOS/Linux users: point `hooks/hooks.json` directly at `node auto-watch.cjs` — PRs welcome.

Licensed under MIT.
