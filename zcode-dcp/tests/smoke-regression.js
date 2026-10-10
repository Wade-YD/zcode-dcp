/* zcode-dcp 冒烟回归套件（计量/分级提醒/静默失效/session-start/归档持久化）
 * 用法: node tests/smoke-regression.js（或 tests/run-all.js 全量）
 * 隔离: 状态写入 %TEMP%\dcp-smoke-home（沙箱 HOME），真实 HOME 不受影响。
 * 真实数据用例（T0）只读本机真实计量数据，无数据时跳过。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const SRC = path.join(__dirname, "..");
const HOOK = path.join(SRC, "hooks", "auto-watch.cjs");
const SERVER = path.join(SRC, "dist", "mcp", "server.js");
const SANDBOX = path.join(os.tmpdir(), "dcp-smoke-home");
const SB_STATE = path.join(SANDBOX, ".zcode", "dcp");
const SB_ROLLOUT = path.join(SANDBOX, ".zcode", "cli", "rollout");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ? "| " + String(extra).slice(0, 300) : ""); }
}
function sandbox() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SB_ROLLOUT, { recursive: true });
}
function fakeRollout(inputTokens) {
  fs.writeFileSync(
    path.join(SB_ROLLOUT, "model-io-sess_sess_test.jsonl"),
    JSON.stringify({ usage: { inputTokens: inputTokens, totalTokens: inputTokens + 500 } }) + "\n"
  );
}
function runHook(args, input, env) {
  return execFileSync("node", [HOOK, args], {
    input: JSON.stringify(input),
    env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX, ...(env || {}) },
    encoding: "utf-8",
  }).trim();
}
function rpc(msgs, env) {
  const out = execFileSync("node", [SERVER], {
    input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n",
    env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX, ...(env || {}) },
    encoding: "utf-8",
  });
  return out.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
}
const read = (f) => JSON.parse(fs.readFileSync(f, "utf-8"));

// ---------- T0 真实数据: hook 计量（因机器而异，无数据跳过） ----------
{
  runHook(["stop"], { session_id: "1f429489-c013-4782-b3c3-bf007e98df9a", hook_event_name: "Stop" });
  const realUsagePath = path.join(os.homedir(), ".zcode", "dcp", "usage.json");
  if (fs.existsSync(realUsagePath)) {
    const u = read(realUsagePath);
    check("T0 真实数据计量更新", u.usedTokens > 0 && u.contextWindowTokens === 1000000, JSON.stringify(u).slice(0, 200));
  } else {
    console.log("SKIP T0（本机无真实计量数据）");
  }
}

// ---------- T1 plugin.json ----------
{
  const p = JSON.parse(fs.readFileSync(path.join(SRC, ".zcode-plugin", "plugin.json"), "utf-8"));
  const cfg = p.userConfig;
  check("T1 版本 0.5.0", p.version === "0.5.0");
  check("T1 窗口默认 1M", cfg.context_window_tokens.default === 1000000);
  check("T1 分级配置齐全", cfg.tier2_percent.default === 70 && cfg.tier3_percent.default === 80 && cfg.nudge_growth_tokens.default === 30000);
  check("T1 v0.1 遗留配置已删", !cfg.max_context_tokens && !cfg.nudge_threshold && !cfg.auto_sweep);
}

// ---------- T2 tier 触发/冷却/升级/回落（55/71/82 万 tokens 对应 55%/71%/82%） ----------
sandbox();
{
  fakeRollout(550000);
  const out1 = runHook(["prompt"], { session_id: "test", hook_event_name: "UserPromptSubmit" });
  check("T2 首次 55% 触发 tier1", out1.includes("tier1") && out1.includes("压缩优先级") && out1.includes("逐字保留") && out1.includes("Open objectives"));
  const out2 = runHook(["prompt"], { session_id: "test", hook_event_name: "UserPromptSubmit" });
  check("T2 同级立即重复被冷却", out2 === "", out2.slice(0, 120));
  fakeRollout(550100);
  const out3b = runHook(["prompt"], { session_id: "test", hook_event_name: "UserPromptSubmit" }, { DCP_NUDGE_GROWTH_TOKENS: "1", DCP_NUDGE_COOLDOWN_MINUTES: "0" });
  check("T2 双条件放开后同级再注入", out3b.includes("tier1"), out3b.slice(0, 120));
  fakeRollout(710000);
  const out4 = runHook(["prompt"], { session_id: "test", hook_event_name: "UserPromptSubmit" });
  check("T2 升级 tier2 跳过冷却", out4.includes("tier2") && out4.includes("停止产出冗长内容"));
  fakeRollout(820000);
  const out5 = runHook(["prompt"], { session_id: "test", hook_event_name: "UserPromptSubmit" });
  check("T2 升级 tier3 含 /compact 与交接摘要", out5.includes("tier3") && out5.includes("/compact") && out5.includes("交接摘要"));
  fakeRollout(550000);
  const out6 = runHook(["prompt"], { session_id: "test", hook_event_name: "UserPromptSubmit" });
  const st = read(path.join(SB_STATE, "nudge-test.json"));
  check("T2 水位回落只更新状态不注入", out6 === "" && st.lastTier === 1, JSON.stringify(st));
}

// ---------- T3 静默失效 ----------
sandbox();
{
  let threw = false, out = "";
  try { out = runHook(["prompt"], { session_id: "nope", hook_event_name: "UserPromptSubmit" }); } catch (e) { threw = true; }
  check("T3 无日志文件静默退出", !threw && out === "");
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "nudge-test.json"), "{broken json");
  fakeRollout(550000);
  let threw2 = false, out2 = "";
  try { out2 = runHook(["prompt"], { session_id: "test", hook_event_name: "UserPromptSubmit" }); } catch (e) { threw2 = true; }
  check("T3 坏提醒状态按首次触发处理", !threw2 && out2.includes("tier1"));
  let threw3 = false, out3 = "";
  try { out3 = execFileSync("node", [HOOK, "prompt"], { input: "not-json{{{", env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX }, encoding: "utf-8" }).trim(); } catch (e) { threw3 = true; }
  check("T3 非法 stdin 静默退出", !threw3 && out3 === "");
}

// ---------- T4 session-start 注入 ----------
{
  const out = runHook(["session-start"], { hook_event_name: "SessionStart" });
  check("T4 含工具说明与检索说明", out.includes("search_context") && out.includes("decompress") && out.includes("Open objectives"));
  check("T4 无归档时退化说明", out.includes("暂无归档块"));
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "blocks.json"), JSON.stringify({ blocks: [
    { blockId: "b001", topic: "压缩优先级研究", active: true },
    { blockId: "b002", topic: "kernel facts", active: true },
  ], nextBlockId: 3 }));
  const out2 = runHook(["session-start"], { hook_event_name: "SessionStart" });
  check("T4 含归档索引", out2.includes("b001: 压缩优先级研究") && out2.includes("b002: kernel facts") && out2.includes("归档索引"));
}

// ---------- T5 MCP server ----------
sandbox();
{
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } };
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const r1 = rpc([init, list]);
  const names = r1[1].result.tools.map((t) => t.name);
  check("T5 五个工具含 search_context（sweep 已移除）", ["compress","decompress","search_context","context_stats","context_usage"].every((n) => names.includes(n)) && !names.includes("sweep"), names.join(","));
  const comp = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "compress", arguments: { topic: "压缩优先级研究", summary: "acp-kernel 的 KEEP VERBATIM 规则要求保留 lib/hooks.ts:347 这类完整路径", tags: ["research"], type: "general" } } };
  const r2 = rpc([init, comp]);
  const c1 = JSON.parse(r2[1].result.content[0].text);
  check("T5 compress 返回块 ID 且落盘", c1.blockId === "b001" && fs.existsSync(path.join(SB_STATE, "blocks.json")));
  const desc = r1[1].result.tools.find((t) => t.name === "compress").description;
  check("T5 compress 描述含承重要素", desc.includes("KEEP VERBATIM") && desc.includes("Open objectives") && desc.includes("TASK AS OF THIS BLOCK") && desc.includes("lib/hooks.ts:347"));
  const usage = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "context_usage", arguments: {} } };
  const r3 = rpc([init, usage]);
  const u1 = JSON.parse(r3[1].result.content[0].text);
  check("T5 context_usage 含基准说明", typeof u1.available === "boolean" && (!u1.available || typeof u1.baselineNote === "string"));
  const search = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search_context", arguments: { query: "压缩优先级" } } };
  const miss = { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search_context", arguments: { query: "xyzzy-nothing" } } };
  const r4 = rpc([init, search, miss]);
  const s1 = JSON.parse(r4[1].result.content[0].text);
  const s2 = JSON.parse(r4[2].result.content[0].text);
  check("T5 中文检索命中", s1.total >= 1 && s1.results[0].blockId === "b001" && s1.results[0].snippet.includes("lib/hooks.ts:347"));
  check("T5 无命中返回空与说明", s2.total === 0 && Array.isArray(s2.results) && s2.message.includes("无命中"));
  // 重启（新进程）后持久化仍在
  const dc = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "decompress", arguments: { blockId: "b001" } } };
  const se2 = { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "search_context", arguments: { query: "kernel research" } } };
  const r5 = rpc([init, dc, se2]);
  const d1 = JSON.parse(r5[1].result.content[0].text);
  const s3 = JSON.parse(r5[2].result.content[0].text);
  check("T5 重启后 decompress 取回", d1.blockId === "b001" && d1.summary.includes("lib/hooks.ts:347"));
  check("T5 重启后英文 tags 检索命中", s3.total >= 1 && s3.results[0].blockId === "b001");
  const bad = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "decompress", arguments: { blockId: "b999" } } };
  const r6 = rpc([init, bad]);
  const b1 = JSON.parse(r6[1].result.content[0].text);
  check("T5 不存在块返回错误+可用列表", !!b1.error && Array.isArray(b1.availableBlocks) && b1.availableBlocks.length === 1);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
