#!/usr/bin/env node
/**
 * ZCode DCP MCP Server (dependency-free)（版本见 plugin.json；头注释不带版本号防漂移）
 *
 * 工具:
 *  compress        归档不再需要的对话内容为摘要（描述内嵌承重提示词，改写自 acp-kernel MIT；超限自动蒸馏、重复主题提示）
 *  decompress      查看已归档块
 *  search_context  按关键词检索归档块（中英文，多词交集；project scope 下仅限本项目）
 *  context_stats   归档统计 + 真实上下文占用（hook 写入的 usage.json）
 *  context_usage   当前真实上下文占用
 *  sweep           （v0.5 已移除——去重由 compress 的 possibleDuplicates 覆盖，统计见 context_stats.insights）
 *
 * 协议: MCP stdio（按行分隔的 JSON-RPC 2.0），无第三方依赖。
 * 持久化: 归档块存 ~/.zcode/dcp/blocks[-<项目哈希>].json（archive_scope=project 默认按项目隔离，旧全局文件种子迁移）。
 * 提示词出处: 承重规则 adapted from acp-kernel (MIT, @ranxianglei)；蒸馏保留 Open objectives 遵其 #442 教训。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const {
  STATE_DIR,
  USAGE_FILE,
  readJson,
  writeJson,
  blocksFileFor,
  eachPluginOption,
} = require("../dcp-common.cjs"); // 相对本文件：dist/mcp → dist/dcp-common.cjs

const SERVER_INFO = { name: "zcode-dcp", version: "0.6.0" };
const PROJECT_DIR = String(process.env.DCP_PROJECT_DIR || "");

// ---------- 配置（env > config.json > 默认，遍历与过滤规则在 dcp-common） ----------
function loadServerConfig() {
  const cfg = { archive_scope: "project", max_blocks: 200 };
  eachPluginOption((val) => {
    if (val.archive_scope === "project" || val.archive_scope === "global") cfg.archive_scope = val.archive_scope;
    if (Number.isFinite(+val.max_blocks) && +val.max_blocks > 0) cfg.max_blocks = +val.max_blocks;
  });
  if (process.env.DCP_ARCHIVE_SCOPE === "project" || process.env.DCP_ARCHIVE_SCOPE === "global")
    cfg.archive_scope = process.env.DCP_ARCHIVE_SCOPE;
  if (Number.isFinite(+process.env.DCP_MAX_BLOCKS) && +process.env.DCP_MAX_BLOCKS > 0)
    cfg.max_blocks = +process.env.DCP_MAX_BLOCKS;
  return cfg;
}
const SRV_CFG = loadServerConfig();

function blocksFile() {
  return blocksFileFor(PROJECT_DIR, SRV_CFG.archive_scope);
}

// ---------- 状态（启动时从 blocks.json 加载） ----------
const state = {
  blocks: [],
  nextBlockId: 1,
  stats: { totalCompressions: 0, totalDecompressions: 0, lastCompressionAt: null },
};

function loadBlocks() {
  // 先解析路径（blocksFileFor 有种子迁移副作用，不能先 existsSync 再取路径）
  const file = blocksFile();
  if (!fs.existsSync(file)) {
    // 磁盘为准：文件被外部清除（purge/手删）即清空内存——防止同项目其他实例把已删归档复活回磁盘
    state.blocks = [];
    state.nextBlockId = 1;
    return;
  }
  const raw = readJson(file);
  if (!raw || !Array.isArray(raw.blocks)) return; // 损坏：保留内存（无害降级）
  state.blocks = raw.blocks.filter((b) => b && b.blockId);
  const maxExisting = state.blocks.reduce(
    (m, b) => Math.max(m, parseInt(String(b.blockId).slice(1), 10) || 0),
    0
  );
  // nextBlockId 取文件值与最大已有 ID+1 的较大者，防止 ID 碰撞
  state.nextBlockId = Math.max(
    Number.isFinite(raw.nextBlockId) && raw.nextBlockId > 0 ? raw.nextBlockId : 0,
    maxExisting + 1
  );
}

function saveBlocks() {
  // 原子写在 dcp-common.writeJson；失败静默，保留内存可用（spec: 无害降级）
  writeJson(blocksFile(), {
    blocks: state.blocks,
    nextBlockId: state.nextBlockId,
    savedAt: new Date().toISOString(),
  });
}

// ---------- 生命周期：超限蒸馏最旧块直至回落到上限（Open objectives 逐字保留，遵 acp-kernel #442） ----------
function enforceMaxBlocks() {
  if (state.blocks.length <= SRV_CFG.max_blocks) return null;
  // 精确回落到上限（至少蒸馏 1 块；max_blocks=1 时也能收敛）
  const distillCount = Math.max(1, state.blocks.length - SRV_CFG.max_blocks + 1);
  const oldest = state.blocks.slice(0, distillCount);
  const sections = oldest.map((b) => {
    const sum = String(b.summary || "");
    const truncated = sum.length > 800 ? sum.slice(0, 800) + "…" : sum;
    const oo = sum.split(/\r?\n/).filter((l) => /open objectives/i.test(l));
    return `## ${b.topic}\n${truncated}${oo.length ? "\n" + oo.join("\n") : ""}`;
  });
  const distilled = {
    blockId: formatBlockId(state.nextBlockId),
    // 嵌块号区间：同日多次蒸馏 topic 不再撞名（撞名会污染 duplicateTopics 洞察）
    topic: `蒸馏归档 ${oldest[0].blockId}-${oldest[oldest.length - 1].blockId}（${new Date().toISOString().slice(0, 10)}，${oldest.length} 块合并）`,
    summary: sections.join("\n\n"),
    tags: ["distilled"],
    type: "general",
    createdAt: new Date().toISOString(),
  };
  const removeIds = new Set(oldest.map((b) => b.blockId));
  state.blocks = state.blocks.filter((b) => !removeIds.has(b.blockId));
  state.nextBlockId += 1;
  state.blocks.push(distilled);
  return distilled;
}

const normTopic = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

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
    windowSource: u.windowSource,
    usedPercent: u.usedPercent,
    nudgeThresholdPercent: u.thresholdPercent,
    tier2Percent: u.tier2Percent,
    tier3Percent: u.tier3Percent,
    totalTokens: u.totalTokens ?? undefined,
    sessionId: u.sessionId,
    updatedAt: u.updatedAt,
    ageMinutes: Number.isFinite(ageMin) ? ageMin : undefined,
    baselineNote:
      "占用百分比相对生效窗口（contextWindowTokens）。窗口来源 windowSource：config=用户显式配置 > calibrated=压缩事件自动校准 > default=默认值；配置方式见 README。",
    scopeNote:
      "计量数据来自最近活跃会话（sessionId/updatedAt）；多窗口并行时其他会话的实时占用不在此列。",
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
      const topic = args.topic == null ? "" : String(args.topic).trim();
      const summary = args.summary == null ? "" : String(args.summary).trim();
      if (!topic || !summary) {
        return { error: "topic 与 summary 为必填且不能为空，未归档。" };
      }
      const blockId = formatBlockId(state.nextBlockId);
      const block = {
        blockId,
        topic,
        summary,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
        type: ["general", "tool_result", "error", "duplicate"].includes(args.type) ? args.type : "general",
        createdAt: new Date().toISOString(),
      };
      state.blocks.push(block);
      state.nextBlockId += 1;
      state.stats.totalCompressions += 1;
      state.stats.lastCompressionAt = block.createdAt;
      // 重复主题提示（归一化完全相等；不自动合并，遵 acp-kernel #442 教训）
      const possibleDuplicates = state.blocks
        .filter((b) => b.blockId !== blockId && normTopic(b.topic) === normTopic(block.topic))
        .map((b) => b.blockId);
      // 生命周期：超限蒸馏
      const distilled = enforceMaxBlocks();
      saveBlocks();
      const out = {
        blockId,
        topic: block.topic,
        message: `已归档: ${block.topic} (块 ID: ${blockId})。已持久化，跨会话可用 search_context 检索、decompress 取回。归档不减少当前 token；要立即释放上下文请建议用户执行 /compact。`,
      };
      if (possibleDuplicates.length > 0) {
        out.possibleDuplicates = possibleDuplicates;
        out.message += ` 注意：已存在同主题块（${possibleDuplicates.join(", ")}），如内容重叠请考虑后续合并表述，避免归档膨胀。`;
      }
      if (distilled) {
        const mergedCount = (distilled.summary.match(/^## /gm) || []).length;
        out.distilled = { blockId: distilled.blockId, mergedCount, topic: distilled.topic };
        out.message += ` 归档数超上限（${SRV_CFG.max_blocks}），最旧 ${mergedCount} 块已蒸馏合并为 ${distilled.blockId}（Open objectives 逐字保留）。`;
      }
      return out;
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
          availableBlocks: state.blocks.map((b) => ({ blockId: b.blockId, topic: b.topic })),
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
    description: "查看压缩统计（块数量/主题/历史、重复主题与错误块洞察）与当前真实上下文占用。",
    inputSchema: { type: "object", properties: {} },
    handler() {
      const all = state.blocks;
      const topicCount = {};
      for (const b of all) {
        const t = normTopic(b.topic);
        if (t) topicCount[t] = (topicCount[t] || 0) + 1;
      }
      return {
        sessionId: "in-session",
        totalBlocks: all.length,
        // 内存统计自 server 启动起（重启归零）；totalBlocks 为持久化真值
        totalCompressions: state.stats.totalCompressions,
        totalDecompressions: state.stats.totalDecompressions,
        statsNote: "totalCompressions/totalDecompressions 统计自 server 启动（跨重启不累计）；totalBlocks 持久化",
        lastCompressionAt: state.stats.lastCompressionAt ? formatLocalTime(state.stats.lastCompressionAt) : null,
        insights: {
          duplicateTopics: Object.values(topicCount).filter((n) => n > 1).length,
          errorBlocks: all.filter((b) => b.type === "error").length,
          note: "重复主题多时可换用更概括的 topic 重新归档（compress 会对同主题返回 possibleDuplicates）；errorBlocks 为 type=error 的归档块数",
        },
        realUsage: usagePayload(),
        compressedTopics: all.map((b) => ({
          blockId: b.blockId,
          topic: b.topic,
          type: b.type,
          tags: b.tags,
          createdAt: formatLocalTime(b.createdAt),
        })),
        message: `当前有 ${all.length} 个压缩块`,
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
    name: "dcp_reset",
    description:
      "列举或清除插件本地状态（归档块/计量/校准/提醒状态）。mode=list 仅列举无副作用；mode=purge 不可逆删除全部插件状态并重置归档，必须已获用户明确确认且显式传 confirm=true。范围严格限定插件状态目录。",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: "list=仅列举残留；purge=确认后清除全部插件状态",
        },
        confirm: {
          type: "boolean",
          description: "purge 必须显式传 true（传入前必须已获用户对不可逆删除的明确确认）；list 忽略",
        },
      },
      required: ["mode"],
    },
    handler(args) {
      // 状态目录若被替换为符号链接/junction，列举或删除都会作用于链接目标——机械护栏，直接拒绝
      try {
        if (fs.lstatSync(STATE_DIR).isSymbolicLink()) {
          return { error: `状态目录是符号链接/junction（${STATE_DIR}），为防越界已拒绝操作，请人工检查该目录。` };
        }
      } catch {}

      // 白名单：只有匹配以下模式的文件才是本插件状态（含原子写残留的 .tmp 与按模型分校准的 window-calibration-<model>）
      const OWNED = (name) =>
        /^blocks(-[0-9a-f]{1,12})?\.json(\.tmp)?$/.test(name) ||
        /^(usage|compact-stats)\.json(\.tmp)?$/.test(name) ||
        /^window-calibration(-[A-Za-z0-9._-]{1,48})?\.json(\.tmp)?$/.test(name) ||
        /^(nudge|absorb|recall-pending)-[A-Za-z0-9_-]{1,64}\.json(\.tmp)?$/.test(name);
      const CATEGORY = (name) => {
        if (/^blocks(-[0-9a-f]{1,12})?\.json(\.tmp)?$/.test(name)) return "归档块（清除即永久丢失）";
        if (name.startsWith("usage.json")) return "上下文计量";
        if (/^window-calibration/.test(name)) return "窗口校准观测";
        if (name.startsWith("compact-stats.json")) return "内核压缩事件统计";
        if (/^nudge-/.test(name)) return "分级提醒状态";
        if (/^absorb-/.test(name)) return "absorb 冷却状态";
        if (/^recall-pending-/.test(name)) return "压缩召回标记";
        return "未识别文件（非插件状态，purge 不会删除）";
      };

      if (args.mode === "list") {
        const files = [];
        let dirMissing = false;
        try {
          for (const f of fs.readdirSync(STATE_DIR)) {
            try {
              const st = fs.statSync(path.join(STATE_DIR, f));
              if (!st.isFile()) continue;
              files.push({ file: f, bytes: st.size, owned: OWNED(f), modifiedAt: formatLocalTime(st.mtime.toISOString()), category: CATEGORY(f) });
            } catch {}
          }
        } catch {
          dirMissing = true;
        }
        const totalBytes = files.reduce((m, f) => m + f.bytes, 0);
        const ownedCount = files.filter((f) => f.owned).length;
        return {
          mode: "list",
          stateDir: STATE_DIR,
          files,
          totalFiles: files.length,
          ownedFiles: ownedCount,
          totalBytes,
          note: dirMissing
            ? "状态目录不存在，无需清理。"
            : ownedCount === 0
              ? "无插件状态文件，无需清理。"
              : `purge 将删除 ${ownedCount} 个插件状态文件（不可逆，归档内容永久丢失；未识别文件会保留）。卸载插件本身请随后在 设置 → 插件 中操作。`,
        };
      }
      if (args.mode === "purge") {
        if (args.confirm !== true) {
          return { error: "purge 需要显式传 confirm=true，且传入前必须已获用户对不可逆删除的明确确认。" };
        }
        const removed = [];
        const skippedUnknown = [];
        try {
          for (const f of fs.readdirSync(STATE_DIR)) {
            const full = path.join(STATE_DIR, f);
            try {
              if (!fs.statSync(full).isFile()) continue;
              if (!OWNED(f)) {
                skippedUnknown.push(f); // 白名单外文件一律不删
                continue;
              }
              fs.rmSync(full, { force: true });
              removed.push(f);
            } catch {}
          }
        } catch {}
        // 事后校验：白名单文件若仍残留（EPERM/EBUSY 等删除失败），如实上报而非谎报成功
        let remaining = [];
        try {
          remaining = fs.readdirSync(STATE_DIR).filter((f) => OWNED(f));
        } catch {}
        // 内存态归一（归档清空、块号归一；stats 为本进程计数保留）
        state.blocks = [];
        state.nextBlockId = 1;
        if (remaining.length > 0) {
          return {
            mode: "purge",
            stateDir: STATE_DIR,
            removedFiles: removed,
            skippedUnknown,
            remainingFiles: remaining,
            message: `部分文件删除失败（${remaining.join(", ")} 仍在，归档可能未彻底清空），请重试或手动删除整个状态目录。${skippedUnknown.length ? `另有 ${skippedUnknown.length} 个未识别文件已保留。` : ""}`,
          };
        }
        return {
          mode: "purge",
          stateDir: STATE_DIR,
          removedFiles: removed,
          skippedUnknown,
          removedCount: removed.length,
          message:
            removed.length === 0
              ? "无插件状态文件，无需清理。"
              : `已清除 ${removed.length} 个状态文件，归档与校准已重置（仍在进行的会话会自动重建计量文件，属正常）。如需卸载插件本体：设置 → 插件 → zcode-dcp → 卸载；dev 市场源可在插件市场 → 市场源中移除（可选）。`,
        };
      }
      return { error: 'mode 仅支持 "list" 或 "purge"。' };
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
  if (Array.isArray(msg)) {
    msg.forEach((m) => handleMessage(m)); // JSON-RPC batch
    return;
  }
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
      loadBlocks(); // 变更/读取前重读磁盘：缩小同项目双实例 last-writer-wins 竞态窗口，并让跨窗口新块可见
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) {
        reply(msg.id, null, { code: -32602, message: `Unknown tool: ${params.name}` });
        break;
      }
      try {
        const out = tool.handler(params.arguments || {});
        reply(msg.id, typeof out.error === "string" && !out.content ? textResult({ ...out, isError: true }) : textResult(out));
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
