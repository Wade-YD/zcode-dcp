/* zcode-dcp v0.5.2 冒烟测试：Oracle 二审修复
 * 覆盖: config.json 通道与校准解锁（P0 回归）/ calibrated 窗口下 tier 判定 /
 *       session-start 消费召回标记 / auto_watch 门控 absorb / 归档索引最新在前
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const SRC = path.join(__dirname, "..");
const HOOK = path.join(SRC, "hooks", "auto-watch.cjs");
const SANDBOX = path.join(os.tmpdir(), "dcp-smoke-home-v52");
const SB_STATE = path.join(SANDBOX, ".zcode", "dcp");
const SB_ROLLOUT = path.join(SANDBOX, ".zcode", "cli", "rollout");

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
const read = (f) => JSON.parse(fs.readFileSync(f, "utf-8"));
const writeCfg = (obj) => {
  fs.mkdirSync(path.join(SANDBOX, ".zcode", "cli"), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX, ".zcode", "cli", "config.json"), JSON.stringify({ plugins: { options: obj } }));
};

// ---------- T1 P0 回归：物化默认值不再锁死校准；显式非默认值仍优先 ----------
reset();
{
  // 模拟 ZCode 物化 userConfig 默认值进 config.json
  writeCfg({ "zcode-dcp@dev-workspace-0ea5f972": { context_window_tokens: 1000000 } });
  // 两条校准观测 → 中位 934000
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "window-calibration.json"), JSON.stringify({ observations: [
    { observedWindow: 934000, at: "2026-10-10T00:00:00Z" },
    { observedWindow: 934000, at: "2026-10-10T00:01:00Z" },
  ] }));
  fakeRollout("a", 100000);
  runHook(["stop"], { session_id: "a", hook_event_name: "Stop" });
  const u = read(path.join(SB_STATE, "usage.json"));
  check("T1 默认值配置不锁死校准（windowSource=calibrated）", u.windowSource === "calibrated" && u.contextWindowTokens === 934000, JSON.stringify(u).slice(0, 160));
  // 显式非默认值优先
  writeCfg({ "zcode-dcp@dev-workspace-0ea5f972": { context_window_tokens: 500000 } });
  fakeRollout("a", 100000);
  runHook(["stop"], { session_id: "a", hook_event_name: "Stop" });
  const u2 = read(path.join(SB_STATE, "usage.json"));
  check("T1 显式非默认配置优先（windowSource=config）", u2.windowSource === "config" && u2.contextWindowTokens === 500000, JSON.stringify(u2).slice(0, 160));
}

// ---------- T2 calibrated 窗口下的 tier 判定（934K 窗口，760K=81.4% → tier3） ----------
reset();
{
  writeCfg({ "zcode-dcp@dev-workspace-0ea5f972": { context_window_tokens: 1000000 } });
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "window-calibration.json"), JSON.stringify({ observations: [
    { observedWindow: 934000, at: "2026-10-10T00:00:00Z" },
    { observedWindow: 934000, at: "2026-10-10T00:01:00Z" },
  ] }));
  fakeRollout("b", 760000);
  const out = runHook(["prompt"], { session_id: "b", hook_event_name: "UserPromptSubmit" });
  check("T2 校准窗口下 tier3 判定", out.includes("tier3") && out.includes("/compact"), out.slice(0, 140));
}

// ---------- T3 session-start 消费召回标记 ----------
reset();
{
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "recall-pending-c.json"), JSON.stringify({ event: { at: new Date().toISOString(), preTokens: 900000, postTokens: 120000, saved: 780000, sessionId: "c" } }));
  const out = runHook(["session-start"], { hook_event_name: "SessionStart", session_id: "c" });
  check("T3 session-start 注入召回并清除标记", out.includes("压缩召回") && !fs.existsSync(path.join(SB_STATE, "recall-pending-c.json")), out.slice(0, 120));
}

// ---------- T4 auto_watch=false 门控 absorb ----------
reset();
{
  const big = "x".repeat(40000);
  const out = runHook(["tool"], { session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: big }, { DCP_AUTO_WATCH: "false" });
  check("T4 auto_watch 关闭时 absorb 不注入", out === "");
  const out2 = runHook(["tool"], { session_id: "s2", hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: big });
  check("T4 auto_watch 开启时 absorb 正常", out2.includes("dcp absorb"));
}

// ---------- T5 归档索引最新在前 ----------
reset();
{
  fs.mkdirSync(SB_STATE, { recursive: true });
  const blocks = [];
  for (let i = 1; i <= 25; i++) blocks.push({ blockId: "b" + String(i).padStart(3, "0"), topic: `块${i}` });
  fs.writeFileSync(path.join(SB_STATE, "blocks.json"), JSON.stringify({ blocks, nextBlockId: 26 }));
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 120000, contextWindowTokens: 934000, updatedAt: new Date().toISOString() }));
  const out = runHook(["session-start"], { hook_event_name: "SessionStart" });
  const idx = out.slice(out.indexOf("[dcp 归档索引]"));
  check("T5 索引含最新块且最新在首行", idx.includes("b025: 块25") && idx.indexOf("b025") < idx.indexOf("b021") && !idx.includes("b001:"), idx.slice(0, 200));
  check("T5 状态行含滞后注记", out.includes("滞后一轮"));
}

// ---------- T6 版本与清单键 ----------
{
  const m = JSON.parse(fs.readFileSync(path.join(SRC, ".zcode-plugin", "plugin.json"), "utf-8"));
  const allowed = { type: 1, title: 1, description: 1, default: 1 };
  let badKeys = [];
  for (const [k, v] of Object.entries(m.userConfig)) badKeys.push(...Object.keys(v).filter((pk) => !allowed[pk]).map((pk) => `${k}.${pk}`));
  const envKeys = Object.keys(m.mcpServers.dcp.env);
  check("T6 版本 0.5.2 + 清单键合法 + env 已裁剪", m.version === "0.5.2" && badKeys.length === 0 && envKeys.length === 3, JSON.stringify({ badKeys, envKeys }));
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
