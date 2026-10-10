/* zcode-dcp v0.4.1 Oracle 审查修复冒烟测试（归属校验/校准门槛/召回标记/CJK/路径归一/入参校验） */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const SRC = path.join(__dirname, "..");
const HOOK = path.join(SRC, "hooks", "auto-watch.cjs");
const SERVER = path.join(SRC, "dist", "mcp", "server.js");
const SANDBOX = path.join(os.tmpdir(), "dcp-smoke-home-v41");
const SB_STATE = path.join(SANDBOX, ".zcode", "dcp");
const SB_ROLLOUT = path.join(SANDBOX, ".zcode", "cli", "rollout");
const pHash = (d) => {
  let s = String(d);
  try { s = path.resolve(s); } catch {}
  if (s.endsWith(path.sep) && s.length > 3) s = s.slice(0, -path.sep.length);
  if (process.platform === "win32") s = s.toLowerCase();
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ? "| " + String(extra).slice(0, 260) : ""); }
}
function reset() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SB_ROLLOUT, { recursive: true });
}
function fakeRollout(sid, inputTokens) {
  fs.writeFileSync(path.join(SB_ROLLOUT, `model-io-sess_sess_${sid}.jsonl`), JSON.stringify({ usage: { inputTokens } }) + "\n");
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
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } };

// ---------- T7 P0-1 跨会话前值不判定压缩 ----------
reset();
{
  fakeRollout("a", 120000);
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 900000, sessionId: "other" }));
  const out = runHook(["prompt"], { session_id: "a", hook_event_name: "UserPromptSubmit" });
  const noStats = !fs.existsSync(path.join(SB_STATE, "compact-stats.json"));
  check("T7 跨会话骤降不判定不注入", out === "" && noStats, out.slice(0, 120));
  check("T7 不产生校准观测", !fs.existsSync(path.join(SB_STATE, "window-calibration.json")));
  // 同会话则正常检出
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 900000, sessionId: "a" }));
  const out2 = runHook(["prompt"], { session_id: "a", hook_event_name: "UserPromptSubmit" });
  const stats = read(path.join(SB_STATE, "compact-stats.json"));
  check("T7 同会话骤降仍检出", out2.includes("压缩召回") && stats.events.length === 1);
}

// ---------- T8 P0-2 低水位压缩不采校准 + T9 P1-5 召回标记 ----------
reset();
{
  fakeRollout("a", 30000);
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 100000, sessionId: "a" }));
  const outStop = runHook(["stop"], { session_id: "a", hook_event_name: "Stop" });
  check("T8 低水位压缩记事件但不采校准", !fs.existsSync(path.join(SB_STATE, "window-calibration.json")) && outStop === "");
  const stats = read(path.join(SB_STATE, "compact-stats.json"));
  check("T8 事件已记录", stats.events.length === 1 && stats.events[0].preTokens === 100000);
  check("T9 stop 检出写召回标记", fs.existsSync(path.join(SB_STATE, "recall-pending-a.json")));
  const outPrompt = runHook(["prompt"], { session_id: "a", hook_event_name: "UserPromptSubmit" });
  check("T9 下一轮 prompt 注入召回并清除标记", outPrompt.includes("压缩召回") && !fs.existsSync(path.join(SB_STATE, "recall-pending-a.json")), outPrompt.slice(0, 120));
  // 高水位压缩照常采校准
  fakeRollout("a", 120000);
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 900000, sessionId: "a" }));
  runHook(["stop"], { session_id: "a", hook_event_name: "Stop" });
  const cal = read(path.join(SB_STATE, "window-calibration.json"));
  check("T8 高水位压缩采校准(前值+34K)", cal.observations.length === 1 && cal.observations[0].observedWindow === 934000);
}

// ---------- T10 CJK 感知 absorb ----------
reset();
{
  const cjkBig = "中".repeat(9000); // CJK 估算 ≈9000 tokens ≥ 8000；旧公式 9000/4=2250 不触发
  const out1 = runHook(["tool"], { session_id: "s", hook_event_name: "PostToolUse", tool_name: "Read", tool_response: cjkBig });
  check("T10 中文大结果触发 absorb", out1.includes("dcp absorb") && out1.includes("9,000"), out1.slice(0, 120));
}

