/* zcode-dcp v0.5.3 冒烟测试：卸载清理（dcp_reset list/purge/空目录/内存重置） */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const SRC = path.join(__dirname, "..");
const SERVER = path.join(SRC, "dist", "mcp", "server.js");
const SANDBOX = path.join(os.tmpdir(), "dcp-smoke-home-v53");
const SB_STATE = path.join(SANDBOX, ".zcode", "dcp");
const SB_ROLLOUT = path.join(SANDBOX, ".zcode", "cli", "rollout");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ? "| " + String(extra).slice(0, 260) : ""); }
}
function rpc(msgs, env) {
  const out = execFileSync("node", [SERVER], {
    input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n",
    env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX, ...(env || {}) },
    encoding: "utf-8",
  });
  return out.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } };
const call = (id, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "dcp_reset", arguments: args } });

fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SB_ROLLOUT, { recursive: true });

// ---------- T1 list：残留列举与类别标注 ----------
{
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "blocks.json"), JSON.stringify({ blocks: [{ blockId: "b001", topic: "归档甲" }], nextBlockId: 2 }));
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 1 }));
  fs.writeFileSync(path.join(SB_STATE, "nudge-s1.json"), "{}");
  const r = rpc([INIT, call(2, { mode: "list" })]);
  const c = JSON.parse(r[1].result.content[0].text);
  const names = c.files.map((f) => f.file);
  check("T1 list 返回三文件与总量", c.totalFiles === 3 && c.totalBytes > 0 && names.includes("blocks.json") && names.includes("usage.json"));
  check("T1 类别标注含归档警示", c.files.find((f) => f.file === "blocks.json").category.includes("永久丢失") && c.files.find((f) => f.file === "nudge-s1.json").category.includes("提醒"));
}

