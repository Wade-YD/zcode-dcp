#!/usr/bin/env node
/**
 * ZCode DCP v0.2.0 MCP Server (dependency-free)
 *
 * 工具:
 *  compress      归档不再需要的对话内容为摘要（注意：归档不减少当前 token，真正释放发生在 ZCode 内置 compact）
 *  decompress    查看已归档块
 *  context_stats 归档统计 + 真实上下文占用（由 hook 写入的 usage.json）
 *  sweep         去重/错误清理建议
 *  context_usage 当前真实上下文占用
 *
 * 协议: MCP stdio（按行分隔的 JSON-RPC 2.0），无第三方依赖。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const SERVER_INFO = { name: "zcode-dcp", version: "0.2.0" };
const STATE_DIR = path.join(os.homedir(), ".zcode", "dcp");
const USAGE_FILE = path.join(STATE_DIR, "usage.json");

// ---------- 状态（进程内存，会话内有效） ----------
const state = {
  blocks: [],
  nextBlockId: 1,
  stats: { totalCompressions: 0, totalDecompressions: 0, lastCompressionAt: null },
};

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
    totalTokens: u.totalTokens ?? undefined,
    sessionId: u.sessionId,
    updatedAt: u.updatedAt,
    ageMinutes: Number.isFinite(ageMin) ? ageMin : undefined,
    note: "usedTokens 来自 ZCode 模型 IO 日志的 usage.inputTokens（含缓存读取），是下一轮请求的真实输入规模。",
  };
}

// ---------- 工具实现 ----------
const tools = [
  {
    name: "compress",
    description:
      "归档不再需要的对话内容为摘要（旧的搜索/探索结果、已完成的调试过程、重复的工具调用、已解决的错误）。注意：归档本身不减少当前上下文 token，它保证信息不丢；真正释放发生在 ZCode 内置 compact（约 83% 自动触发，或用户执行 /compact）。",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "压缩范围的描述，如 '之前的文件搜索操作'" },
        summary: { type: "string", description: "压缩摘要，保留所有关键信息以便后续参考" },
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
      return {
        blockId,
        topic: block.topic,
        message: `已归档: ${block.topic} (块 ID: ${blockId})。后续可用 context_stats 查看、decompress 回顾。归档不减少当前 token；要立即释放上下文请建议用户执行 /compact。`,
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
        suggestions.push(
          "【auto_sweep】自动清理已开启：每次压缩前建议先执行去重与错误清理扫描。"
        );
      }
      if (args.action === "deduplicate" || args.action === "all") {
        suggestions.push(
          "【去重建议】检查对话中是否有相同工具+相同参数的重复调用。如有，只保留最新一次，将之前的调用及其结果用 compress 工具归档。",
          "示例：多次用相同参数调用 Read 或 Grep 时，可将旧的调用结果归档。"
        );
      }
      if (args.action === "purge_errors" || args.action === "all") {
        suggestions.push(
          "【错误清理建议】检查对话中是否有返回错误的工具调用。如错误已解决或不再相关，可将错误上下文用 compress 归档，只保留错误类型和解决方案。",
          "示例：一个 Bash 命令报错后你已找到正确方法，可将旧的错误上下文归档。"
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
    // notifications/initialized, notifications/cancelled 等：忽略
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
    } catch {
      // 无法解析的行：忽略，保持服务存活
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
