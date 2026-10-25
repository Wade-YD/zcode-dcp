# Proposal

## Why

用户反馈"不好卸载"：ZCode UI 卸载只移除插件本体，`~/.zcode/dcp/` 下的归档块（blocks*.json）、计量（usage.json）、校准（window-calibration.json）、提醒/absorb/召回状态（nudge-*/absorb-*/recall-pending-*）全部残留磁盘且无任何文档说明；更糟的是重装后旧全局 blocks.json 会被种子迁移"复活"进新项目命名空间，用户以为已清空的数据悄然而回。清理只能靠用户盲猜目录手删。

## What Changes

- 新 MCP 工具 `dcp_reset(mode)`：`list` 返回状态目录全部文件（名称/大小/时间/总量）与内容说明；`purge` 经用户确认后删除 `~/.zcode/dcp/` 全部状态文件并重置 server 内存态——工具描述内嵌"不可逆、仅在用户明确要求清理或卸载时调用"的护栏
- 新命令 `/dcp-uninstall`：引导三步——① dcp_reset(list) 展示残留并明确"归档将永久丢失"；② 用户确认后 dcp_reset(purge)；③ 指导 UI 卸载（设置→插件→卸载）与可选的市场源移除；同时覆盖"只想清空数据保留插件"的场景
- README 新增"卸载与清理"章节（中英）：UI 卸载步骤、残留文件清单、手动清理命令（Windows/Linux）、归档数据随清理丢失的警示、重装种子迁移行为说明

## Capabilities

### New Capabilities

- `uninstall-cleanup`: 卸载/清理支撑——状态残留可列举、可确认后清除，卸载路径有文档

## Impact

- 代码：`dist/mcp/server.js`（dcp_reset 工具，五工具变六个）、新 `commands/dcp-uninstall.md`、README；版本 0.5.3
- 安全边界：purge 仅作用于 `~/.zcode/dcp/` 单目录，代码上不触碰其他任何路径；工具描述含不可逆警示
- 无破坏性：不卸载/不 purge 的用户零感知
