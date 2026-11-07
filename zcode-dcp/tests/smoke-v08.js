/* zcode-dcp v0.8.0 冒烟测试：PostToolUseFailure 死胡同提醒（计数/冷却/中断跳过/成功清零/陈旧衰减/开关/config 通道） / doctor plugin_enabled 第 12 检查 / 状态治理 / 文档欠账与版本 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const SRC = path.join(__dirname, "..");
const HOOK = path.join(SRC, "hooks", "auto-watch.cjs");
const SERVER = path.join(SRC, "dist", "mcp", "server.js");
const SANDBOX = path.join(os.tmpdir(), "dcp-smoke-home-v8");
const SB_STATE = path.join(SANDBOX, ".zcode", "dcp");
const SB_ROLLOUT = path.join(SANDBOX, ".zcode", "cli", "rollout");
const SB_CONFIG = path.join(SANDBOX, ".zcode", "cli", "config.json");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ? "| " + String(extra).slice(0, 300) : ""); }
}
function reset() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SB_ROLLOUT, { recursive: true });
}
// failure 模式不读 rollout，保留 fakeRollout 仅维持骨架一致性
function fakeRollout(sid, inputTokens, modelId) {
  const rec = { usage: { inputTokens } };
  if (modelId) rec.model = { modelId, providerId: "p" };
  fs.writeFileSync(path.join(SB_ROLLOUT, `model-io-sess_sess_${sid}.jsonl`), JSON.stringify(rec) + "\n");
}
// 中和外层环境的 DCP_* 变量，保证沙箱内行为只由用例自身的 env 决定
// 注意：DCP_FAILURE_NUDGE_THRESHOLD 不得置空串（nonNeg 语义下 "" 会被解析为 0 关闭功能），
// 缺省即让 hook 用默认阈值 2；需要 0 的用例在自身 env 里显式传 "0"（见 T1f）
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
function byId(rep) {
  return Object.fromEntries(rep.checks.map((c) => [c.id, c]));
}
function doctorCall() {
  const out = callServer([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dcp_doctor", arguments: {} } }]);
  return JSON.parse(out[1].result.content[0].text);
}
const ctxOf = (out) => {
  let ctx = "";
  try { ctx = JSON.parse(out).additionalContext || ""; } catch {}
  return ctx;
};

// ---------- T1a 死胡同提醒基础：第 2 次达阈值提醒（failure 模式不读 rollout，无需种子） ----------
reset();
const F1 = path.join(SB_STATE, "failure-f1.json");
{
  const inp = { session_id: "f1", hook_event_name: "PostToolUseFailure", tool_name: "Bash" };
  const out1 = runHook(["failure"], inp);
  check("T1a 第 1 次无提醒", ctxOf(out1) === "", out1.slice(0, 120));
  const out2 = runHook(["failure"], inp);
  const ctx2 = ctxOf(out2);
  check("T1a 第 2 次提醒含连续失败 2 次", ctx2.includes("连续失败 2 次"), ctx2.slice(0, 240));
  check("T1a 提醒含工具名 Bash", ctx2.includes("Bash"), ctx2.slice(0, 240));
  check("T1a 提醒引导 compress 归档", ctx2.includes("compress"), ctx2.slice(0, 240));
  const st = read(F1);
  check("T1a 触发后计数归零", st.tools.Bash && st.tools.Bash.count === 0, JSON.stringify(st).slice(0, 200));
  check("T1a lastNudgeAt 非空", !!(st.tools.Bash && st.tools.Bash.lastNudgeAt), JSON.stringify(st).slice(0, 200));
}

// ---------- T1b 冷却内再触发：无输出且计数归零（紧接 T1a 同沙箱） ----------
{
  const inp = { session_id: "f1", hook_event_name: "PostToolUseFailure", tool_name: "Bash" };
  const out3 = runHook(["failure"], inp);
  const out4 = runHook(["failure"], inp);
  check("T1b 冷却内两次均无输出", out3 === "" && out4 === "", (out3 + "|" + out4).slice(0, 120));
  const st = read(F1);
  check("T1b 冷却内计数归零", st.tools.Bash.count === 0, JSON.stringify(st).slice(0, 200));
}

// ---------- T2 状态治理：failure-f1.json 归类为插件状态且 purge 可删（接 T1a/T1b 同沙箱） ----------
{
  const outL = callServer([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dcp_reset", arguments: { mode: "list" } } }]);
  const cl = JSON.parse(outL[1].result.content[0].text);
  const entry = cl.files.find((f) => f.file === "failure-f1.json");
  check("T2 list failure-f1.json owned", !!entry && entry.owned === true, JSON.stringify(cl.files || []).slice(0, 240));
  check("T2 category 含失败计数", !!entry && String(entry.category).includes("失败计数"), entry && entry.category);
  const outP = callServer([INIT, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dcp_reset", arguments: { mode: "purge", confirm: true } } }]);
  const pr = JSON.parse(outP[1].result.content[0].text);
  check("T2 purge removedFiles 含 failure-f1.json", Array.isArray(pr.removedFiles) && pr.removedFiles.includes("failure-f1.json"), JSON.stringify(pr.removedFiles || []).slice(0, 240));
  check("T2 purge 后磁盘不存在", !fs.existsSync(F1));
}

// ---------- T1c is_interrupt：不计入失败 ----------
reset();
{
  const inp = { session_id: "f2", hook_event_name: "PostToolUseFailure", tool_name: "Bash", is_interrupt: true };
  const outs = [runHook(["failure"], inp), runHook(["failure"], inp), runHook(["failure"], inp)];
  check("T1c 中断三次均无输出", outs.every((o) => o === ""), outs.map((o) => o.slice(0, 60)).join("|").slice(0, 200));
  const ff = path.join(SB_STATE, "failure-f2.json");
  let noBash = true;
  if (fs.existsSync(ff)) {
    try { noBash = !read(ff).tools.Bash; } catch { noBash = false; }
  }
  check("T1c failure-f2.json 不存在或无 Bash 条目", noBash);
}

// ---------- T1d 成功清零：tool 模式成功即清，失败从零重计 ----------
reset();
{
  const finp = { session_id: "f3", hook_event_name: "PostToolUseFailure", tool_name: "Bash" };
  const out1 = runHook(["failure"], finp); // count=1
  check("T1d 首次失败无输出", ctxOf(out1) === "", out1.slice(0, 120));
  const ff = path.join(SB_STATE, "failure-f3.json");
  check("T1d 失败文件存在", fs.existsSync(ff));
  runHook(["tool"], { session_id: "f3", hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: "ok" });
  let cleared = true;
  if (fs.existsSync(ff)) {
    try { cleared = !read(ff).tools.Bash; } catch { cleared = false; }
  }
  check("T1d 成功后 Bash 条目不存在（或文件被清）", cleared);
  const out2 = runHook(["failure"], finp);
  const st = read(ff);
  check("T1d 从零重计 count===1", st.tools.Bash && st.tools.Bash.count === 1, JSON.stringify(st).slice(0, 200));
  check("T1d 重计未达阈值无输出", ctxOf(out2) === "", out2.slice(0, 120));
}

// ---------- T1e 陈旧衰减：31 分钟前的失败计数重计 ----------
reset();
{
  const ff = path.join(SB_STATE, "failure-f4.json");
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(ff, JSON.stringify({ tools: { Bash: { count: 1, lastAt: new Date(Date.now() - 31 * 60000).toISOString() } } }));
  const inp = { session_id: "f4", hook_event_name: "PostToolUseFailure", tool_name: "Bash" };
  const out1 = runHook(["failure"], inp);
  let st = read(ff);
  check("T1e 陈旧计数衰减重计为 1", st.tools.Bash.count === 1, JSON.stringify(st).slice(0, 200));
  check("T1e 未达阈值无输出", ctxOf(out1) === "", out1.slice(0, 120));
  const out2 = runHook(["failure"], inp);
  st = read(ff);
  check("T1e 再一次达 2 次并提醒", st.tools.Bash.count === 0 && ctxOf(out2).includes("连续失败 2 次"), JSON.stringify(st).slice(0, 160) + " | " + ctxOf(out2).slice(0, 120));
}

// ---------- T1f threshold=0 关闭：env 通道 ----------
reset();
{
  const inp = { session_id: "f5", hook_event_name: "PostToolUseFailure", tool_name: "Bash" };
  for (let i = 0; i < 3; i++) {
    const out = runHook(["failure"], inp, { DCP_FAILURE_NUDGE_THRESHOLD: "0" });
    check(`T1f 第 ${i + 1} 次无输出`, out === "", out.slice(0, 120));
  }
  check("T1f 文件不存在", !fs.existsSync(path.join(SB_STATE, "failure-f5.json")));
}

// ---------- T1g config 通道：threshold=3，第 3 次才提醒 ----------
reset();
{
  fs.mkdirSync(path.dirname(SB_CONFIG), { recursive: true });
  fs.writeFileSync(SB_CONFIG, JSON.stringify({ plugins: { options: { "zcode-dcp@x": { failure_nudge_threshold: 3 } } } }));
  const inp = { session_id: "f6", hook_event_name: "PostToolUseFailure", tool_name: "Bash" };
  const out1 = runHook(["failure"], inp);
  const out2 = runHook(["failure"], inp);
  const out3 = runHook(["failure"], inp);
  check("T1g 前 2 次无输出", ctxOf(out1) === "" && ctxOf(out2) === "", (out1 + "|" + out2).slice(0, 120));
  check("T1g 第 3 次提醒含连续失败 3 次", ctxOf(out3).includes("连续失败 3 次"), ctxOf(out3).slice(0, 240));
}

// ---------- T3 B 矩阵：pluginEnabledStatus 纯函数 + doctor 集成 ----------
{
  const { pluginEnabledStatus } = require("../dist/dcp-common.cjs"); // 相对本文件：tests → dist/dcp-common.cjs（静态字符串）
  const r0 = pluginEnabledStatus(null, "zcode-dcp", "m");
  check("T3a null → skipped", r0.status === "skipped", JSON.stringify(r0));
  const r1 = pluginEnabledStatus({}, "zcode-dcp", "m");
  check("T3a {} → warn/no-entries", r1.status === "warn" && r1.reason === "no-entries", JSON.stringify(r1));
  const r2 = pluginEnabledStatus({ "zcode-dcp@a": true }, "zcode-dcp", "m");
  check("T3a 单条目启用 → ok", r2.status === "ok", JSON.stringify(r2));
  const r3 = pluginEnabledStatus({ "zcode-dcp@a": false }, "zcode-dcp", "m");
  check("T3a 单条目禁用 → fail", r3.status === "fail", JSON.stringify(r3));
  const r4 = pluginEnabledStatus({ "zcode-dcp@a": true, "zcode-dcp@b": true }, "zcode-dcp", "m");
  check("T3a 双开 → warn/multi-enabled", r4.status === "warn" && r4.reason === "multi-enabled" && r4.enabledKeys.length === 2, JSON.stringify(r4));
  const r5 = pluginEnabledStatus({ "zcode-dcp@a": false, "zcode-dcp@b": true }, "zcode-dcp", "m");
  check("T3a 唯一启用 → ok/unique-enabled", r5.status === "ok" && r5.reason === "unique-enabled" && r5.selfKey === "zcode-dcp@b", JSON.stringify(r5));
  const r6 = pluginEnabledStatus({ "zcode-dcp@a": false, "zcode-dcp@b": false }, "zcode-dcp", "m");
  check("T3a 多条目全禁 → fail", r6.status === "fail", JSON.stringify(r6));
}
reset();
{
  const rep = doctorCall();
  const idm = byId(rep);
  check("T3b 空沙箱 plugin_enabled skipped", idm.plugin_enabled.status === "skipped", JSON.stringify(idm.plugin_enabled).slice(0, 200));
  check("T3b 空沙箱检查共 12 项", rep.checks.length === 12, String(rep.checks.length));
}
reset();
{
  fs.mkdirSync(path.dirname(SB_CONFIG), { recursive: true });
  fs.writeFileSync(SB_CONFIG, JSON.stringify({ plugins: { enabledPlugins: { "zcode-dcp@m1": true } } }));
  const rep = doctorCall();
  check("T3b 单条目启用 → plugin_enabled ok", byId(rep).plugin_enabled.status === "ok", JSON.stringify(byId(rep).plugin_enabled).slice(0, 200));
}
reset();
{
  fs.mkdirSync(path.dirname(SB_CONFIG), { recursive: true });
  fs.writeFileSync(SB_CONFIG, JSON.stringify({ plugins: { enabledPlugins: { "zcode-dcp@m1": true, "zcode-dcp@m2": true } } }));
  const rep = doctorCall();
  check("T3b 双开 → plugin_enabled warn", byId(rep).plugin_enabled.status === "warn", JSON.stringify(byId(rep).plugin_enabled).slice(0, 200));
  check("T3b 双开 verdict=warn", rep.verdict === "warn", rep.verdict);
}
reset();
{
  fs.mkdirSync(path.dirname(SB_CONFIG), { recursive: true });
  fs.writeFileSync(SB_CONFIG, JSON.stringify({ plugins: { enabledPlugins: { "zcode-dcp@m1": false } } }));
  const rep = doctorCall();
  check("T3b 单条目禁用 → plugin_enabled fail", byId(rep).plugin_enabled.status === "fail", JSON.stringify(byId(rep).plugin_enabled).slice(0, 200));
  check("T3b 单条目禁用 verdict=fail", rep.verdict === "fail", rep.verdict);
}

// ---------- T4 C/F-lite：文档欠账 + search_context 零命中提示 ----------
reset();
{
  const usageMd = fs.readFileSync(path.join(SRC, "commands", "dcp-usage.md"), "utf-8");
  check("T4 dcp-usage.md 含 trend", usageMd.includes("trend"), usageMd.slice(0, 200));
  const statsMd = fs.readFileSync(path.join(SRC, "commands", "dcp-stats.md"), "utf-8");
  check("T4 dcp-stats.md 含 savings", statsMd.includes("savings"), statsMd.slice(0, 200));
  fs.mkdirSync(SB_STATE, { recursive: true }); // 空归档（blocks.json 不存在 → 0 块）
  const out = callServer([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_context", arguments: { query: "不存在的关键词xyz" } } }]);
  const sc = JSON.parse(out[1].result.content[0].text);
  check("T4 search_context 零命中 total===0", sc.total === 0, JSON.stringify(sc).slice(0, 200));
  check("T4 零命中 message 含关键词重试提示", String(sc.message).includes("关键词"), String(sc.message).slice(0, 200));
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
