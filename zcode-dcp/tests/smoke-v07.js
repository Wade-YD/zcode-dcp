/* zcode-dcp v0.7.0 冒烟测试：doctor 体检 / 压缩节省账本 / 调试日志（DCP_DEBUG+config 通道+轮转+隐私红线） / 占用趋势环 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const SRC = path.join(__dirname, "..");
const HOOK = path.join(SRC, "hooks", "auto-watch.cjs");
const SERVER = path.join(SRC, "dist", "mcp", "server.js");
const SANDBOX = path.join(os.tmpdir(), "dcp-smoke-home-v7");
const SB_STATE = path.join(SANDBOX, ".zcode", "dcp");
const SB_ROLLOUT = path.join(SANDBOX, ".zcode", "cli", "rollout");
const SB_CONFIG = path.join(SANDBOX, ".zcode", "cli", "config.json");
const DEBUG_LOG = path.join(SB_STATE, "dcp-debug.log");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ? "| " + String(extra).slice(0, 300) : ""); }
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
// 中和外层环境的 DCP_* 变量，保证沙箱内行为只由用例自身的 env 决定
const NEUTRAL = {
  DCP_PROJECT_DIR: "", DCP_ARCHIVE_SCOPE: "", DCP_MAX_BLOCKS: "", DCP_DEBUG: "",
  DCP_CONTEXT_WINDOW_TOKENS: "", DCP_NUDGE_PERCENT: "", DCP_TIER2_PERCENT: "", DCP_TIER3_PERCENT: "",
  DCP_AUTO_WATCH: "", DCP_NUDGE_GROWTH_TOKENS: "", DCP_NUDGE_COOLDOWN_MINUTES: "", DCP_ABSORB_MIN_TOOL_TOKENS: "",
};
function runHook(args, input, env) {
  return execFileSync("node", [HOOK, args], {
    input: JSON.stringify(input),
    env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX, ...NEUTRAL, ...(env || {}) },
    encoding: "utf-8",
  }).trim();
}
const read = (f) => JSON.parse(fs.readFileSync(f, "utf-8"));
// server JSON-RPC 按行调用：返回按行 JSON 数组
function callServer(lines, env) {
  return execFileSync("node", [SERVER], {
    input: lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
    env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX, ...NEUTRAL, ...(env || {}) },
    encoding: "utf-8",
  }).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
function seedUsage(usedTokens, sid, modelId) {
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens, sessionId: sid || null, modelId: modelId || null }));
}
function byId(rep) {
  return Object.fromEntries(rep.checks.map((c) => [c.id, c]));
}
function doctorCall() {
  const out = callServer([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dcp_doctor", arguments: {} } }]);
  return JSON.parse(out[1].result.content[0].text);
}

// ---------- T1 doctor ----------
// a) 空沙箱（无状态目录）
reset();
{
  const rep = doctorCall();
  const idm = byId(rep);
  check("T1a 空沙箱 verdict=warn", rep.verdict === "warn", JSON.stringify(rep.checks).slice(0, 300));
  check("T1a state_dir warn", idm.state_dir.status === "warn");
  check("T1a metering skipped", idm.metering.status === "skipped");
  check("T1a hooks_shape ok", idm.hooks_shape.status === "ok");
  check("T1a 检查共 12 项", rep.checks.length === 12, String(rep.checks.length));
}

// b) 好状态种子 → 全 ok
reset();
{
  fs.mkdirSync(SB_STATE, { recursive: true });
  fakeRollout("good", 300000, "ModelG");
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({
    usedTokens: 300000, contextWindowTokens: 1000000, windowSource: "config", usedPercent: 30,
    tier3Percent: 80, sessionId: "good", modelId: "ModelG", updatedAt: new Date().toISOString(),
  }));
  fs.writeFileSync(path.join(SB_STATE, "blocks.json"), JSON.stringify({ blocks: [{ blockId: "b001", topic: "t" }], nextBlockId: 2 }));
  fs.writeFileSync(path.join(SB_STATE, "compact-stats.json"), JSON.stringify({ events: [{ at: new Date().toISOString(), preTokens: 500000, postTokens: 300000, saved: 200000, sessionId: "good", modelId: "ModelG" }] }));
  const rep = doctorCall();
  check("T1b 好状态 verdict=ok", rep.verdict === "ok", JSON.stringify(rep.checks).slice(0, 400));
  check("T1b 检查共 12 项", rep.checks.length === 12);
}

// c) 破坏阈值（config.json nudge=70 > tier2=50）→ thresholds fail 且 verdict fail
reset();
{
  fs.mkdirSync(path.dirname(SB_CONFIG), { recursive: true });
  fs.writeFileSync(SB_CONFIG, JSON.stringify({ plugins: { options: { "zcode-dcp@x": { nudge_percent: 70, tier2_percent: 50 } } } }));
  const rep = doctorCall();
  const idm = byId(rep);
  check("T1c thresholds fail", idm.thresholds.status === "fail", JSON.stringify(idm.thresholds).slice(0, 200));
  check("T1c verdict=fail", rep.verdict === "fail");
}

// d) config 损坏 → config_channel warn
reset();
{
  fs.mkdirSync(path.dirname(SB_CONFIG), { recursive: true });
  fs.writeFileSync(SB_CONFIG, "{ this is not json ");
  const rep = doctorCall();
  check("T1d config 损坏 → config_channel warn", byId(rep).config_channel.status === "warn");
}

// ---------- T2 节省账本 ----------
reset();
{
  // a) 25 条假事件无 totals → 压缩后 totalEvents===1（增量，不从 events 重算）
  fs.mkdirSync(SB_STATE, { recursive: true });
  const fakeEvents = [];
  for (let i = 0; i < 25; i++) fakeEvents.push({ at: "2026-01-01T00:00:00.000Z", preTokens: 900000, postTokens: 100000, saved: 800000, sessionId: "old", modelId: null });
  fs.writeFileSync(path.join(SB_STATE, "compact-stats.json"), JSON.stringify({ events: fakeEvents }));
  seedUsage(900000, "L1", "ModelL");
  fakeRollout("L1", 300000, "ModelL");
  runHook(["stop"], { session_id: "L1", hook_event_name: "Stop" });
  const stats = read(path.join(SB_STATE, "compact-stats.json"));
  check("T2a 账本增量为 1（不从 events 重算）", stats.totals && stats.totals.totalEvents === 1, JSON.stringify(stats.totals).slice(0, 240));
  check("T2a events 滚动保留 20 条", stats.events.length === 20, String(stats.events.length));
  const today = new Date().toISOString().slice(0, 10);
  check("T2a perDay 恰 1 键且为今日 UTC", Object.keys(stats.totals.perDay).length === 1 && !!stats.totals.perDay[today], JSON.stringify(Object.keys(stats.totals.perDay)));
  check("T2a perModel.ModelL.events===1", stats.totals.perModel.ModelL && stats.totals.perModel.ModelL.events === 1);
  // b) 第二次压缩（prev 850000 → rollout 320000）
  seedUsage(850000, "L1", "ModelL");
  fakeRollout("L1", 320000, "ModelL");
  runHook(["stop"], { session_id: "L1", hook_event_name: "Stop" });
  const stats2 = read(path.join(SB_STATE, "compact-stats.json"));
  check("T2b totalEvents===2", stats2.totals.totalEvents === 2, JSON.stringify(stats2.totals).slice(0, 160));
  check("T2b totalSaved===1130000", stats2.totals.totalSaved === 600000 + 530000, String(stats2.totals.totalSaved));
  // c) 第三次用 prompt：召回文本含账本累计行
  seedUsage(800000, "L1", "ModelL");
  fakeRollout("L1", 330000, "ModelL");
  const outC = runHook(["prompt"], { session_id: "L1", hook_event_name: "UserPromptSubmit" });
  let ctx = "";
  try { ctx = JSON.parse(outC).additionalContext || ""; } catch {}
  check("T2c 召回文本含累计行", ctx.includes("历史累计 3 次压缩") && ctx.includes("dcp 账本"), ctx.slice(0, 240));
  // d) dcp_reset list：compact-stats.json 归类为插件状态（白名单回归）
  const outD = callServer([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dcp_reset", arguments: { mode: "list" } } }]);
  const cl = JSON.parse(outD[1].result.content[0].text);
  check("T2d compact-stats.json owned", cl.files.find((f) => f.file === "compact-stats.json").owned === true);
  // e) perDayRecent 近 7 天：totals.perDay 含 10 个 UTC 日期键 → context_stats 只取排序后末 7 个
  const dayKeys = [];
  for (let i = 0; i < 10; i++) dayKeys.push(`2026-${String(i + 1).padStart(2, "0")}-15`);
  const perDaySeed = {};
  for (const d of dayKeys) perDaySeed[d] = { events: 1, saved: 1000 };
  fs.writeFileSync(path.join(SB_STATE, "compact-stats.json"), JSON.stringify({
    events: [],
    totals: { since: "2026-01-15T00:00:00.000Z", totalEvents: 10, totalSaved: 10000, perModel: {}, perDay: perDaySeed },
  }));
  const outE2 = callServer([INIT, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "context_stats", arguments: {} } }]);
  const cst = JSON.parse(outE2[1].result.content[0].text);
  check("T2e perDayRecent 恰 7 条", Array.isArray(cst.savings.perDayRecent) && cst.savings.perDayRecent.length === 7, JSON.stringify(cst.savings && cst.savings.perDayRecent).slice(0, 200));
  check("T2e perDayRecent 为排序后末 7 键", cst.savings.perDayRecent[0].day === dayKeys[3] && cst.savings.perDayRecent[6].day === dayKeys[9], JSON.stringify(cst.savings.perDayRecent.map((p) => p.day)));
}

// ---------- T3 调试日志 ----------
const DBG_KEYS = new Set(["ts", "detail", "mode", "event", "sid", "used", "modelId", "prevUsed", "prevModelId", "tier", "pct", "win", "winSource", "decision", "pre", "post", "saved", "tool", "tokens", "count", "msg"]);
reset();
{
  // a) 无 env 无 config → 不写调试日志
  fakeRollout("a1", 100000);
  runHook(["prompt"], { session_id: "a1", hook_event_name: "UserPromptSubmit" });
  check("T3a 默认不写调试日志", !fs.existsSync(DEBUG_LOG));
  // b) DCP_DEBUG=1 → 文件存在、逐行 JSON、字段不越界
  fakeRollout("b1", 150000);
  runHook(["prompt"], { session_id: "b1", hook_event_name: "UserPromptSubmit" }, { DCP_DEBUG: "1" });
  check("T3b env 开启后日志存在", fs.existsSync(DEBUG_LOG));
  let linesOk = true;
  let keysOk = true;
  let lineCount = 0;
  for (const line of fs.readFileSync(DEBUG_LOG, "utf-8").split("\n").filter(Boolean)) {
    lineCount++;
    let obj;
    try { obj = JSON.parse(line); } catch { linesOk = false; continue; }
    for (const k of Object.keys(obj)) if (!DBG_KEYS.has(k)) keysOk = false;
  }
  check("T3b 逐行 JSON 可解析", linesOk && lineCount > 0, String(lineCount));
  check("T3b 行字段不越界", keysOk);
  // c) 隐私红线：tool 模式下 tool_response 长文含标记，日志全文不含该标记
  const longResp = "SECRETMARKER123 " + "x".repeat(5000) + " SECRETMARKER123";
  runHook(["tool"], { session_id: "c1", hook_event_name: "PostToolUse", tool_name: "Read", tool_response: longResp }, { DCP_DEBUG: "1", DCP_ABSORB_MIN_TOOL_TOKENS: "100" });
  const dbgText = fs.readFileSync(DEBUG_LOG, "utf-8");
  check("T3c 隐私红线（不含 tool_response 内容）", !dbgText.includes("SECRETMARKER123"));
  // d) 轮转：预写 600KB → 跑一次 → .1 产生且主日志变小
  fs.writeFileSync(DEBUG_LOG, Buffer.alloc(600 * 1024, "x".charCodeAt(0)));
  fakeRollout("d1", 160000);
  runHook(["prompt"], { session_id: "d1", hook_event_name: "UserPromptSubmit" }, { DCP_DEBUG: "1" });
  check("T3d 超限轮转产生 .1", fs.existsSync(DEBUG_LOG + ".1"));
  check("T3d 主日志变小", fs.statSync(DEBUG_LOG).size < 600 * 1024);
  // e) config 通道：无 env，config debug_log=true → 文件存在
  reset();
  fs.mkdirSync(path.dirname(SB_CONFIG), { recursive: true });
  fs.writeFileSync(SB_CONFIG, JSON.stringify({ plugins: { options: { "zcode-dcp@x": { debug_log: true } } } }));
  fakeRollout("e1", 100000);
  runHook(["prompt"], { session_id: "e1", hook_event_name: "UserPromptSubmit" });
  check("T3e config 通道开启调试日志", fs.existsSync(DEBUG_LOG));
  // f) dcp_reset：list owned + purge 删除
  const outF1 = callServer([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dcp_reset", arguments: { mode: "list" } } }]);
  const clF = JSON.parse(outF1[1].result.content[0].text);
  const dbgEntry = clF.files.find((f) => f.file === "dcp-debug.log");
  check("T3f list 调试日志 owned", dbgEntry && dbgEntry.owned === true);
  const outF2 = callServer([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dcp_reset", arguments: { mode: "purge", confirm: true } } }]);
  const pr = JSON.parse(outF2[1].result.content[0].text);
  check("T3f purge 删除调试日志", Array.isArray(pr.removedFiles) && pr.removedFiles.includes("dcp-debug.log"), JSON.stringify(pr.removedFiles || []).slice(0, 200));
  check("T3f purge 后文件不存在", !fs.existsSync(DEBUG_LOG));
}

// ---------- T4 占用趋势环 ----------
reset();
{
  // a) sid t1 三轮 prompt 100000→150000→200000 → history 3 点
  for (const v of [100000, 150000, 200000]) {
    fakeRollout("t1", v);
    runHook(["prompt"], { session_id: "t1", hook_event_name: "UserPromptSubmit" });
  }
  let u = read(path.join(SB_STATE, "usage.json"));
  check("T4a history 3 点", Array.isArray(u.history) && u.history.length === 3, JSON.stringify((u.history || []).map((p) => p.used)));
  // b) 再跑一次 stop（rollout 仍 200000）→ 同用量去重
  fakeRollout("t1", 200000);
  runHook(["stop"], { session_id: "t1", hook_event_name: "Stop" });
  u = read(path.join(SB_STATE, "usage.json"));
  check("T4b 同用量去重", Array.isArray(u.history) && u.history.length === 3, JSON.stringify((u.history || []).map((p) => p.used)));
  // c) 补到最近 10 点等差 +50000：250000…550000（共 10 点）
  for (let v = 250000; v <= 550000; v += 50000) {
    fakeRollout("t1", v);
    runHook(["prompt"], { session_id: "t1", hook_event_name: "UserPromptSubmit" });
  }
  const outC = callServer([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "context_usage", arguments: {} } }]);
  const cu = JSON.parse(outC[1].result.content[0].text);
  check("T4c trend 存在", cu.available === true && cu.trend && Array.isArray(cu.trend.points), JSON.stringify(cu).slice(0, 260));
  check("T4c 最近 10 点等差 avgGrowth=50000", cu.trend.avgGrowthTokensPerTurn === 50000, String(cu.trend && cu.trend.avgGrowthTokensPerTurn));
  check("T4c points 10 点", cu.trend.points.length === 10, String(cu.trend.points.length));
  const lastUsed = cu.trend.points[cu.trend.points.length - 1].used;
  const expectT3 = Math.max(0, Math.ceil((1000000 * 0.8 - lastUsed) / 50000));
  check("T4c turnsToTier3 按公式", cu.trend.turnsToTier3 === expectT3, `got ${cu.trend.turnsToTier3} expect ${expectT3}`);
  // d) sid t2 接管 → history 重置为 1
  fakeRollout("t2", 60000);
  runHook(["prompt"], { session_id: "t2", hook_event_name: "UserPromptSubmit" });
  u = read(path.join(SB_STATE, "usage.json"));
  check("T4d 会话变更重置 history", Array.isArray(u.history) && u.history.length === 1, JSON.stringify((u.history || []).map((p) => p.used)));
  // e) 旧文件无 history 字段：server 不报错无 trend，hook 重建 history
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({
    usedTokens: 200000, contextWindowTokens: 1000000, usedPercent: 20, tier3Percent: 80, updatedAt: new Date().toISOString(),
  }));
  const outE = callServer([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "context_usage", arguments: {} } }]);
  const cuE = JSON.parse(outE[1].result.content[0].text);
  check("T4e 旧文件 available", cuE.available === true);
  check("T4e 旧文件无 trend 字段", cuE.trend === undefined);
  fakeRollout("t3", 210000);
  runHook(["prompt"], { session_id: "t3", hook_event_name: "UserPromptSubmit" });
  u = read(path.join(SB_STATE, "usage.json"));
  check("T4e hook 重建 history 为 1", Array.isArray(u.history) && u.history.length === 1, JSON.stringify((u.history || []).map((p) => p.used)));
  // f) 60 点上限：预置 70 点 history，再计一轮 → 裁剪为 60 且最旧被挤出
  const pts70 = [];
  for (let i = 0; i < 70; i++) pts70.push({ t: new Date(Date.now() - (70 - i) * 60000).toISOString(), used: 100000 + i * 100, pct: 10 + i * 0.1, modelId: null, sid: "cap" });
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({
    usedTokens: 200000, contextWindowTokens: 1000000, usedPercent: 20, tier3Percent: 80,
    sessionId: "cap", modelId: null, updatedAt: new Date().toISOString(), history: pts70,
  }));
  fakeRollout("cap", 300000);
  runHook(["prompt"], { session_id: "cap", hook_event_name: "UserPromptSubmit" });
  u = read(path.join(SB_STATE, "usage.json"));
  check("T4f history 裁剪为 60", Array.isArray(u.history) && u.history.length === 60, String((u.history || []).length));
  check("T4f 最旧点被挤出", u.history[0].used === pts70[11].used);
  // g) 同会话换模型 → 重置环（切换跳变不进入增速估计）
  fakeRollout("cap", 310000, "ModelX");
  runHook(["prompt"], { session_id: "cap", hook_event_name: "UserPromptSubmit" });
  u = read(path.join(SB_STATE, "usage.json"));
  check("T4g 换模型重置 history", Array.isArray(u.history) && u.history.length === 1, JSON.stringify((u.history || []).map((p) => p.modelId)));
}

// ---------- T5 版本 ----------
{
  const p = JSON.parse(fs.readFileSync(path.join(SRC, ".zcode-plugin", "plugin.json"), "utf-8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf-8"));
  const sv = execFileSync("node", [SERVER], {
    input: JSON.stringify(INIT) + "\n",
    env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX, ...NEUTRAL },
    encoding: "utf-8",
  });
  const ver = JSON.parse(sv.trim().split("\n")[0]).result.serverInfo.version;
  check("T5 版本 0.8.0 三处一致", p.version === "0.8.0" && pkg.version === "0.8.0" && ver === "0.8.0");
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
