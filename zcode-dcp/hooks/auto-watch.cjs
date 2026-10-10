#!/usr/bin/env node
/**
 * ZCode DCP v0.4.0 自动上下文计量 / 分级提醒 / 压缩检测 / absorb-lite hook
 *
 * 模式（argv[2]，ZCode 可能丢 argv，故按 stdin 的 hook_event_name 兜底推断）:
 *   session-start  会话启动/清空/内核压缩后：工具说明 + 当前占用 + 归档索引（按项目命名空间）
 *   prompt         UserPromptSubmit：计量 + 骤降压缩检测 + 分级提醒
 *   tool           PostToolUse：超大工具结果 → absorb 蒸馏提示（实验性，改写自 acp-kernel absorb.ts MIT）
 *   stop           Stop：仅计量
 *
 * 状态文件（~/.zcode/dcp/）:
 *   usage.json（全局最近活跃会话，供 server 显示）、nudge-<sid>.json（会话隔离提醒状态）、
 *   absorb-<sid>.json（absorb 冷却）、compact-stats.json（压缩事件）、window-calibration.json（窗口校准）、
 *   blocks[-<projhash>].json（归档，project scope 时按项目哈希分文件）
 *
 * 任何错误都静默退出（exit 0），绝不阻塞对话。承重提示词改写自 acp-kernel (MIT, @ranxianglei)。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".zcode", "dcp");
const USAGE_FILE = path.join(STATE_DIR, "usage.json");
const NUDGE_FILE = path.join(STATE_DIR, "nudge.json"); // v0.3 旧文件（仅迁移兼容，不再写）
const ROLLOUT_DIR = path.join(HOME, ".zcode", "cli", "rollout");
const COMPACT_STATS_FILE = path.join(STATE_DIR, "compact-stats.json");
const CALIBRATION_FILE = path.join(STATE_DIR, "window-calibration.json");

// 内核压缩触发点 ≈ 窗口 − 34K（逆向 zcode.cjs 常量：窗口−21K 输出预留−13K buffer）
const KERNEL_COMPACT_RESERVE = 34000;

const DEFAULTS = {
  context_window_tokens: 1000000,
  nudge_percent: 50,
  tier2_percent: 70,
  tier3_percent: 80,
  nudge_growth_tokens: 30000,
  nudge_cooldown_minutes: 10,
  auto_watch: true,
  archive_scope: "project",
  max_blocks: 200,
  absorb_min_tool_tokens: 8000,
};

// ---------- 配置: env(仅手动设置) > config.json > 默认 ----------
// 注意：plugin.json 的 env 模板只对 mcpServers 生效，hook 进程拿不到 user_config 的 env——
// config.json（plugins.options 里含 "zcode-dcp" 的键）是 userConfig 到达 hook 的唯一正式通道。
function loadConfig() {
  const cfg = { ...DEFAULTS, _windowExplicit: false };
  try {
    const configPath = path.join(HOME, ".zcode", "cli", "config.json");
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const options = (raw.plugins && raw.plugins.options) || {};
      for (const [key, val] of Object.entries(options)) {
        if (!val || typeof val !== "object") continue;
        if (!key.toLowerCase().includes("zcode-dcp")) continue;
        applyConfigObject(cfg, val);
      }
    }
  } catch {}
  const num = (name) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  if (num("DCP_CONTEXT_WINDOW_TOKENS")) {
    cfg.context_window_tokens = num("DCP_CONTEXT_WINDOW_TOKENS");
    cfg._windowExplicit = true;
  }
  if (num("DCP_NUDGE_PERCENT") && num("DCP_NUDGE_PERCENT") <= 100) cfg.nudge_percent = num("DCP_NUDGE_PERCENT");
  if (num("DCP_TIER2_PERCENT") && num("DCP_TIER2_PERCENT") <= 100) cfg.tier2_percent = num("DCP_TIER2_PERCENT");
  if (num("DCP_TIER3_PERCENT") && num("DCP_TIER3_PERCENT") <= 100) cfg.tier3_percent = num("DCP_TIER3_PERCENT");
  if (num("DCP_NUDGE_GROWTH_TOKENS")) cfg.nudge_growth_tokens = num("DCP_NUDGE_GROWTH_TOKENS");
  if (process.env.DCP_AUTO_WATCH === "false") cfg.auto_watch = false;
  if (process.env.DCP_AUTO_WATCH === "true") cfg.auto_watch = true;
  if (process.env.DCP_ARCHIVE_SCOPE === "global" || process.env.DCP_ARCHIVE_SCOPE === "project")
    cfg.archive_scope = process.env.DCP_ARCHIVE_SCOPE;
  if (num("DCP_MAX_BLOCKS")) cfg.max_blocks = num("DCP_MAX_BLOCKS");
  // 冷却/absorb 阈值允许 0（关闭或立即放行）
  const nonNeg = (name) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : null;
  };
  if (nonNeg("DCP_NUDGE_COOLDOWN_MINUTES") !== null) cfg.nudge_cooldown_minutes = nonNeg("DCP_NUDGE_COOLDOWN_MINUTES");
  if (nonNeg("DCP_ABSORB_MIN_TOOL_TOKENS") !== null) cfg.absorb_min_tool_tokens = nonNeg("DCP_ABSORB_MIN_TOOL_TOKENS");
  return cfg;
}

function applyConfigObject(cfg, val) {
  const pos = (v) => Number.isFinite(+v) && +v > 0;
  const pct = (v) => pos(v) && +v <= 100;
  if (pos(val.context_window_tokens)) {
    cfg.context_window_tokens = +val.context_window_tokens;
    cfg._windowExplicit = true;
  }
  if (pct(val.nudge_percent)) cfg.nudge_percent = +val.nudge_percent;
  if (pct(val.tier2_percent)) cfg.tier2_percent = +val.tier2_percent;
  if (pct(val.tier3_percent)) cfg.tier3_percent = +val.tier3_percent;
  if (pos(val.nudge_growth_tokens)) cfg.nudge_growth_tokens = +val.nudge_growth_tokens;
  if (Number.isFinite(+val.nudge_cooldown_minutes) && +val.nudge_cooldown_minutes >= 0)
    cfg.nudge_cooldown_minutes = +val.nudge_cooldown_minutes;
  if (typeof val.auto_watch === "boolean") cfg.auto_watch = val.auto_watch;
  if (val.archive_scope === "project" || val.archive_scope === "global") cfg.archive_scope = val.archive_scope;
  if (pos(val.max_blocks)) cfg.max_blocks = +val.max_blocks;
  if (Number.isFinite(+val.absorb_min_tool_tokens) && +val.absorb_min_tool_tokens >= 0)
    cfg.absorb_min_tool_tokens = +val.absorb_min_tool_tokens;
}

// ---------- 窗口校准 ----------
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
    const data = JSON.stringify(obj, null, 2);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, data, "utf-8");
    try {
      fs.renameSync(tmp, file); // 原子替换，防写中程崩溃损坏状态文件
    } catch {
      fs.writeFileSync(file, data, "utf-8");
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  } catch {}
}

function recordCalibration(preTokens) {
  const observed = preTokens + KERNEL_COMPACT_RESERVE;
  const cal = readJson(CALIBRATION_FILE) || { observations: [] };
  if (!Array.isArray(cal.observations)) cal.observations = [];
  cal.observations.push({ observedWindow: observed, at: new Date().toISOString() });
  cal.observations = cal.observations.slice(-5);
  writeJson(CALIBRATION_FILE, cal);
}

function calibratedWindow() {
  const cal = readJson(CALIBRATION_FILE);
  const obs = Array.isArray(cal && cal.observations) ? cal.observations.map((o) => +o.observedWindow).filter(Number.isFinite) : [];
  if (obs.length < 2) return null;
  obs.sort((a, b) => a - b);
  const mid = Math.floor(obs.length / 2);
  return obs.length % 2 ? obs[mid] : Math.round((obs[mid - 1] + obs[mid]) / 2);
}

function effectiveWindow(cfg) {
  if (cfg._windowExplicit) return { window: cfg.context_window_tokens, source: "config" };
  const cal = calibratedWindow();
  if (cal) return { window: cal, source: "calibrated" };
  return { window: cfg.context_window_tokens, source: "default" };
}

// ---------- 会话与命名空间 ----------
function sanitizeSid(sid) {
  return String(sid || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "unknown";
}
function normalizeProjectDir(dir) {
  if (!dir) return "";
  let d = String(dir);
  try { d = path.resolve(d); } catch {}
  if (d.endsWith(path.sep) && d.length > 3) d = d.slice(0, -path.sep.length);
  // 大小写/尾斜杠归一，防同项目被劈成两个命名空间
  return process.platform === "win32" ? d.toLowerCase() : d;
}
function projectHash(projectDir) {
  const d = normalizeProjectDir(projectDir);
  if (!d) return "";
  return crypto.createHash("sha256").update(d).digest("hex").slice(0, 12);
}
function blocksFileFor(projectDir, scope) {
  if (scope !== "project" || !projectDir) return path.join(STATE_DIR, "blocks.json");
  const f = path.join(STATE_DIR, `blocks-${projectHash(projectDir)}.json`);
  if (!fs.existsSync(f)) {
    const legacy = readJson(path.join(STATE_DIR, "blocks.json"));
    if (legacy && Array.isArray(legacy.blocks)) writeJson(f, legacy); // 一次性种子迁移
  }
  return f;
}
function nudgeFileFor(sid) {
  return path.join(STATE_DIR, `nudge-${sanitizeSid(sid)}.json`);
}
function absorbFileFor(sid) {
  return path.join(STATE_DIR, `absorb-${sanitizeSid(sid)}.json`);
}
function recallFileFor(sid) {
  return path.join(STATE_DIR, `recall-pending-${sanitizeSid(sid)}.json`);
}

// ---------- 从模型 IO 日志读取最新 usage（严格会话匹配） ----------
function findRolloutFile(sessionId) {
  if (!fs.existsSync(ROLLOUT_DIR)) return null;
  if (sessionId) {
    const bare = String(sessionId).replace(/^sess_/, "");
    const cands = [
      path.join(ROLLOUT_DIR, `model-io-sess_sess_${bare}.jsonl`),
      path.join(ROLLOUT_DIR, `model-io-sess_${bare}.jsonl`),
      path.join(ROLLOUT_DIR, `model-io-sess_sess_${sessionId}.jsonl`),
      path.join(ROLLOUT_DIR, `model-io-sess_${sessionId}.jsonl`),
    ];
    for (const c of cands) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {}
    }
    return null; // 有 session_id 但文件缺失：不读别人的日志（并发隔离）
  }
  // 无 session_id 才兜底取最近修改
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

// ---------- 计量写盘 + 骤降压缩检测 ----------
function writeUsage(sessionId, eventName, used, total, cfg) {
  const win = effectiveWindow(cfg);
  const pct = Math.min(100, (used / win.window) * 100);
  writeJson(USAGE_FILE, {
    usedTokens: used,
    totalTokens: total,
    contextWindowTokens: win.window,
    windowSource: win.source,
    usedPercent: Math.round(pct * 10) / 10,
    thresholdPercent: cfg.nudge_percent,
    tier2Percent: cfg.tier2_percent,
    tier3Percent: cfg.tier3_percent,
    sessionId: sessionId || null,
    scopeNote: "最近活跃会话",
    event: eventName,
    updatedAt: new Date().toISOString(),
  });
  return { pct, win };
}

function detectCompact(sessionId, used, prevUsage, cfg) {
  const prevUsed = prevUsage && Number.isFinite(prevUsage.usedTokens) ? prevUsage.usedTokens : null;
  if (!prevUsed || prevUsed < 20000) return null;
  // 前值必须属于同一会话：跨会话的"骤降"只是切换了窗口，不是压缩（否则会伪造召回并污染窗口校准）
  if (!prevUsage || prevUsage.sessionId !== (sessionId || null)) return null;
  if (used >= prevUsed * 0.6) return null;
  const event = {
    at: new Date().toISOString(),
    preTokens: prevUsed,
    postTokens: used,
    saved: prevUsed - used,
    sessionId: sessionId || null,
  };
  const stats = readJson(COMPACT_STATS_FILE) || { events: [] };
  if (!Array.isArray(stats.events)) stats.events = [];
  stats.events.push(event);
  stats.events = stats.events.slice(-20);
  writeJson(COMPACT_STATS_FILE, stats);
  // 校准只采"窗口后 40% 区间"的压缩（符合内核触发点特征）；低水位压缩多为手动 /compact，会砸穿校准
  const win = effectiveWindow(cfg);
  if (prevUsed >= win.window * 0.6) recordCalibration(prevUsed);
  try {
    fs.rmSync(nudgeFileFor(sessionId), { force: true }); // 压缩后重置该会话提醒层级
  } catch {}
  return event;
}

// ---------- 分级提醒（会话隔离状态） ----------
function decideNudge(tier, used, prev, cfg) {
  if (!prev || typeof prev.lastTier !== "number") return { nudge: true };
  if (tier > prev.lastTier) return { nudge: true };
  if (tier < prev.lastTier) return { nudge: false, updateState: true };
  const ageMs = Date.now() - new Date(prev.lastNudgeAt).getTime();
  const timeOk = Number.isFinite(ageMs) ? ageMs >= cfg.nudge_cooldown_minutes * 60000 : true;
  const lastTokens = Number(prev.lastNudgeTokens);
  const growthOk = !Number.isFinite(lastTokens) || used - lastTokens >= cfg.nudge_growth_tokens;
  return { nudge: timeOk && growthOk };
}

function markNudged(nudgeFile, tier, used) {
  writeJson(nudgeFile, {
    lastNudgeAt: new Date().toISOString(),
    lastNudgeTokens: Math.round(used),
    lastTier: tier,
  });
}

const PRIORITY_LIST =
  "压缩优先级：①子代理审查结果 ②冗长命令输出(build/test/diff) ③走不通的探索 ④重复工具调用 ⑤已完成中间步骤 ⑥已解决讨论 ⑦已用完的大文件内容";
const KEEP_VERBATIM =
  "摘要必须逐字保留：完整文件路径+行号（带目录前缀如 lib/hooks.ts:347，禁止缩写裸文件名）；函数/类签名与承载结论的关键代码行；报错原文（留字面量供日后检索）；数值+机制（不要只写结论）；决策及其 because；发现的约束；精确值（版本/配置键/阈值）";
const HISTORY_RULE =
  "摘要是历史记录非现行指令：标注 TASK AS OF THIS BLOCK；未完成目标逐条写入 Open objectives: <目标>；禁止伪造用户原话，引用须注明出处阶段，记不清就转述；摘要保持源会话主语言";

function fmtNum(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function buildNudgeText(tier, used, window, pct, cfg) {
  const head = `[dcp 自动上下文监控] 上下文占用 ${pct}%（${fmtNum(used)} / ${fmtNum(window)} tokens）`;
  const common = [`优先归档：${PRIORITY_LIST}`, `原则：按需压缩、不按百分比；${KEEP_VERBATIM}；${HISTORY_RULE}`];
  if (tier === 1) {
    return [
      `${head}，达到 tier1（${cfg.nudge_percent}%）。请归档不再需要的内容：`,
      ...common,
      "调用 compress 工具执行，保留当前任务仍需引用的上下文。",
    ].join("\n");
  }
  if (tier === 2) {
    return [
      `${head}，达到 tier2（${cfg.tier2_percent}%）。请立即执行上下文瘦身：`,
      ...common,
      "本层级额外要求：停止产出冗长内容，回复改为就地小结；优先归档上述全部类别。",
    ].join("\n");
  }
  return [
    `${head}，达到 tier3（${cfg.tier3_percent}%），已逼近 ZCode 内核自动压缩线。`,
    ...common,
    "本层级要求：1) 先把当前任务状态写成交接摘要（目标/已完成/下一步/关键路径与决策）；2) 明确提醒用户执行 /compact —— 主动压缩可控，内核被动压缩不可控。",
  ].join("\n");
}

// ---------- 归档索引（按项目命名空间） ----------
function buildArchiveIndexSection(projectDir, scope) {
  const store = readJson(blocksFileFor(projectDir, scope));
  const blocks = Array.isArray(store && store.blocks) ? store.blocks.filter((b) => b && b.blockId) : [];
  if (blocks.length === 0) return "[dcp 归档索引] 暂无归档块。";
  const lines = blocks.slice(0, 20).map((b) => `${b.blockId}: ${b.topic}`);
  const more = blocks.length > 20 ? `\n…等共 ${blocks.length} 块` : "";
  return [`[dcp 归档索引]（${blocks.length} 块）`, ...lines, more, "细节用 search_context 检索、decompress 取回。"].join("\n");
}

function buildCompactRecapText(event, projectDir, scope, cfg) {
  const win = effectiveWindow(cfg);
  const parts = [
    `[dcp 压缩召回] 检测到上下文被压缩（${fmtNum(event.preTokens)} → ${fmtNum(event.postTokens)} tokens，释放 ${fmtNum(event.saved)}）。历史细节已折叠，归档索引如下：`,
    buildArchiveIndexSection(projectDir, scope),
  ];
  const usage = readJson(USAGE_FILE);
  if (usage && Number.isFinite(usage.usedTokens)) {
    parts.push(`[dcp 状态] 当前占用 ${((usage.usedTokens / win.window) * 100).toFixed(1)}%（${fmtNum(usage.usedTokens)} / ${fmtNum(win.window)} tokens）。`);
  }
  return parts.join("\n");
}

function sessionStartText(projectDir, scope) {
  const parts = [
    "<dcp-system>",
    "你是 ZCode DCP (Dynamic Context Pruning) 系统的一部分。可用 MCP 工具：",
    "",
    "# compress(topic, summary, tags?, type?)",
    "把不再需要的内容归档为摘要。注意：归档不减少当前 token，真正释放发生在 ZCode 内置 compact。",
    "",
    "# decompress(blockId) — 取回归档块全文",
    "# search_context(query, limit?) — 按关键词检索归档块",
    "# context_stats() / context_usage() — 压缩统计 / 真实上下文占用",
    "# sweep(action) — 去重/错误清理建议",
    "",
    "## 压缩原则",
    `1. 主动归档：${PRIORITY_LIST}`,
    `2. 按需压缩、不按百分比；${KEEP_VERBATIM}`,
    `3. ${HISTORY_RULE}`,
    "</dcp-system>",
  ];
  const cfg = loadConfig();
  const usage = readJson(USAGE_FILE);
  if (usage && Number.isFinite(usage.usedTokens) && Number.isFinite(usage.contextWindowTokens)) {
    const pct = Math.min(100, (usage.usedTokens / usage.contextWindowTokens) * 100).toFixed(1);
    parts.push("", `[dcp 状态] 当前上下文占用 ${pct}%（${fmtNum(usage.usedTokens)} / ${fmtNum(usage.contextWindowTokens)} tokens，更新于 ${usage.updatedAt || "未知时间"}）。`);
  }
  parts.push("", buildArchiveIndexSection(projectDir, scope));
  return parts.join("\n");
}

// ---------- absorb-lite（PostToolUse 大结果蒸馏提示） ----------
function buildAbsorbText(toolName, tokens) {
  return [
    `[dcp absorb] 工具 ${toolName} 的结果约 ${fmtNum(tokens)} tokens，信息量大且后续可能被压缩折叠。请立即调用 compress({ topic, summary }) 把它的要点蒸馏归档：结论、精确值、完整路径:行号、报错原文（逐字）。`,
    "归档后以摘要为准，不要重跑该工具；若结果无可保留内容，用摘要 \"(nothing needed)\" 归档即可。",
  ].join("\n");
}

function maybeAbsorb(input, cfg, sessionId) {
  const minTokens = cfg.absorb_min_tool_tokens;
  if (!minTokens || minTokens <= 0) return false;
  const resp = input.tool_response;
  let size = 0;
  if (typeof resp === "string") size = resp.length;
  else if (resp != null) {
    try {
      size = JSON.stringify(resp).length;
    } catch {}
  }
  // CJK 每字≈1 token、ASCII 约 4 字符/token；纯 length/4 对中文低估 4 倍导致 absorb 几乎不触发
  let cjk = 0;
  try {
    cjk = ((typeof resp === "string" ? resp : JSON.stringify(resp)).match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  } catch {}
  const tokens = Math.round(cjk + (size - cjk) / 4);
  if (tokens < minTokens) return false;
  const af = absorbFileFor(sessionId);
  const prev = readJson(af);
  if (prev && prev.lastAbsorbAt) {
    const age = Date.now() - new Date(prev.lastAbsorbAt).getTime();
    if (Number.isFinite(age) && age < 10 * 60000) return false; // 会话级 10 分钟冷却
  }
  writeJson(af, { lastAbsorbAt: new Date().toISOString(), lastTokens: tokens });
  emitAdditionalContext(buildAbsorbText(String(input.tool_name || "tool"), tokens));
  return true;
}

function emitAdditionalContext(text) {
  const json = JSON.stringify({ additionalContext: text });
  process.stdout.write(json + "\n");
}

// ---------- 主流程 ----------
function main(input, mode) {
  const eventName = input.hook_event_name || "";

  if (!mode || mode === "stop" || !/^(session-start|prompt|stop|tool)$/.test(mode)) {
    const byEvent = { SessionStart: "session-start", UserPromptSubmit: "prompt", Stop: "stop", PostToolUse: "tool" };
    mode = byEvent[eventName] || mode || "stop";
  }

  const cfg = loadConfig();
  const sessionId = input.session_id || process.env.ZCODE_SESSION_ID || "";
  const projectDir = input.cwd || process.env.ZCODE_PROJECT_DIR || "";

  if (mode === "session-start") {
    let text = sessionStartText(projectDir, cfg.archive_scope);
    const rf = recallFileFor(sessionId);
    const pending = readJson(rf);
    if (pending && pending.event) {
      try { fs.rmSync(rf, { force: true }); } catch {}
      text = buildCompactRecapText(pending.event, projectDir, cfg.archive_scope, cfg) + "\n\n" + text;
    }
    emitAdditionalContext(text);
    return;
  }

  if (mode === "tool") {
    if (cfg.auto_watch) maybeAbsorb(input, cfg, sessionId);
    return;
  }

  if (!cfg.auto_watch) return;

  const usage = readLatestUsage(sessionId);
  if (!usage) return;

  const prevUsage = readJson(USAGE_FILE); // 必须在 writeUsage 覆写前取前值
  writeUsage(sessionId, eventName, usage.usedTokens, usage.totalTokens, cfg);

  // 骤降 → 压缩检出：写召回标记；prompt 轮直接注入，stop 轮留给下一轮消费
  const compactEvent = detectCompact(sessionId, usage.usedTokens, prevUsage, cfg);
  if (compactEvent) {
    writeJson(recallFileFor(sessionId), { event: compactEvent });
    if (mode === "prompt") {
      try { fs.rmSync(recallFileFor(sessionId), { force: true }); } catch {}
      emitAdditionalContext(buildCompactRecapText(compactEvent, projectDir, cfg.archive_scope, cfg));
    }
    return;
  }

  if (mode !== "prompt") return; // stop：只计量

  // 上一轮（多为 stop）检出的压缩：本轮注入召回并清除标记，不再叠加常规提醒
  const rf = recallFileFor(sessionId);
  const pending = readJson(rf);
  if (pending && pending.event) {
    try { fs.rmSync(rf, { force: true }); } catch {}
    emitAdditionalContext(buildCompactRecapText(pending.event, projectDir, cfg.archive_scope, cfg));
    return;
  }

  const win = effectiveWindow(cfg);
  const pctOfWin = Math.min(100, (usage.usedTokens / win.window) * 100);
  const tier = pctOfWin >= cfg.tier3_percent ? 3 : pctOfWin >= cfg.tier2_percent ? 2 : pctOfWin >= cfg.nudge_percent ? 1 : 0;
  if (tier === 0) return;

  const nf = nudgeFileFor(sessionId);
  const prev = readJson(nf);
  const decision = decideNudge(tier, usage.usedTokens, prev, cfg);
  if (decision.nudge) {
    markNudged(nf, tier, usage.usedTokens);
    emitAdditionalContext(buildNudgeText(tier, usage.usedTokens, win.window, Math.round(pctOfWin * 10) / 10, cfg));
  } else if (decision.updateState) {
    writeJson(nf, {
      lastNudgeAt: prev && prev.lastNudgeAt ? prev.lastNudgeAt : new Date().toISOString(),
      lastNudgeTokens: Math.round(usage.usedTokens),
      lastTier: tier,
    });
  }
}

// ---------- 入口 ----------
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
process.stdin.on("error", () => process.exit(0));
setTimeout(() => process.exit(0), 8000).unref();
