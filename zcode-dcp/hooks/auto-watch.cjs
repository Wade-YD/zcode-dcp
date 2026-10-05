#!/usr/bin/env node
/**
 * ZCode DCP v0.3.0 自动上下文计量与分级提醒 hook
 *
 * 模式（argv[2]，ZCode 可能丢 argv，故按 stdin 的 hook_event_name 兜底推断）:
 *   session-start  会话启动/清空/内核压缩后：注入工具说明 + 当前占用 + 归档索引
 *   prompt         UserPromptSubmit：计量 + 分级提醒（additionalContext）
 *   stop           Stop：仅计量，不输出
 *
 * 数据源: ~/.zcode/cli/rollout/model-io-sess_<sessionId>.jsonl 最后一行的 usage.inputTokens
 * 状态:   ~/.zcode/dcp/usage.json、nudge.json（分级提醒状态）；归档索引读 blocks.json（由 MCP server 写）
 *
 * 任何错误都静默退出（exit 0），绝不阻塞对话。
 * 提醒文本中的承重规则改写自 acp-kernel (MIT, @ranxianglei)，见 README 致谢。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".zcode", "dcp");
const USAGE_FILE = path.join(STATE_DIR, "usage.json");
const NUDGE_FILE = path.join(STATE_DIR, "nudge.json");
const BLOCKS_FILE = path.join(STATE_DIR, "blocks.json");
const ROLLOUT_DIR = path.join(HOME, ".zcode", "cli", "rollout");

const DEFAULTS = {
  context_window_tokens: 1000000,
  nudge_percent: 50,
  tier2_percent: 70,
  tier3_percent: 80,
  nudge_growth_tokens: 30000,
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
        applyConfigObject(cfg, val);
      }
    }
  } catch {}
  const num = (name) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  if (num("DCP_CONTEXT_WINDOW_TOKENS")) cfg.context_window_tokens = num("DCP_CONTEXT_WINDOW_TOKENS");
  if (num("DCP_NUDGE_PERCENT") && num("DCP_NUDGE_PERCENT") <= 100) cfg.nudge_percent = num("DCP_NUDGE_PERCENT");
  if (num("DCP_TIER2_PERCENT") && num("DCP_TIER2_PERCENT") <= 100) cfg.tier2_percent = num("DCP_TIER2_PERCENT");
  if (num("DCP_TIER3_PERCENT") && num("DCP_TIER3_PERCENT") <= 100) cfg.tier3_percent = num("DCP_TIER3_PERCENT");
  if (num("DCP_NUDGE_GROWTH_TOKENS")) cfg.nudge_growth_tokens = num("DCP_NUDGE_GROWTH_TOKENS");
  // 冷却允许 0 分钟（立即放行），需用 >=0 解析器
  const nonNeg = (name) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : null;
  };
  if (nonNeg("DCP_NUDGE_COOLDOWN_MINUTES") !== null) cfg.nudge_cooldown_minutes = nonNeg("DCP_NUDGE_COOLDOWN_MINUTES");
  if (process.env.DCP_AUTO_WATCH === "false") cfg.auto_watch = false;
  if (process.env.DCP_AUTO_WATCH === "true") cfg.auto_watch = true;
  return cfg;
}

function applyConfigObject(cfg, val) {
  const pos = (v) => Number.isFinite(+v) && +v > 0;
  const pct = (v) => pos(v) && +v <= 100;
  if (pos(val.context_window_tokens)) cfg.context_window_tokens = +val.context_window_tokens;
  if (pct(val.nudge_percent)) cfg.nudge_percent = +val.nudge_percent;
  if (pct(val.tier2_percent)) cfg.tier2_percent = +val.tier2_percent;
  if (pct(val.tier3_percent)) cfg.tier3_percent = +val.tier3_percent;
  if (pos(val.nudge_growth_tokens)) cfg.nudge_growth_tokens = +val.nudge_growth_tokens;
  if (Number.isFinite(+val.nudge_cooldown_minutes) && +val.nudge_cooldown_minutes >= 0)
    cfg.nudge_cooldown_minutes = +val.nudge_cooldown_minutes;
  if (typeof val.auto_watch === "boolean") cfg.auto_watch = val.auto_watch;
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
    tier2Percent: cfg.tier2_percent,
    tier3Percent: cfg.tier3_percent,
    sessionId: sessionId || null,
    event: eventName,
    updatedAt: new Date().toISOString(),
  });
  return pct;
}

// ---------- 分级提醒（D3）----------
function decideNudge(tier, used, prev, cfg) {
  if (!prev || typeof prev.lastTier !== "number") return { nudge: true }; // 首次或旧格式重置
  if (tier > prev.lastTier) return { nudge: true }; // 升级跳过下级冷却
  if (tier < prev.lastTier) return { nudge: false, updateState: true }; // 水位回落（如内核压缩后），仅更新状态
  // 同级：时间冷却 与 增长步进 双条件
  const ageMs = Date.now() - new Date(prev.lastNudgeAt).getTime();
  const timeOk = Number.isFinite(ageMs) ? ageMs >= cfg.nudge_cooldown_minutes * 60000 : true;
  const lastTokens = Number(prev.lastNudgeTokens);
  const growthOk = !Number.isFinite(lastTokens) || used - lastTokens >= cfg.nudge_growth_tokens;
  return { nudge: timeOk && growthOk };
}

function markNudged(tier, used) {
  writeJson(NUDGE_FILE, {
    lastNudgeAt: new Date().toISOString(),
    lastNudgeTokens: Math.round(used),
    lastTier: tier,
  });
}

function updateNudgeTierOnly(prev, tier, used) {
  writeJson(NUDGE_FILE, {
    lastNudgeAt: prev && prev.lastNudgeAt ? prev.lastNudgeAt : new Date().toISOString(),
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
    `${head}，达到 tier3（${cfg.tier3_percent}%），已逼近 ZCode 内核自动压缩线（约窗口 − 34K）。`,
    ...common,
    "本层级要求：1) 先把当前任务状态写成交接摘要（目标/已完成/下一步/关键路径与决策）；2) 明确提醒用户执行 /compact —— 主动压缩可控，内核被动压缩（约 83% 时触发）不可控。",
  ].join("\n");
}

// ---------- session-start 文本 v2：工具说明 + 当前占用 + 归档索引 ----------
function sessionStartText() {
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

  const usage = readJson(USAGE_FILE);
  if (usage && Number.isFinite(usage.usedTokens) && Number.isFinite(usage.contextWindowTokens)) {
    const pct = Math.min(100, (usage.usedTokens / usage.contextWindowTokens) * 100).toFixed(1);
    parts.push(
      "",
      `[dcp 状态] 当前上下文占用 ${pct}%（${fmtNum(usage.usedTokens)} / ${fmtNum(usage.contextWindowTokens)} tokens，更新于 ${usage.updatedAt || "未知时间"}）`
    );
  }

  const store = readJson(BLOCKS_FILE);
  const blocks = Array.isArray(store && store.blocks) ? store.blocks.filter((b) => b && b.blockId) : [];
  if (blocks.length > 0) {
    const lines = blocks.slice(0, 20).map((b) => `${b.blockId}: ${b.topic}`);
    const more = blocks.length > 20 ? `\n…等共 ${blocks.length} 块` : "";
    parts.push("", `[dcp 归档索引]（${blocks.length} 块）`, ...lines, more, "细节用 search_context 检索、decompress 取回。");
  } else {
    parts.push("", "[dcp 归档索引] 暂无归档块。");
  }
  return parts.join("\n");
}

function emitAdditionalContext(text) {
  const json = JSON.stringify({ additionalContext: text });
  process.stdout.write(json + "\n");
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

  if (mode !== "prompt") return; // stop：只计量

  const tier = pct >= cfg.tier3_percent ? 3 : pct >= cfg.tier2_percent ? 2 : pct >= cfg.nudge_percent ? 1 : 0;
  if (tier === 0) return;

  const prev = readJson(NUDGE_FILE);
  const decision = decideNudge(tier, usage.usedTokens, prev, cfg);
  if (decision.nudge) {
    markNudged(tier, usage.usedTokens);
    emitAdditionalContext(buildNudgeText(tier, usage.usedTokens, cfg.context_window_tokens, Math.round(pct * 10) / 10, cfg));
  } else if (decision.updateState) {
    updateNudgeTierOnly(prev, tier, usage.usedTokens);
  }
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
process.stdin.on("error", () => process.exit(0));
setTimeout(() => process.exit(0), 8000).unref();
