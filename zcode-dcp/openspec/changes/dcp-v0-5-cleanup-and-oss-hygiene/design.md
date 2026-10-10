# Design

## Context

v0.4.1 架构与 Oracle 审查结论见已归档/活跃变更与记忆。现状痛点：hook（hooks/auto-watch.cjs）与 server（dist/mcp/server.js）各自实现 config.json 的 zcode-dcp 过滤遍历、项目哈希、命名空间解析——server 侧曾漏掉 key 过滤（已修，但双份实现的漂移风险仍在）；writeJson 原子写在两文件各写一份。

## Goals / Non-Goals

**Goals:** 单一实现来源；工具面与配置面收缩到真实使用集；测试与 CI 进仓库；版本化发布。

**Non-Goals:** 重写 JSON-RPC 层为 SDK（零依赖原则不变）；macOS/Linux 包装（继续等 PR）；debug 日志与 /dcp-doctor（backlog）；压缩策略变更。

## Decisions

### D1 公共模块放在 dist/dcp-common.cjs
hook 以 `require("../dist/dcp-common.cjs")`（相对 `__dirname`）、server 以 `require("../dcp-common.cjs")` 引用。插件整目录安装，两文件同树，require 相对路径不改变部署形态；唯一损失是单文件被单独拷走时不可运行——接受（README 已说明整目录安装）。模块面：HOME/STATE_DIR/ROLLOUT_DIR/USAGE_FILE/BLOCKS_LEGACY_FILE/KERNEL_COMPACT_RESERVE 常量，readJson/原子 writeJson，sanitizeSid/normalizeProjectDir/projectHash/blocksFileFor（含一次性种子迁移），eachPluginOption(cb)。各文件的 DEFAULTS/字段级类型收敛逻辑（如 _windowExplicit）留在本地——它们本来就是各自的语义。

### D2 sweep 砍除而非实现真扫描
理由：模型每轮工具往返换静态文案是负价值；其去重建议已被 compress 的 possibleDuplicates 覆盖；"扫描对话"在插件面没有 transcript 访问能力（hook 的 transcript_path 只含当前消息），真扫描做不了。替代：context_stats 增 insights（重复主题计数 + error 块计数）——数据都在归档里。`/dcp-sweep` 命令与 skill 引用同步删除。

### D3 死代码清除策略
`active` 字段：写入端不再生成、读取端全部去掉过滤（旧文件里的 active:true 被无害忽略）。v0.1 遗留配置：userConfig 三项 + env 三项删除，读取端本就忽略旧 config.json 里残留的键。

### D4 测试进仓库的形态
三套冒烟从 %TEMP% 原样移植（保留各自沙箱 HOME 命名），仅做三类适配：SRC 改相对路径、sweep 相关断言移除、版本断言 0.5.0；v03 的真实数据用例（T0）加存在性守卫（无数据机器上 SKIP 而非崩溃）。新增 tests/smoke-v05.js（batch/insights/无 sweep/global 提示/公共模块双侧可载）。runner 顺序执行、任一失败整体非零退出。CI 矩阵 windows+ubuntu（测试直接调 node，不经过 run-hook.cmd，跨平台可跑）。

## Risks / Trade-offs

- [删除 sweep 是工具面收缩，已发布用户可能调用] → 无规格约束、无 README 之外的使用证据；context_stats.insights 提供替代数据面；README 变更说明
- [公共模块引入文件间耦合] → 同目录相对 require，git 单仓演进；文件头注明双端共用、改动须双验
- [CI 首跑环境差异（无真实 rollout 数据）] → T0 已守卫跳过；其余用例全部沙箱化

## Migration Plan

0.5.0 直接替换安装；无状态迁移（active/旧配置键均被忽略）。回滚：UI 退回 0.4.1。

## Open Questions

（无）