// ---------- T11 路径归一化：大小写/尾斜杠/相对差异 → 同一命名空间 ----------
{
  const envA = { DCP_PROJECT_DIR: "E:\\projX\\sub" };
  const envB = { DCP_PROJECT_DIR: "e:/projx/sub/" };
  const rA = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "compress", arguments: { topic: "命名空间一致性", summary: "check" } } }], envA);
  const rB = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_context", arguments: { query: "命名空间一致性" } } }], envB);
  const cA = JSON.parse(rA[1].result.content[0].text);
  const sB = JSON.parse(rB[1].result.content[0].text);
  check("T11 大小写/尾斜杠归一到同文件", cA.blockId === "b001" && sB.total === 1, JSON.stringify({ cA, sB }).slice(0, 200));
  const hookOut = execFileSync("node", [HOOK, "session-start"], {
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: "E:/ProjX/Sub" }),
    env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX },
    encoding: "utf-8",
  }).trim();
  check("T11 hook 大小写变体命中同命名空间", hookOut.includes("命名空间一致性"), hookOut.slice(-200));
}

// ---------- T12 compress 入参校验 + 蒸馏精确回落 ----------
reset();
{
  fs.mkdirSync(SB_STATE, { recursive: true });
  const r1 = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "compress", arguments: { topic: "", summary: "  " } } }]);
  const c1 = JSON.parse(r1[1].result.content[0].text);
  check("T12 空 topic/summary 被拒", !!c1.error && !fs.existsSync(path.join(SB_STATE, "blocks.json")), JSON.stringify(c1));
  const seed = { blocks: [], nextBlockId: 6 };
  for (let i = 1; i <= 5; i++) {
    seed.blocks.push({ blockId: `b00${i}`, topic: `旧块${i}`, active: true, tags: [], type: "general", createdAt: new Date(Date.now() - (6 - i) * 60000).toISOString(), summary: `内容${i}\nOpen objectives: 目标${i}` });
  }
  fs.writeFileSync(path.join(SB_STATE, "blocks.json"), JSON.stringify(seed));
  const env = { DCP_MAX_BLOCKS: "5", DCP_ARCHIVE_SCOPE: "global" };
  const r2 = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "compress", arguments: { topic: "新块", summary: "n", type: "weird" } } }], env);
  const c2 = JSON.parse(r2[1].result.content[0].text);
  const store = read(path.join(SB_STATE, "blocks.json"));
  check("T12 蒸馏精确回落到上限(6→5)", store.blocks.length === 5 && !!c2.distilled && c2.distilled.mergedCount === 2, JSON.stringify(c2.distilled));
  const distilledBlock = store.blocks.find((b) => b.topic.includes("蒸馏归档"));
  check("T12 type 非法回退 general + Open objectives 保留", distilledBlock.summary.includes("Open objectives: 目标1") && distilledBlock.type === "general");
}

// ---------- T13 双实例顺序可见性（变更前重读） ----------
reset();
{
  const r1 = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "compress", arguments: { topic: "A写入", summary: "a" } } }]);
  const r2 = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_context", arguments: { query: "A写入" } } }]);
  const s2 = JSON.parse(r2[1].result.content[0].text);
  check("T13 后续实例可见先前实例写入", s2.total === 1 && JSON.parse(r1[1].result.content[0].text).blockId === "b001");
}

// ---------- T14 版本 ----------
{
  const p = JSON.parse(fs.readFileSync(path.join(SRC, ".zcode-plugin", "plugin.json"), "utf-8"));
  const sv = execFileSync("node", [SERVER], {
    input: JSON.stringify(INIT) + "\n",
    env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX },
    encoding: "utf-8",
  });
  const ver = JSON.parse(sv.trim().split("\n")[0]).result.serverInfo.version;
  check("T14 版本 0.5.0 一致", p.version === "0.5.0" && ver === "0.5.0");
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