// ---------- T2 purge：清除 + 后续检索为空 ----------
{
  const r = rpc([INIT, call(2, { mode: "purge", confirm: true }), { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_context", arguments: { query: "归档甲" } } }, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "context_stats", arguments: {} } }]);
  const p = JSON.parse(r[1].result.content[0].text);
  const s = JSON.parse(r[2].result.content[0].text);
  const st = JSON.parse(r[3].result.content[0].text);
  check("T2 purge 删除全部文件", p.removedCount === 3 && fs.readdirSync(SB_STATE).length === 0, JSON.stringify(p).slice(0, 200));
  check("T2 purge 后检索无命中", s.total === 0);
  check("T2 purge 后统计归零", st.totalBlocks === 0);
  check("T2 返回含卸载引导", typeof p.message === "string" && p.message.includes("设置"));
  // confirm 闸门
  const rg = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dcp_reset", arguments: { mode: "purge" } } }]);
  const g = JSON.parse(rg[1].result.content[0].text);
  check("T2 无 confirm 拒绝 purge", !!g.error && String(g.error).includes("confirm"));
}

// ---------- T3 空目录 purge 安全 + 非法 mode ----------
{
  const r = rpc([INIT, call(2, { mode: "purge", confirm: true }), call(3, { mode: "bogus" })]);
  const p = JSON.parse(r[1].result.content[0].text);
  const bad = JSON.parse(r[2].result.content[0].text);
  check("T3 空目录 purge 无害", p.removedCount === 0 && p.message.includes("无需清理"));
  check("T3 非法 mode 报错", !!bad.error);
}

// ---------- T4 工具面七工具 + 命令文件存在 ----------
{
  const r = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  const names = r[1].result.tools.map((t) => t.name);
  check("T4 六个工具含 dcp_reset", names.length === 6 && names.includes("dcp_reset"), names.join(","));
  const desc = r[1].result.tools.find((t) => t.name === "dcp_reset").description;
  check("T4 描述含不可逆护栏与 confirm", desc.includes("不可逆") && desc.includes("confirm"));
  check("T4 /dcp-uninstall 命令存在", fs.existsSync(path.join(SRC, "commands", "dcp-uninstall.md")));
}

// ---------- T5 版本 ----------
{
  const m = JSON.parse(fs.readFileSync(path.join(SRC, ".zcode-plugin", "plugin.json"), "utf-8"));
  check("T5 版本 0.5.4", m.version === "0.5.4");
}

// ---------- T6 purge × project scope + 磁盘为准不复活 ----------
{
  const crypto = require("crypto");
  const pHash = (d) => {
    let s = String(d);
    try { s = path.resolve(s); } catch {}
    if (s.endsWith(path.sep) && s.length > 3) s = s.slice(0, -path.sep.length);
    if (process.platform === "win32") s = s.toLowerCase();
    return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
  };
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(SB_STATE + "/blocks.json", JSON.stringify({ blocks: [{ blockId: "b001", topic: "全局旧块" }], nextBlockId: 2 }));
  const envP = { DCP_PROJECT_DIR: "E:/projP" };
  const hashFile = SB_STATE + "/blocks-" + pHash("E:/projP") + ".json";
  fs.writeFileSync(hashFile, JSON.stringify({ blocks: [{ blockId: "b001", topic: "项目旧块" }], nextBlockId: 2 }));
  const rp = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dcp_reset", arguments: { mode: "purge", confirm: true } } }], envP);
  const pp = JSON.parse(rp[1].result.content[0].text);
  check("T6 project scope purge 全局+哈希文件皆删", !fs.existsSync(SB_STATE + "/blocks.json") && !fs.existsSync(hashFile) && pp.removedCount === 2, JSON.stringify(pp).slice(0, 200));
  // 磁盘为准（P0 回归）：归档文件被外部删除后，后续 server 实例不残留、不复活、重新编号
  fs.writeFileSync(hashFile, JSON.stringify({ blocks: [{ blockId: "b001", topic: "待清除块" }], nextBlockId: 2 }));
  const rHit = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_context", arguments: { query: "待清除块" } } }], envP);
  check("T6 清除前新实例可检索到", JSON.parse(rHit[1].result.content[0].text).total === 1);
  fs.rmSync(hashFile, { force: true });
  const rMiss = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_context", arguments: { query: "待清除块" } } }, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "compress", arguments: { topic: "复活检验", summary: "x" } } }], envP);
  const miss = JSON.parse(rMiss[1].result.content[0].text);
  const comp = JSON.parse(rMiss[2].result.content[0].text);
  const onDisk = JSON.parse(fs.readFileSync(hashFile, "utf-8"));
  check("T6 文件被删后检索无命中", miss.total === 0);
  check("T6 新块从 b001 重新编号", comp.blockId === "b001");
  check("T6 写回磁盘不含已删旧块", !onDisk.blocks.some((b) => b.topic === "待清除块") && onDisk.blocks.some((b) => b.topic === "复活检验"));
}

// ---------- T7 白名单：未识别文件不被 purge ----------
{
  fs.rmSync(SB_STATE, { recursive: true, force: true }); // 清掉 T6 残留，隔离本用例
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(SB_STATE + "/blocks.json", JSON.stringify({ blocks: [{ blockId: "b001", topic: "甲" }], nextBlockId: 2 }));
  fs.writeFileSync(SB_STATE + "/我的笔记.txt", "用户手放文件");
  const rl = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dcp_reset", arguments: { mode: "list" } } }]);
  const cl = JSON.parse(rl[1].result.content[0].text);
  check("T7 list 标注未识别文件", cl.files.find((f) => f.file === "我的笔记.txt").category.includes("不会删除") && cl.ownedFiles === 1);
  const rp2 = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dcp_reset", arguments: { mode: "purge", confirm: true } } }]);
  const cp2 = JSON.parse(rp2[1].result.content[0].text);
  check("T7 purge 保留未识别文件", fs.existsSync(SB_STATE + "/我的笔记.txt") && cp2.skippedUnknown.length === 1 && !fs.existsSync(SB_STATE + "/blocks.json"), JSON.stringify(cp2).slice(0, 200));
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
