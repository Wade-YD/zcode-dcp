# Proposal

## Why

Oracle 对 v0.4.1 的审查遗留了一组 0.5.0 候选清理项（P2/P3），叠加开源项目的工程卫生缺口：冒烟测试只存在于本机 %TEMP%、无 CI、无版本 tag；hook 与 server 的配置加载/命名空间解析是双份手写实现且已漂移过一次；sweep 工具名不副实（描述"扫描对话历史"实际返回静态建议）；v0.1 遗留死配置仍在设置 UI 里误导用户。

## What Changes

- 抽公共模块 `dist/dcp-common.cjs`：readJson/原子 writeJson、sanitizeSid、normalizeProjectDir/projectHash、blocksFileFor（含种子迁移）、eachPluginOption（config.json 的 zcode-dcp 过滤遍历）——hook 与 server 共用，消除双份实现
- 砍掉 sweep 工具与 `/dcp-sweep` 命令：其"去重"实用部分已由 compress 的 possibleDuplicates 覆盖；context_stats 新增 insights（duplicateTopics/errorBlocks 计数）作为替代的数据面
- 删除 v0.1 遗留死配置：max_context_tokens / nudge_threshold / auto_sweep 三项 userConfig 与对应 env 透传（读取点已不存在）
- 删除归档块死字段 `active`（无任何代码路径置 false）及其全部过滤
- JSON-RPC batch 请求支持（数组消息分发）
- archive_scope=global 时 session-start 注入跨项目共享提示（敏感信息明示）
- 测试进仓库：三套冒烟移植到 `tests/`（适配 0.5 语义）+ 新增 v0.5 套件 + `tests/run-all.js` + GitHub Actions CI（windows/ubuntu 矩阵）
- 版本 0.5.0，git tag

## Capabilities

（skip_specs: true——本变更无规格级行为变更：sweep 从未立规、其余为实现细节/工程面；已有四能力规格不受影响）

## Impact

- 代码：新增 `dist/dcp-common.cjs`；`hooks/auto-watch.cjs` 与 `dist/mcp/server.js` 改为 require 公共模块并删除各自重复实现；`plugin.json`（0.5.0、配置清理）；`commands/dcp-sweep.md` 删除；`skills/dcp/SKILL.md` 去除 sweep；README；两份 marketplace
- 兼容性：旧状态文件（含 active 字段、含已删除配置项的 config.json）全部兼容忽略；sweep 调用方将收到 Unknown tool（该工具无既有规格与命令面留存于 0.5 后）
- 工程面：`tests/` 与 `.github/workflows/ci.yml` 新增；tag v0.5.0
