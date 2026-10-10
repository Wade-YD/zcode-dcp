/* zcode-dcp v0.5.0 冒烟测试：batch 支持 / context_stats 洞察 / sweep 移除 / global 提示 / 新块无 active */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const SRC = path.join(__dirname, "..");
const SERVER = path.join(SRC, "dist", "mcp", "server.js");
const SANDBOX = path.join(os.tmpdir(), "dcp-smoke-home-v5");
const SB_STATE = path.join(SANDBOX, ".zcode", "dcp");
const SB_ROLLOUT = path.join(SANDBOX, ".zcode", "cli", "rollout");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ? "| " + String(extra).slice(0, 260) : ""); }
}
function rpcRaw(input, env) {
  const out = execFileSync("node", [SERVER], {
    input,
    env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX, ...(env || {}) },
    encoding: "utf-8",
  });
  return out.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
}
function rpc(msgs, env) {
  return rpcRaw(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", env);
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } };

fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SB_ROLLOUT, { recursive: true });

// ---------- T1 JSON-RPC batch：数组消息逐个分发 ----------
{
  const batch = JSON.stringify([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const res = rpcRaw(batch + "\n");
  check("T1 batch 返回两个响应", res.length === 2 && res[0].id === 1 && res[1].id === 2 && Array.isArray(res[1].result.tools));
}

// ---------- T2 五个工具且无 sweep ----------
{
  const r = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  const names = r[1].result.tools.map((t) => t.name);
  check("T2 工具面收缩为五个（无 sweep）", names.length === 5 && !names.includes("sweep"), names.join(","));
}

// ---------- T3 context_stats 洞察（重复主题/错误块） ----------
{
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "blocks.json"), JSON.stringify({ blocks: [
    { blockId: "b001", topic: "同主题研究", tags: [], type: "error", createdAt: new Date().toISOString(), summary: "报错原文示范" },
    { blockId: "b002", topic: "同主题研究  ", tags: [], type: "general", createdAt: new Date().toISOString(), summary: "另一个角度" },
    { blockId: "b003", topic: "独立主题", tags: [], type: "general", createdAt: new Date().toISOString(), summary: "唯一" },
  ], nextBlockId: 4 }));
  const r = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "context_stats", arguments: {} } }]);
  const c = JSON.parse(r[1].result.content[0].text);
  check("T3 insights 统计正确", c.insights && c.insights.duplicateTopics === 1 && c.insights.errorBlocks === 1, JSON.stringify(c.insights));
  check("T3 旧块的 active 字段被忽略且全量可见", c.totalBlocks === 3);
}

// ---------- T4 新归档块不再携带 active 字段 ----------
{
  const r = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "compress", arguments: { topic: "v05 新块", summary: "无 active 字段" } } }]);
  const store = JSON.parse(fs.readFileSync(path.join(SB_STATE, "blocks.json"), "utf-8"));
  const nb = store.blocks.find((b) => b.topic === "v05 新块");
  check("T4 新块无 active 键", !!nb && !("active" in nb), JSON.stringify(nb).slice(0, 200));
}

// ---------- T5 global 归档提示 + legacy 兼容 ----------
{
  // 写全局 blocks（含 active:true 旧格式），global scope 下 session-start 应含共享提示与索引
  fs.writeFileSync(path.join(SB_STATE, "blocks.json"), JSON.stringify({ blocks: [
    { blockId: "b001", topic: "全局旧块", active: true },
  ], nextBlockId: 2 }));
  const { execFileSync: ef } = require("child_process");
  const HOOK = path.join(SRC, "hooks", "auto-watch.cjs");
  const out = ef("node", [HOOK, "session-start"], {
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: "E:/someProj" }),
    env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX, DCP_ARCHIVE_SCOPE: "global" },
    encoding: "utf-8",
  }).trim();
  check("T5 global 注入共享提示", out.includes("全局共享") && out.includes("全局旧块"), out.slice(-200));
}

// ---------- T6 遗留配置不再声明 ----------
{
  const p = JSON.parse(fs.readFileSync(path.join(SRC, ".zcode-plugin", "plugin.json"), "utf-8"));
  const envKeys = Object.keys(p.mcpServers.dcp.env || {});
  check("T6 无遗留 userConfig/env", !p.userConfig.max_context_tokens && !p.userConfig.nudge_threshold && !p.userConfig.auto_sweep && !envKeys.includes("DCP_AUTO_SWEEP"));
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
