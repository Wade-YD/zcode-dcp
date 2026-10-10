# Tasks

## 1. 公共模块

- [ ] 1.1 新建 `dist/dcp-common.cjs`（常量/原子写/哈希与命名空间/eachPluginOption），文件头注明"hook 与 server 共用，改动须双验"。验证：node -e require 成功
- [ ] 1.2 `hooks/auto-watch.cjs` 删除本地重复实现改为 require；`dist/mcp/server.js` 同。验证：两套既有冒烟不回归

## 2. 工具面与配置面收缩

- [ ] 2.1 删除 sweep 工具、`commands/dcp-sweep.md`、skill/命令/README 引用；context_stats 增 insights（duplicateTopics/errorBlocks）。验证：tools/list 五工具；context_stats 含 insights
- [ ] 2.2 plugin.json 删除三项遗留 userConfig 与 env；归档块不再写 `active` 且读取端去过滤。验证：plugin.json 无遗留键；新块无 active 字段
- [ ] 2.3 JSON-RPC batch（数组消息分发）；archive_scope=global 时 session-start 附跨项目共享提示。验证：v05 套件

## 3. 测试与 CI 进仓库

- [ ] 3.1 三套冒烟移植 `tests/`（SRC 相对路径、sweep 断言移除、版本 0.5.0、v03 T0 存在性守卫）；新增 `tests/smoke-v05.js`；`tests/run-all.js`。验证：本地 runner 全绿
- [ ] 3.2 `.github/workflows/ci.yml`（windows/ubuntu 矩阵跑 runner）。验证：yaml 语法检查（首跑结果待 GitHub）

## 4. 发布

- [ ] 4.1 版本 0.5.0（plugin.json/package.json/serverInfo/两份 marketplace）；README（去 sweep、测试与 CI 说明、global 提示）。验证：版本一致
- [ ] 4.2 同步 GitHub、commit、tag v0.5.0 并推送。验证：远端 tag 与版本一致
