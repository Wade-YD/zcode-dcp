# Tasks

## 1. 公共层（dist/dcp-common.cjs）

- [x] 1.1 DEBUG_LOG_FILE 常量 + appendDebugLog(record)：try/catch 全包绝不 throw；>512KB 先 rename 为 .1（失败静默继续）；JSON lines 追加；导出
- [x] 1.2 导出新增常量/函数，保持既有导出不变（另抽 blocksPathFor 纯路径解析供只读方使用——Oracle 验收 P1-1）

## 2. hook（hooks/auto-watch.cjs）

- [x] 2.1 loadConfig 增加 debug_log（config 通道 OR 语义，env DCP_DEBUG=1/true 在其后覆盖为 true）
- [x] 2.2 关键决策点埋点（入口/计量结果/前值/窗口与来源/tier 决策与原因/compact 检出/absorb 决策/顶层错误），仅元数据，cfg.debug_log 为 true 才写
- [x] 2.3 writeUsage 内嵌 history 环（上限 60；同会话同用量去重；会话/模型标识变更重置环；绝不 throw）
- [x] 2.4 detectCompact 增量累计 totals（totalEvents/totalSaved/since/perModel/perDay；从零起算不回填；perDay 用 event.at UTC 日期；只增量不从 events 重算；子结构损坏补齐）
- [x] 2.5 buildCompactRecapText 历史累计 >1 时追加累计行

## 3. server（dist/mcp/server.js）

- [x] 3.1 dcp_doctor 工具：十一类检查（state_dir/config_channel/thresholds/default_window/metering/blocks/compact_stats/calibration/stale_sessions/debug_log/hooks_shape），per-check 独立 try/catch，skipped 语义，verdict 聚合，纯只读（Oracle 验收 P1-1：blocksPathFor + loadBlocks(false) 启动零写盘；loadBlocks 下沉到四个归档 handler）
- [x] 3.2 context_stats 增 savings（since/totalEvents/totalSaved/perModel/近 7 天 perDay 从 totals.perDay 取；条目损坏降级 0）
- [x] 3.3 usagePayload 增 trend（最近 ≤20 点、最近最多 10 点平均增速、增速>0 时 turnsToTier3；旧文件无 history 容忍）
- [x] 3.4 dcp_reset OWNED 正则纳入 /^dcp-debug\.log(\.1)?$/（CATEGORY 分支置于 fallback 之前）
- [x] 3.5 SERVER_INFO 版本 0.7.0

## 4. 清单与命令

- [x] 4.1 plugin.json：version 0.7.0 + userConfig debug_log（四键合规：type/title/description/default）
- [x] 4.2 package.json：version 0.7.0
- [x] 4.3 commands/dcp-doctor.md 新增（引导调用工具、checks 表格化展示、按 verdict 给建议）
- [x] 4.4 skills/dcp.md 增补 dcp_doctor 小节

## 5. 测试

- [x] 5.1 tests/smoke-v07.js：T1 doctor（空沙箱 skipped 不恶化 verdict/好状态全 ok/破坏 tier→fail/config 损坏→warn/hooks_shape）；T2 账本（25 假事件+totalEvents=1 证明不重算/UTC 分桶/累计行/list owned/perDayRecent 近 7 天）；T3 日志（默认零写盘/env 开启+字段白名单/隐私红线/轮转 .1/config 通道/list owned+purge 删除）
- [x] 5.2 smoke-v07 T4 趋势（双事件去重/会话切换重置/等差增速+turnsToTier3 公式/旧文件容忍/60 点上限裁剪/换模型重置）+ T5 版本四处一致
- [x] 5.3 run-all.js 挂载 smoke-v07，8/8 套件全绿（161→170 断言）

## 6. 文档与发布

- [ ] 6.1 仓库副本 README.md：功能表加 dcp_doctor 与节省账本/趋势、配置表加 debug_log、卸载残留表加 dcp-debug.log(.1)、开发节套件数 7→8、参考 bili 致谢补可观测性对位一句
- [ ] 6.2 仓库副本 marketplace.json 版本号
- [ ] 6.3 发布后随下一变更 archive（与 dcp-v0-4/v0-5/v0-6 未 archive 惯例一致）
- [ ] 6.4 同步 repo 副本 → commit → push（HTTPS_PROXY=http://127.0.0.1:7890）→ CI 绿 → tag v0.7.0
