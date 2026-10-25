/* zcode-dcp v0.6.0 冒烟测试：模型隔离计量/校准按模型分文件+回退/显式优先/跨平台 hooks 形态 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const SRC = path.join(__dirname, "..");
const HOOK = path.join(SRC, "hooks", "auto-watch.cjs");
const SERVER = path.join(SRC, "dist", "mcp", "server.js");
const SANDBOX = path.join(os.tmpdir(), "dcp-smoke-home-v6");
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
function fakeRollout(sid, inputTokens, modelId) {
  const rec = { usage: { inputTokens } };
  if (modelId) rec.model = { modelId, providerId: "p" };
  fs.writeFileSync(path.join(SB_ROLLOUT, `model-io-sess_sess_${sid}.jsonl`), JSON.stringify(rec) + "\n");
}
function runHook(args, input, env) {
  return execFileSync("node", [HOOK, args], {
    input: JSON.stringify(input),
    env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX, ...(env || {}) },
    encoding: "utf-8",
  }).trim();
}
const read = (f) => JSON.parse(fs.readFileSync(f, "utf-8"));

// ---------- T1 计量携带模型 ----------
reset();
{
  fakeRollout("m1", 300000, "GLM-5.3-Flash");
  runHook(["stop"], { session_id: "m1", hook_event_name: "Stop" });
  const u = read(path.join(SB_STATE, "usage.json"));
  check("T1 usage 记录 modelId", u.modelId === "GLM-5.3-Flash" && u.usedTokens === 300000);
  // 无模型字段的日志 → modelId null
  fakeRollout("m2", 100000);
  runHook(["stop"], { session_id: "m2", hook_event_name: "Stop" });
  const u2 = read(path.join(SB_STATE, "usage.json"));
  check("T1 无模型记 null", u2.modelId === null);
}

// ---------- T2 校准按模型隔离 + 回退 + 显式优先 ----------
reset();
{
  fs.mkdirSync(SB_STATE, { recursive: true });
  // 模型 A 两个观测（934K）→ 生效
  fakeRollout("a", 120000, "ModelA");
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 900000, sessionId: "a", modelId: "ModelA" }));
  runHook(["stop"], { session_id: "a", hook_event_name: "Stop" }); // 观测1（写盘时校准未达2条）
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 900000, sessionId: "a", modelId: "ModelA" }));
  fakeRollout("a", 125000, "ModelA");
  runHook(["stop"], { session_id: "a", hook_event_name: "Stop" }); // 观测2
  fakeRollout("a", 130000, "ModelA");
  runHook(["stop"], { session_id: "a", hook_event_name: "Stop" }); // 观测已齐 → 校准生效
  const uA = read(path.join(SB_STATE, "usage.json"));
  check("T2 模型A校准生效（专属文件）", uA.windowSource === "calibrated" && uA.contextWindowTokens === 934000 && fs.existsSync(path.join(SB_STATE, "window-calibration-ModelA.json")), JSON.stringify(uA).slice(0, 160));
  // 模型 B：先回退旧全局校准（500K），再在回退窗口的后 40% 区间压缩 → 采到专属观测 1 条（384K），仍不足 2 条不影响生效窗口
  fs.writeFileSync(path.join(SB_STATE, "window-calibration.json"), JSON.stringify({ observations: [
    { observedWindow: 500000, at: "2026-01-01T00:00:00Z" },
    { observedWindow: 500000, at: "2026-01-01T00:01:00Z" },
  ] }));
  fakeRollout("b", 150000, "ModelB");
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 350000, sessionId: "b", modelId: "ModelB" }));
  runHook(["stop"], { session_id: "b", hook_event_name: "Stop" }); // 350K→150K 骤降；回退窗口500K 的后40%（≥300K）→ 采 B 观测
  const uB = read(path.join(SB_STATE, "usage.json"));
  const calB = read(path.join(SB_STATE, "window-calibration-ModelB.json"));
  check("T2 模型B采到专属观测但回退窗口仍生效", uB.windowSource === "calibrated" && uB.contextWindowTokens === 500000 && calB.observations.length === 1 && calB.observations[0].observedWindow === 384000, JSON.stringify({ uB, calB }).slice(0, 220));
  // A 的校准未被 B 污染
  fakeRollout("a", 140000, "ModelA");
  runHook(["stop"], { session_id: "a", hook_event_name: "Stop" });
  const uA2 = read(path.join(SB_STATE, "usage.json"));
  check("T2 模型B观测不污染A", uA2.contextWindowTokens === 934000);
  // 回退：无专属观测的模型 C 读旧全局文件
  fakeRollout("c", 100000, "ModelC");
  runHook(["stop"], { session_id: "c", hook_event_name: "Stop" });
  const uC = read(path.join(SB_STATE, "usage.json"));
  check("T2 模型C回退旧全局校准", uC.windowSource === "calibrated" && uC.contextWindowTokens === 500000, JSON.stringify(uC).slice(0, 160));
  // 显式配置跨模型优先
  fakeRollout("a", 150000, "ModelA");
  runHook(["stop"], { session_id: "a", hook_event_name: "Stop" }, { DCP_CONTEXT_WINDOW_TOKENS: "700000" });
  const uA3 = read(path.join(SB_STATE, "usage.json"));
  check("T2 显式配置跨模型优先", uA3.windowSource === "config" && uA3.contextWindowTokens === 700000);
}

// ---------- T3 压缩事件带模型 ----------
reset();
{
  fakeRollout("d", 120000, "ModelD");
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 900000, sessionId: "d", modelId: "ModelD" }));
  runHook(["stop"], { session_id: "d", hook_event_name: "Stop" });
  const stats = read(path.join(SB_STATE, "compact-stats.json"));
  check("T3 压缩事件记录 modelId", stats.events.length === 1 && stats.events[0].modelId === "ModelD");
  check("T3 校准写入模型专属文件", fs.existsSync(path.join(SB_STATE, "window-calibration-ModelD.json")));
}

// ---------- T3b 同会话换模型不误判压缩、不采错模型观测（验收 M1 回归） ----------
reset();
{
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 800000, sessionId: "e", modelId: "BigModel" }));
  fakeRollout("e", 100000, "SmallModel"); // 同会话换模型：骤降是窗口切换不是压缩
  runHook(["stop"], { session_id: "e", hook_event_name: "Stop" });
  check("T3b 换模型不产生压缩事件", !fs.existsSync(path.join(SB_STATE, "compact-stats.json")));
  check("T3b 换模型不写入 SmallModel 校准观测", !fs.existsSync(path.join(SB_STATE, "window-calibration-SmallModel.json")));
  check("T3b 不产生召回标记", !fs.existsSync(path.join(SB_STATE, "recall-pending-e.json")));
}

// ---------- T3c purge 白名单覆盖模型专属校准文件 ----------
{
  fs.writeFileSync(path.join(SB_STATE, "window-calibration-ModelA.json"), JSON.stringify({ observations: [{ observedWindow: 934000, at: "2026-01-01T00:00:00Z" }] }));
  const out = execFileSync("node", [SERVER], {
    input: [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dcp_reset", arguments: { mode: "list" } } }),
    ].join("\n") + "\n",
    env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX },
    encoding: "utf-8",
  }).trim().split("\n").map((l) => JSON.parse(l));
  const cl = JSON.parse(out[1].result.content[0].text);
  check("T3c list 归类模型校准文件为插件状态", cl.files.find((f) => f.file === "window-calibration-ModelA.json").owned === true);
}

// ---------- T4 跨平台 hooks 形态 ----------
{
  const h = JSON.parse(fs.readFileSync(path.join(SRC, "hooks", "hooks.json"), "utf-8"));
  const cmds = [];
  for (const ev of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    for (const m of h.hooks[ev]) for (const hk of m.hooks) cmds.push(hk.command);
  }
  check("T4 全部 hook 命令 node 直调", cmds.length === 4 && cmds.every((c) => c.startsWith("node ") && c.includes("auto-watch.cjs")), cmds.join(" | ").slice(0, 200));
  check("T4 run-hook.cmd 已删除", !fs.existsSync(path.join(SRC, "hooks", "run-hook.cmd")));
}

// ---------- T5 版本 ----------
{
  const p = JSON.parse(fs.readFileSync(path.join(SRC, ".zcode-plugin", "plugin.json"), "utf-8"));
  const sv = execFileSync("node", [SERVER], {
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
    env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX },
    encoding: "utf-8",
  });
  const ver = JSON.parse(sv.trim().split("\n")[0]).result.serverInfo.version;
  check("T5 版本 0.6.0 一致", p.version === "0.6.0" && ver === "0.6.0");
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
