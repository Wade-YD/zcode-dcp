# Tasks

## 1. 压缩检测与窗口校准（compact-detection）

- [x] 1.1 `hooks/auto-watch.cjs`：骤降判定（<60% 且前值>20K）→ compact-stats.json（最近 20 条）；窗口校准（前值+34000，最近 5 观测取中位，未显式配置时生效）；context_usage/usage payload 增 windowSource。验证：模拟前值 900K→120K 触发，校准文件与 windowSource 正确
- [x] 1.2 检出压缩时重置该会话提醒状态；prompt 模式即时注入召回（节省量+占用+归档索引）。验证：模拟检出后 additionalContext 含索引

## 2. 会话隔离（session-isolation）

- [x] 2.1 nudge 状态按 sid 分文件；计量严格匹配（有 sid 且日志缺失→跳过；无 sid 才兜底）。验证：双会话模拟互不影响；陌生 sid 不读他人日志
- [x] 2.2 usage payload 标注"最近活跃会话"来源。验证：payload 含 sessionId 字段说明

## 3. 归档命名空间与生命周期（archive-lifecycle）

- [x] 3.1 `dist/mcp/server.js`：archive_scope=project 默认，blocks-<sha1(proj)12>.json；旧全局 blocks.json 种子迁移。验证：不同 DCP_PROJECT_DIR 写入不同文件；种子迁移只发生一次
- [x] 3.2 `hooks/auto-watch.cjs`：session-start 召回的归档索引按同一规则解析命名空间（cwd）。验证：hook 与 server 同项目命中同一文件
- [x] 3.3 max_blocks（默认 200）超限蒸馏最旧 20%（分节截断 800 字符 + Open objectives 行逐字保留）；topic 归一化重复返回 possibleDuplicates。验证：max=5 第 6 块触发蒸馏；重复 topic 提示
- [x] 3.4 PostToolUse hook（tool 模式）：tool_response 估算 ≥ absorb_min_tool_tokens（默认 8000）且会话级冷却 10min → 注入蒸馏提示；hooks.json 注册 PostToolUse；plugin.json 加配置并传递 env。验证：大结果注入、冷却内不注入、小结果不注入

## 4. 交付

- [x] 4.1 版本 0.4.0；README（新配置、absorb-lite 致谢 acp-kernel absorb.ts、压缩检测说明）；两份 marketplace 同步。验证：版本一致
- [x] 4.2 冒烟全绿（v03 回归 + v04 新用例）后同步 GitHub 仓库并 push。验证：远端版本 0.4.0
