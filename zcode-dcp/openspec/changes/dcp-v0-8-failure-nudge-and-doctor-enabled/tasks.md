# Tasks

## 1. hook（hooks/hooks.json + hooks/auto-watch.cjs）

- [x] 1.1 hooks.json 注册 PostToolUseFailure（mode "failure"，node 直调同形态）
- [x] 1.2 mode 解析：byEvent 加 PostToolUseFailure→failure，mode 正则放宽含 failure
- [x] 1.3 failureFileFor(sid) + maybeFailureNudge（per-tool 计数/30 分钟陈旧衰减/阈值触发+15 分钟冷却+触发归零/is_interrupt 跳过/全路径绝不 throw/dlog 埋点；计数分支保留 lastNudgeAt——验收实验证实为冷却语义承重墙）
- [x] 1.4 成功重置：tool 模式分支内、auto_watch 门控之外，仅 failure 文件存在时读写；工具清空时删文件
- [x] 1.5 DEFAULTS/applyConfigObject/env 加 failure_nudge_threshold（默认 2，0=关闭）

## 2. server（dist/mcp/server.js）与公共层（dist/dcp-common.cjs）

- [x] 2.1 dcp-common 新增 pluginEnabledStatus 纯函数（三层定位，无 IO），导出
- [x] 2.2 doctor 第 12 检查 plugin_enabled（skipped/fail/warn/ok 语义；__dirname 反推自身插件名与 marketplace 名）
- [x] 2.3 dcp_reset OWNED/CATEGORY 加 failure-<sid>.json；doctor stale_sessions 正则加 failure
- [x] 2.4 search_context 零命中 message 与工具描述补"中文长句拆 2-3 个关键词"引导

## 3. 清单/命令/文档

- [x] 3.1 plugin.json：version 0.8.0 + userConfig failure_nudge_threshold（四键）
- [x] 3.2 package.json / 仓库副本 marketplace.json → 0.8.0
- [x] 3.3 commands/dcp-usage.md 补 trend、commands/dcp-stats.md 补 savings
- [x] 3.4 仓库副本 README：12 项检查、failure 提醒、配置表加 failure_nudge_threshold、功能表 hook 行

## 4. 测试

- [x] 4.1 旧套件跟进：7 处版本断言 0.7.0→0.8.0；smoke-v06 T4 事件 4→5 + failure 命令形态断言；smoke-v07 checks 11→12（两处）+ DBG_KEYS 加 count
- [x] 4.2 smoke-v08：A 行为矩阵（触发/冷却/interrupt/成功重置/陈旧衰减/threshold=0/config 阈值/触发后重计）、状态治理（purge owned/归类）、B 矩阵（纯函数直测三层 + doctor 集成 skipped/warn/ok/fail/all-disabled）、C/F-lite 断言
- [x] 4.3 run-all 9 套件全绿（214 断言）

## 5. 发布

- [x] 5.1 Oracle 验收通过（可发布，无 P0/P1；P3 记入 backlog）→ P2-1 勾选 + P3-2 补测完成
- [ ] 5.2 同步 repo 副本 → commit → push（HTTPS_PROXY=http://127.0.0.1:7890）→ CI 绿 → tag v0.8.0
