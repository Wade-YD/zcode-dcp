# Tasks

## 1. 实现

- [x] 1.1 `dist/mcp/server.js`：dcp_reset 工具（list：文件名/大小/mtime/类别说明/总量；purge：清空 STATE_DIR 文件 + 重置内存态；描述含不可逆护栏）。验证：冒烟 list/purge/不存在目录三态
- [x] 1.2 新命令 `commands/dcp-uninstall.md`：三步引导（列残留→确认 purge→UI 卸载与市场源清理），覆盖纯清数据场景。验证：文件存在且引用的工具名正确
- [x] 1.3 README"卸载与清理"章节（中英）+ 工具表更新（七个工具）。验证：渲染检查

## 2. 发布

- [x] 2.1 版本 0.5.3 全套同步（plugin.json/package.json/SERVER_INFO/marketplace×2/版本断言）；smoke-v053 套件并入 run-all。验证：runner 全绿
- [x] 2.2 同步 GitHub、commit、tag v0.5.3、push、CI 绿。验证：远端 tag 与版本一致
