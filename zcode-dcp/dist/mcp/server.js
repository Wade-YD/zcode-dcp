#!/usr/bin/env node
/**
 * ZCode DCP v0.3.0 MCP Server (dependency-free)
 *
 * 工具:
 *  compress        归档不再需要的对话内容为摘要（描述内嵌承重提示词，改写自 acp-kernel MIT）
 *  decompress      查看已归档块
 *  search_context  按关键词检索归档块（中英文，多词交集）
 *  context_stats   归档统计 + 真实上下文占用（hook 写入的 usage.json）
 *  context_usage   当前真实上下文占用
 *  sweep           去重/错误清理建议
 *
 * 协议: MCP stdio（按行分隔的 JSON-RPC 2.0），无第三方依赖。
 * 持久化: 归档块存 ~/.zcode/dcp/blocks.json（启动加载、compress 后写盘、写失败静默降级为内存）。
 * 提示词出处: 承重规则 adapted from acp-kernel (MIT, @ranxianglei)。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const SERVER_INFO = { name: "zcode-dcp", version: "0.3.0" };
const STATE_DIR = path.join(os.homedir(), ".zcode", "dcp");
const USAGE_FILE = path.join(STATE_DIR, "usage.json");
const BLOCKS_FILE = path.join(STATE_DIR, "blocks.json");

// ---------- 状态（启动时从 blocks.json 加载） ----------
const state = {
  blocks: [],
  nextBlockId: 1,
  stats: { totalCompressions: 0, totalDecompressions: 0, lastCompressionAt: null },
};

function loadBlocks() {
  try {
    if (!fs.existsSync(BLOCKS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(BLOCKS_FILE, "utf-8"));
    if (Array.isArray(raw.blocks)) {
      state.blocks = raw.blocks.filter((b) => b && b.blockId);
      state.nextBlockId =
        Number.isFinite(raw.nextBlockId) && raw.nextBlockId > 0
          ? raw.nextBlockId
          : state.blocks.reduce((m, b) => Math.max(m, parseInt(String(b.blockId).slice(1), 10) || 0), 0) + 1;
    }
  } catch {}
}

function saveBlocks() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      BLOCKS_FILE,
      JSON.stringify({ blocks: state.blocks, nextBlockId: state.nextBlockId, savedAt: new Date().toISOString() }, null, 2),
      "utf-8"
    );
  } catch {} // 写失败静默：保留内存可用（spec: 无害降级）
}

function formatBlockId(n) {
  return "b" + String(n).padStart(3, "0");
}
function formatLocalTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function textResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

// ---------- 真实占用（hook 写入的 usage.json） ----------
function readUsage() {
  try {
    if (!fs.existsSync(USAGE_FILE)) return null;
    const u = JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8"));
    if (typeof u.usedTokens !== "number") return null;
    return u;
  } catch {
    return null;
  }
}

function usagePayload() {
  const u = readUsage();
  if (!u) {
    return {
      available: false,
      message:
        "尚无计量数据。自动计量由插件 hook 在每轮（UserPromptSubmit/Stop）写入；若刚安装，发一轮消息后即可看到数据。",
    };
  }
  const ageMin = Math.round((Date.now() - new Date(u.updatedAt).getTime()) / 60000);
  return {
    available: true,
    usedTokens: u.usedTokens,
    contextWindowTokens: u.contextWindowTokens,
    usedPercent: u.usedPercent,
    nudgeThresholdPercent: u.thresholdPercent,
    tier2Percent: u.tier2Percent,
    tier3Percent: u.tier3Percent,
    totalTokens: u.totalTokens ?? undefined,
    sessionId: u.sessionId,
    updatedAt: u.updatedAt,
    ageMinutes: Number.isFinite(ageMin) ? ageMin : undefined,
    baselineNote:
      "占用百分比相对插件配置的上下文窗口基准（contextWindowTokens，默认 1,000,000）；请按所用模型实际窗口在插件设置中调整。",
    note: "usedTokens 来自 ZCode 模型 IO 日志的 usage.inputTokens（含缓存读取），是下一轮请求的真实输入规模。",
  };
}

// ---------- 工具 ----------
const COMPRESS_DESCRIPTION = [
  "归档不再需要的对话内容为摘要。压缩优先级：子代理审查结果 → 冗长命令输出(build/test/diff) → 走不通的探索 → 重复工具调用 → 已完成中间步骤 → 已解决讨论 → 已用完的大文件内容。按需压缩、不按百分比。",
  "",
  "摘要将成为该范围的唯一记录，必须自包含：标注 TASK AS OF THIS BLOCK（历史记录，非现行指令）；未完成的目标逐条写入 'Open objectives: <目标>'；禁止伪造用户原话——引用须注明出处阶段/主题，记不清就转述；保持源会话主语言。",
  "",
  "KEEP VERBATIM（逐字保留，禁止改写缩写）：完整文件路径+行号（带目录前缀，如 lib/hooks.ts:347，禁止缩写裸文件名）；函数/类签名与承载结论的关键代码行；报错原文与堆栈（留字面量供日后检索）；数值+机制（'1.76× PPL 差距，因 KV store 静态'，而非'X 更差'）；决策及其 because；发现的约束；精确值（版本/配置键/阈值/魔法数字）。",
  "",
  "注意：归档不减少当前上下文 token；真正释放发生在 ZCode 内置 compact（或用户 /compact）。",
].join("\n");

const tools = [
  {
    name: "compress",
    description: COMPRESS_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "压缩范围的描述，如 '之前的文件搜索操作'" },
        summary: { type: "string", description: "压缩摘要，按 KEEP VERBATIM 规则保留承重信息以便后续检索" },
        tags: { type: "array", items: { type: "string" }, description: "可选标签，如 ['api','debug']" },
        type: {
          type: "string",
          enum: ["general", "tool_result", "error", "duplicate"],
          description: "压缩类型：general=通用, tool_result=工具结果, error=错误信息, duplicate=重复内容",
        },
      },
      required: ["topic", "summary"],
    },
    handler(args) {
      const blockId = formatBlockId(state.nextBlockId);
      const block = {
        blockId,
        topic: String(args.topic || "未命名"),
        summary: String(args.summary || ""),
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
        type: args.type || "general",
        createdAt: new Date().toISOString(),
        active: true,
      };
      state.blocks.push(block);
      state.nextBlockId += 1;
      state.stats.totalCompressions += 1;
      state.stats.lastCompressionAt = block.createdAt;
      saveBlocks();
      return {
        blockId,
        topic: block.topic,
        message: `已归档: ${block.topic} (块 ID: ${blockId})。已持久化，跨会话可用 search_context 检索、decompress 取回。归档不减少当前 token；要立即释放上下文请建议用户执行 /compact。`,
      };
    },
  },
  {
    name: "decompress",
    description: "查看已归档压缩块的完整内容。",
    inputSchema: {
      type: "object",
      properties: { blockId: { type: "string", description: "要查看的压缩块 ID，如 b001" } },
      required: ["blockId"],
    },
    handler(args) {
      const block = state.blocks.find((b) => b.blockId === args.blockId);
      if (!block) {
        return {
          error: `未找到块 ${args.blockId}`,
          availableBlocks: state.blocks.filter((b) => b.active).map((b) => ({ blockId: b.blockId, topic: b.topic })),
        };
      }
      state.stats.totalDecompressions += 1;
      return {
        blockId: block.blockId,
        topic: block.topic,
        summary: block.summary,
        tags: block.tags,
        type: block.type,
        createdAt: formatLocalTime(block.createdAt),
        message: `已解压块 ${block.blockId}: ${block.topic}`,
      };
    },
  },
  {
    name: "search_context",
    description:
      "按关键词检索已归档的压缩块（匹配 topic/tags/summary，大小写不敏感，多关键词取交集，中英文均可），返回块 ID、主题与命中片段；配合 decompress 取回完整摘要。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词，多个词用空格分隔（取交集）" },
        limit: { type: "number", description: "返回上限，默认 5" },
      },
      required: ["query"],
    },
    handler(args) {
      const query = String(args.query || "").trim();
      if (!query) {
        return { query, results: [], message: "查询词为空，无命中。" };
      }
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const limit = Math.max(1, Math.min(50, Number.isFinite(+args.limit) ? +args.limit : 5));
      const scored = [];
      for (const b of state.blocks) {
        if (!b.active) continue;
        const topic = String(b.topic || "");
        const tags = Array.isArray(b.tags) ? b.tags.join(" ") : "";
        const summary = String(b.summary || "");
        let score = 0;
        let allMatch = true;
        for (const term of terms) {
          const c = (topic.toLowerCase().split(term).length - 1) + (tags.toLowerCase().split(term).length - 1) + (summary.toLowerCase().split(term).length - 1);
          if (c === 0) {
            allMatch = false;
            break;
          }
          score += c;
        }
        if (allMatch && score > 0) {
          const hay = summary || topic;
          const pos = hay.toLowerCase().indexOf(terms[0]);
          const start = Math.max(0, pos - 60);
          const snippet = (start > 0 ? "…" : "") + hay.slice(start, start + 140) + (start + 140 < hay.length ? "…" : "");
          scored.push({ blockId: b.blockId, topic, type: b.type, createdAt: formatLocalTime(b.createdAt), score, snippet });
        }
      }
      scored.sort((a, b2) => b2.score - a.score || String(b2.createdAt).localeCompare(String(a.createdAt)));
      const results = scored.slice(0, limit).map(({ score, ...r }) => r);
      return {
        query,
        total: scored.length,
        results,
        message:
          scored.length === 0
            ? `无命中：没有同时包含全部关键词（${query}）的归档块。`
            : `命中 ${scored.length} 块${scored.length > results.length ? `（显示前 ${results.length} 条）` : ""}，用 decompress 取回完整摘要。`,
      };
    },
  },
  {
    name: "context_stats",
    description: "查看压缩统计（块数量/主题/历史）与当前真实上下文占用。",
    inputSchema: { type: "object", properties: {} },
    handler() {
      const active = state.blocks.filter((b) => b.active);
      return {
        sessionId: "in-session",
        totalBlocks: active.length,
        totalCompressions: state.stats.totalCompressions,
        totalDecompressions: state.stats.totalDecompressions,
        lastCompressionAt: state.stats.lastCompressionAt ? formatLocalTime(state.stats.lastCompressionAt) : null,
        realUsage: usagePayload(),
        compressedTopics: active.map((b) => ({
          blockId: b.blockId,
          topic: b.topic,
          type: b.type,
          tags: b.tags,
          createdAt: formatLocalTime(b.createdAt),
        })),
        message: `当前有 ${active.length} 个压缩块`,
      };
    },
  },
  {
    name: "context_usage",
    description: "查看当前真实上下文占用（tokens 与百分比），来自每轮自动计量。",
    inputSchema: { type: "object", properties: {} },
    handler() {
      return usagePayload();
    },
  },
  {
    name: "sweep",
    description: "扫描对话历史，识别可去重的工具调用和可清理的错误信息。返回建议列表。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["deduplicate", "purge_errors", "all"],
          description: "清理类型：deduplicate=去重, purge_errors=清理错误, all=全部",
        },
      },
      required: ["action"],
    },
    handler(args) {
      const cfgAutoSweep = String(process.env.DCP_AUTO_SWEEP || "true") !== "false";
      const suggestions = [];
      if (cfgAutoSweep) {
        suggestions.push("【auto_sweep】自动清理已开启：每次压缩前建议先执行去重与错误清理扫描。");
      }
      if (args.action === "deduplicate" || args.action === "all") {
        suggestions.push(
          "【去重建议】检查对话中是否有相同工具+相同参数的重复调用。如有，只保留最新一次，将之前的调用及其结果用 compress 工具归档。"
        );
      }
      if (args.action === "purge_errors" || args.action === "all") {
        suggestions.push(
          "【错误清理建议】检查对话中是否有返回错误的工具调用。如错误已解决或不再相关，可将错误上下文用 compress 归档，只保留错误类型和解决方案。"
        );
      }
      return {
        action: args.action,
        realUsage: usagePayload(),
        suggestions,
        message: `扫描完成。以下是 ${
          args.action === "all" ? "去重和错误清理" : args.action === "deduplicate" ? "去重" : "错误清理"
        } 的建议：`,
      };
    },
  },
];

// ---------- JSON-RPC 分发 ----------
function reply(id, result, error) {
  const msg = { jsonrpc: "2.0", id };
  if (error) msg.error = error;
  else msg.result = result;
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const isNotification = msg.id === undefined || msg.id === null;
  const method = msg.method || "";

  if (isNotification) {
    return;
  }

  switch (method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
      break;
    case "ping":
      reply(msg.id, {});
      break;
    case "tools/list":
      reply(msg.id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      break;
    case "tools/call": {
      const params = msg.params || {};
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) {
        reply(msg.id, null, { code: -32602, message: `Unknown tool: ${params.name}` });
        break;
      }
      try {
        const out = tool.handler(params.arguments || {});
        reply(msg.id, textResult(out));
      } catch (err) {
        reply(msg.id, { content: [{ type: "text", text: "工具执行失败: " + (err && err.message) }], isError: true });
      }
      break;
    }
    default:
      reply(msg.id, null, { code: -32601, message: "Method not found: " + method });
  }
}

// ---------- 启动 ----------
loadBlocks();
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {}
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
