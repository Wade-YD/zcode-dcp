# Tasks

## 1. 实现

- [x] 1.1 `dist/mcp/server.js`：dcp_reset 工具（list：文件名/大小/mtime/类别说明/总量；purge：清空 STATE_DIR 文件 + 重置内存态；描述含不可逆护栏）。验证：冒烟 list/purge/不存在目录三态
- [x] 1.2 新命令 `commands/dcp-uninstall.md`：三步引导（列残留→确认 purge→UI 卸载与市场源清理），覆盖纯清数据场景。验证：文件存在且引用的工具名正确
- [x] 1.3 README"卸载与清理"章节（中英）+ 工具表更新（七个工具）。验证：渲染检查

## 2. 发布

- [x] 2.1 版本 0.5.3 全套同步（plugin.json/package.json/SERVER_INFO/marketplace×2/版本断言）；smoke-v053 套件并入 run-all。验证：runner 全绿
- [x] 2.2 同步 GitHub、commit、tag v0.5.3、push、CI 绿。验证：远端 tag 与版本一致

## 3. Oracle 三审修复（v0.5.4）

- [x] 3.1 P0：loadBlocks 磁盘为准——归档文件被外部清除（purge/手删）即清空内存，防同项目其他实例把已删归档整包写回复活。验证：smoke-v053 T6（删文件后检索无命中/b001 重编号/磁盘不含旧块）
- [x] 3.2 P1：dcp_reset 入口 junction/符号链接机械护栏（lstat 拒绝）；purge 白名单（仅删插件状态文件模式，未知文件 skippedUnknown 保留）+ 事后校验（remainingFiles 如实上报部分失败）。验证：T7 白名单用例
- [x] 3.3 P2/P3：confirm=true 机械闸门；SKILL/dcp.md 接入 /dcp-uninstall；README 套件数/种子迁移警示补齐；purge 消息注明计量重建属正常；描述精简。验证：T2 无 confirm 拒绝；runner 6/6
