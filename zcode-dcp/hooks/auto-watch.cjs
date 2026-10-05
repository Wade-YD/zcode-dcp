#!/usr/bin/env node
/**
 * ZCode DCP v0.2.0 自动上下文计量 hook
 *
 * 模式（argv[2]）:
 *   session-start  会话启动：注入 DCP 工具说明（替代 v0.1 的 bash session-start）
 *   prompt         UserPromptSubmit：计量 + 达阈值注入压缩提醒（additionalContext）
 *   stop           Stop：仅计量（写 usage.json），不输出
 *
 * 数据源: ~/.zcode/cli/rollout/model-io-sess_<sessionId>.jsonl 最后一行的 usage.inputTokens
 *         —— 这是上一轮模型请求的真实输入规模，即当前上下文占用。
 * 状态:   ~/.zcode/dcp/usage.json（供 MCP server 的 context_usage/context_stats 读取）
 *
 * 任何错误都静默退出（exit 0），绝不阻塞对话。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".zcode", "dcp");
const USAGE_FILE = path.join(STATE_DIR, "usage.json");
const NUDGE_FILE = path.join(STATE_DIR, "nudge.json");
const ROLLOUT_DIR = path.join(HOME, ".zcode", "cli", "rollout");

const DEFAULTS = {
  context_window_tokens: 200000,
  nudge_percent: 50,
  nudge_cooldown_minutes: 10,
  auto_watch: true,
};

// ---------- 配置: env > config.json（任意包含 zcode-dcp 的插件选项） > 默认 ----------
function loadConfig() {
  const cfg = { ...DEFAULTS };
  try {
    const configPath = path.join(HOME, ".zcode", "cli", "config.json");
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const options = (raw.plugins && raw.plugins.options) || {};
      for (const [key, val] of Object.entries(options)) {
        if (!val || typeof val !== "object") continue;
        if (!key.toLowerCase().includes("zcode-dcp")) continue;
        if (Number.isFinite(+val.context_window_tokens) && +val.context_window_tokens > 0)
          cfg.context_window_tokens = +val.context_window_tokens;
        if (Number.isFinite(+val.nudge_percent) && +val.nudge_percent > 0 && +val.nudge_percent <= 100)
          cfg.nudge_percent = +val.nudge_percent;
        if (Number.isFinite(+val.nudge_cooldown_minutes) && +val.nudge_cooldown_minutes >= 0)
          cfg.nudge_cooldown_minutes = +val.nudge_cooldown_minutes;
        if (typeof val.auto_watch === "boolean") cfg.auto_watch = val.auto_watch;
      }
    }
  } catch {}
  // 环境变量覆盖（MCP server 的 env 模板或手动设置）
  const envNum = (name) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const envWindow = envNum("DCP_CONTEXT_WINDOW_TOKENS");
  if (envWindow) cfg.context_window_tokens = envWindow;
  const envPct = envNum("DCP_NUDGE_PERCENT");
  if (envPct && envPct <= 100) cfg.nudge_percent = envPct;
  const envCooldown = envNum("DCP_NUDGE_COOLDOWN_MINUTES");
  if (envCooldown !== null && envCooldown >= 0) cfg.nudge_cooldown_minutes = envCooldown;
  if (process.env.DCP_AUTO_WATCH === "false") cfg.auto_watch = false;
  if (process.env.DCP_AUTO_WATCH === "true") cfg.auto_watch = true;
  return cfg;
}

// ---------- 从模型 IO 日志读取最新 usage ----------
function findRolloutFile(sessionId) {
  if (!fs.existsSync(ROLLOUT_DIR)) return null;
  const cands = [];
  if (sessionId) {
    const bare = String(sessionId).replace(/^sess_/, "");
    cands.push(path.join(ROLLOUT_DIR, `model-io-sess_sess_${bare}.jsonl`));
    cands.push(path.join(ROLLOUT_DIR, `model-io-sess_${bare}.jsonl`));
    cands.push(path.join(ROLLOUT_DIR, `model-io-sess_sess_${sessionId}.jsonl`));
    cands.push(path.join(ROLLOUT_DIR, `model-io-sess_${sessionId}.jsonl`));
  }
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  // 兜底：取最近修改的会话日志
  try {
    let best = null;
    let bestM = -1;
    for (const f of fs.readdirSync(ROLLOUT_DIR)) {
      if (!/^model-io-sess_.*\.jsonl$/.test(f)) continue;
      const full = path.join(ROLLOUT_DIR, f);
      const m = fs.statSync(full).mtimeMs;
      if (m > bestM) {
        bestM = m;
        best = full;
      }
    }
    return best;
  } catch {
    return null;
  }
}

function readLatestUsage(sessionId) {
  const file = findRolloutFile(sessionId);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    const tailLen = Math.min(stat.size, 512 * 1024);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(tailLen);
    fs.readSync(fd, buf, 0, tailLen, stat.size - tailLen);
    fs.closeSync(fd);
    const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        const u = rec.usage || (rec.response && rec.response.usage) || null;
        const used = u ? (u.inputTokens ?? u.input_tokens ?? u.totalTokens ?? u.total_tokens) : null;
        if (Number.isFinite(used) && used > 0) {
          return { usedTokens: used, totalTokens: u.totalTokens ?? u.total_tokens ?? null };
        }
      } catch {}
    }
  } catch {}
  return null;
}

// ---------- 状态读写 ----------
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}
function writeJson(file, obj) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf-8");
  } catch {}
}

function writeUsage(sessionId, eventName, used, total, cfg) {
  const pct = Math.min(100, (used / cfg.context_window_tokens) * 100);
  writeJson(USAGE_FILE, {
    usedTokens: used,
    totalTokens: total,
    contextWindowTokens: cfg.context_window_tokens,
    usedPercent: Math.round(pct * 10) / 10,
    thresholdPercent: cfg.nudge_percent,
    sessionId: sessionId || null,
    event: eventName,
    updatedAt: new Date().toISOString(),
  });
  return pct;
}

// ---------- 提醒 ----------
function shouldNudge(pct, cfg) {
  if (pct < cfg.nudge_percent) return false;
  const prev = readJson(NUDGE_FILE);
  if (!prev) return true;
  const ageMin = (Date.now() - new Date(prev.lastNudgeAt).getTime()) / 60000;
  if (!Number.isFinite(ageMin)) return true;
  return ageMin >= cfg.nudge_cooldown_minutes;
}

function markNudged(pct) {
  writeJson(NUDGE_FILE, { lastNudgeAt: new Date().toISOString(), lastNudgePct: Math.round(pct * 10) / 10 });
}

function nudgeText(used, window, pct, cfg) {
  const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return [
    `[dcp 自动上下文监控] 上下文占用已达 ${pct}%（${fmt(used)} / ${fmt(window)} tokens），超过 ${cfg.nudge_percent}% 阈值。请立即执行上下文瘦身，不要再等：`,
    "1. 调用 compress 工具，把以下内容归档为简短摘要：已完成的搜索/探索过程、已解决的报错与调试、重复的工具调用、不再需要引用的大段文件读取结果。",
    "2. 必须保留：当前任务目标、关键决策、未完成的步骤、重要文件路径与行号。",
    "3. 压缩完成后提醒用户：如需立即释放上下文（让占用条下降），可执行 /compact —— 插件归档不减少已占用 token，真正改写历史的是 ZCode 内置压缩（占用约 83% 时内核也会自动触发）。",
  ].join("\n");
}

function emitAdditionalContext(text) {
  const json = JSON.stringify({ additionalContext: text });
  process.stdout.write(json + "\n");
}

function sessionStartText() {
  return [
    "<dcp-system>",
    "你是 ZCode DCP (Dynamic Context Pruning) 系统的一部分。可用 MCP 工具：",
    "",
    "# compress(topic, summary, tags?, type?)",
    "当对话变长时，主动把不再需要的内容（旧搜索/探索结果、已完成调试、重复调用、已解决错误）归档为摘要。注意：归档不减少当前 token，真正释放发生在 ZCode 内置 compact。",
    "",
    "# decompress(blockId) / context_stats() / context_usage() / sweep(action)",
    "回顾归档块；查看压缩统计；查看真实上下文占用（tokens 与百分比）；获取去重/错误清理建议。",
    "",
    "## 压缩原则",
    "1. 主动压缩：判断内容不再需要时就归档，不要等上下文满",
    "2. 保留关键信息：摘要必须包含后续可能需要的信息",
    "3. topic 准确描述范围；type 使用正确分类",
    "</dcp-system>",
  ].join("\n");
}

// ---------- 主流程 ----------
function main(input, mode) {
  const eventName = input.hook_event_name || "";

  // 模式判定：命令行参数优先；ZCode 实测可能丢弃 argv，故按事件名兜底推断
  if (!mode || mode === "stop" || !/^(session-start|prompt|stop)$/.test(mode)) {
    const byEvent = { SessionStart: "session-start", UserPromptSubmit: "prompt", Stop: "stop" };
    mode = byEvent[eventName] || mode || "stop";
  }
  if (mode === "session-start") {
    emitAdditionalContext(sessionStartText());
    return;
  }

  const cfg = loadConfig();
  if (!cfg.auto_watch) return;

  const sessionId = input.session_id || process.env.ZCODE_SESSION_ID || "";
  const usage = readLatestUsage(sessionId);
  if (!usage) return;

  const pct = writeUsage(sessionId, eventName, usage.usedTokens, usage.totalTokens, cfg);

  if (mode === "prompt" && shouldNudge(pct, cfg)) {
    markNudged(pct);
    emitAdditionalContext(nudgeText(usage.usedTokens, cfg.context_window_tokens, Math.round(pct * 10) / 10, cfg));
  }
  // stop 模式：只计量，不输出
}

// ---------- 入口：读 stdin JSON，任何异常静默退出 ----------
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    main(input, process.argv[2] || "stop");
  } catch {}
  process.exit(0);
});
// stdin 异常（无管道输入等）也要退出
process.stdin.on("error", () => process.exit(0));
setTimeout(() => process.exit(0), 8000).unref();
