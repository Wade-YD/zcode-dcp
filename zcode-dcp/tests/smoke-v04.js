/* zcode-dcp v0.4 系冒烟测试
 * 覆盖: 骤降压缩检测+窗口校准 / 会话隔离 / 项目命名空间 / 蒸馏与重复提示 / absorb-lite
 * 隔离: USERPROFILE/HOME 指向沙箱 %TEMP%\dcp-smoke-home-v4
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const SRC = path.join(__dirname, "..");
const HOOK = path.join(SRC, "hooks", "auto-watch.cjs");
const SERVER = path.join(SRC, "dist", "mcp", "server.js");
const SANDBOX = path.join(os.tmpdir(), "dcp-smoke-home-v4");
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
const compress = (id, topic, summary) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "compress", arguments: { topic, summary } } });

// ---------- T1 骤降检测 + 窗口校准 + 即时召回 ----------
reset();
{
  fakeRollout("a", 120000);
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 900000, sessionId: "a" }));
  fs.writeFileSync(path.join(SB_STATE, "nudge-a.json"), JSON.stringify({ lastNudgeAt: new Date().toISOString(), lastNudgeTokens: 890000, lastTier: 2 }));
  const out = runHook(["prompt"], { session_id: "a", hook_event_name: "UserPromptSubmit", cwd: "E:/projA" });
  check("T1 骤降检出并注入召回", out.includes("压缩召回") && out.includes("归档索引") && out.includes("900,000"), out.slice(0, 150));
  const stats = read(path.join(SB_STATE, "compact-stats.json"));
  check("T1 压缩事件记录含节省量", stats.events.length === 1 && stats.events[0].saved === 780000, JSON.stringify(stats));
  const cal = read(path.join(SB_STATE, "window-calibration.json"));
  check("T1 窗口校准 = 前值+34000", cal.observations.length === 1 && cal.observations[0].observedWindow === 934000);
  check("T1 提醒状态已重置", !fs.existsSync(path.join(SB_STATE, "nudge-a.json")));
  // 正常回落不误判
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 500000, sessionId: "a" }));
  fakeRollout("a", 480000);
  const out2 = runHook(["prompt"], { session_id: "a", hook_event_name: "UserPromptSubmit", cwd: "E:/projA" });
  const stats2 = read(path.join(SB_STATE, "compact-stats.json"));
  check("T1 小幅回落不误判", stats2.events.length === 1 && out2 === "");
  // 校准生效（≥2 观测后）与显式配置优先
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 900000, sessionId: "a" }));
  fakeRollout("a", 120000);
  runHook(["stop"], { session_id: "a", hook_event_name: "Stop" }); // 第 2 个观测（本轮写盘时校准尚未达 2 条）
  fs.writeFileSync(path.join(SB_STATE, "usage.json"), JSON.stringify({ usedTokens: 900000, sessionId: "a" }));
  fakeRollout("a", 125000);
  runHook(["stop"], { session_id: "a", hook_event_name: "Stop" }); // 第 3 个观测
  fakeRollout("a", 130000);
  runHook(["stop"], { session_id: "a", hook_event_name: "Stop" }); // 观测已齐，本轮写盘应使用校准窗口
  const u = read(path.join(SB_STATE, "usage.json"));
  check("T1 校准窗口生效 windowSource=calibrated", u.contextWindowTokens === 934000 && u.windowSource === "calibrated", JSON.stringify(u).slice(0, 160));
  fakeRollout("a", 130000);
  runHook(["stop"], { session_id: "a", hook_event_name: "Stop" }, { DCP_CONTEXT_WINDOW_TOKENS: "500000" });
  const u2 = read(path.join(SB_STATE, "usage.json"));
  check("T1 显式配置优先 windowSource=config", u2.contextWindowTokens === 500000 && u2.windowSource === "config");
}

// ---------- T2 会话隔离 ----------
reset();
{
  fakeRollout("aaa", 550000);
  fakeRollout("bbb", 560000);
  const outA = runHook(["prompt"], { session_id: "aaa", hook_event_name: "UserPromptSubmit" });
  check("T2 会话 A tier1 注入", outA.includes("tier1"));
  const outB = runHook(["prompt"], { session_id: "bbb", hook_event_name: "UserPromptSubmit" });
  check("T2 会话 B 不受 A 冷却影响", outB.includes("tier1"), outB.slice(0, 100));
  const outA2 = runHook(["prompt"], { session_id: "aaa", hook_event_name: "UserPromptSubmit" });
  check("T2 会话 A 同级冷却仍生效", outA2 === "");
  // 严格匹配：sid=zzz 无日志 → 不读 bbb 的
  const usageBefore = fs.readFileSync(path.join(SB_STATE, "usage.json"), "utf-8");
  const outZ = runHook(["prompt"], { session_id: "zzz", hook_event_name: "UserPromptSubmit" });
  const usageAfter = fs.readFileSync(path.join(SB_STATE, "usage.json"), "utf-8");
  check("T2 陌生会话不计量不读他人日志", outZ === "" && usageAfter === usageBefore);
}

// ---------- T3 项目命名空间 + 种子迁移 + hook/server 一致 ----------
reset();
{
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.writeFileSync(path.join(SB_STATE, "blocks.json"), JSON.stringify({ blocks: [{ blockId: "b001", topic: "旧全局块", active: true }], nextBlockId: 2 }));
  const envA = { DCP_PROJECT_DIR: "E:/projA" };
  const r1 = rpc([INIT, compress(2, "项目A专属", "projA only")], envA);
  const c1 = JSON.parse(r1[1].result.content[0].text);
  check("T3 project scope 写入哈希文件", c1.blockId === "b002" && fs.existsSync(path.join(SB_STATE, `blocks-${pHash("E:/projA")}.json`)));
  const seeded = read(path.join(SB_STATE, `blocks-${pHash("E:/projA")}.json`));
  check("T3 旧全局块种子迁移", seeded.blocks.some((b) => b.topic === "旧全局块"));
  const r2 = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_context", arguments: { query: "项目A" } } }], { DCP_PROJECT_DIR: "E:/projB" });
  const s1 = JSON.parse(r2[1].result.content[0].text);
  check("T3 项目 B 检索不到项目 A", s1.total === 0);
  // hook 与 server 同项目同文件（session-start 索引含项目A块）
  const hookOut = runHook(["session-start"], { hook_event_name: "SessionStart", cwd: "E:/projA" });
  check("T3 hook 按项目解析命中同文件", hookOut.includes("项目A专属"), hookOut.slice(-200));
  // global scope 回退旧行为
  const r3 = rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_context", arguments: { query: "旧全局" } } }], { DCP_PROJECT_DIR: "E:/projB", DCP_ARCHIVE_SCOPE: "global" });
  const s2 = JSON.parse(r3[1].result.content[0].text);
  check("T3 global scope 共享可见", s2.total >= 1);
}

// ---------- T4 蒸馏 + 重复提示 ----------
reset();
{
  fs.mkdirSync(SB_STATE, { recursive: true });
  const seed = { blocks: [], nextBlockId: 6 }; // 与已有 b001-b005 一致的合法状态
  for (let i = 1; i <= 5; i++) {
    seed.blocks.push({
      blockId: `b00${i}`, topic: `旧块${i}`, active: true, tags: [], type: "general",
      createdAt: new Date(Date.now() - (6 - i) * 60000).toISOString(),
      summary: i === 2 ? `旧块${i}内容\nOpen objectives: 修复启动崩溃 (m00746)` : `旧块${i}内容`,
    });
  }
  fs.writeFileSync(path.join(SB_STATE, "blocks.json"), JSON.stringify(seed)); // 无项目目录 → legacy 文件
  const env = { DCP_MAX_BLOCKS: "5", DCP_ARCHIVE_SCOPE: "global" };
  const r1 = rpc([INIT, compress(2, "触发块", "trigger")], env);
  const c1 = JSON.parse(r1[1].result.content[0].text);
  check("T4 超限触发蒸馏", !!c1.distilled && c1.distilled.mergedCount === 2, JSON.stringify(c1).slice(0, 300));
  const store = read(path.join(SB_STATE, "blocks.json"));
  check("T4 蒸馏后总数回落", store.blocks.length === 5 && store.blocks.some((b) => b.topic.includes("蒸馏归档")));
  const distilledBlock = store.blocks.find((b) => b.topic.includes("蒸馏归档"));
  check("T4 Open objectives 逐字保留", distilledBlock.summary.includes("Open objectives: 修复启动崩溃 (m00746)"));
  check("T4 被蒸馏块移除", !store.blocks.some((b) => b.blockId === "b001"));
  // 重复主题
  const r2 = rpc([INIT, compress(3, "触发块", "again")], env);
  const c2 = JSON.parse(r2[1].result.content[0].text);
  check("T4 重复主题提示 possibleDuplicates", Array.isArray(c2.possibleDuplicates) && c2.possibleDuplicates.length === 1);
}

// ---------- T5 absorb-lite ----------
reset();
{
  const big = "x".repeat(40000); // ≈10000 tokens
  const input = { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: big };
  const out1 = runHook(["tool"], input);
  check("T5 大结果触发 absorb 提示", out1.includes("dcp absorb") && out1.includes("compress") && out1.includes("报错原文"), out1.slice(0, 120));
  const out2 = runHook(["tool"], { ...input, tool_name: "Read" });
  check("T5 会话级冷却内不重复", out2 === "");
  const small = { session_id: "s2", hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: "ok" };
  check("T5 小结果不触发", runHook(["tool"], small) === "");
  const disabled = runHook(["tool"], { session_id: "s3", hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: big }, { DCP_ABSORB_MIN_TOOL_TOKENS: "0" });
  check("T5 阈值 0 关闭", disabled === "");
}

// ---------- T6 版本与 JSON 健全 ----------
{
  const p = JSON.parse(fs.readFileSync(path.join(SRC, ".zcode-plugin", "plugin.json"), "utf-8"));
  check("T6 版本 0.5.1 + 配置齐全", p.version === "0.5.1" && !!p.userConfig.archive_scope && !!p.userConfig.max_blocks && !!p.userConfig.absorb_min_tool_tokens);
  const h = JSON.parse(fs.readFileSync(path.join(SRC, "hooks", "hooks.json"), "utf-8"));
  check("T6 PostToolUse 已注册", !!h.hooks.PostToolUse);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
