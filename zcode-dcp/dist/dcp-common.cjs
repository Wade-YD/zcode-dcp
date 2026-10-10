/**
 * ZCode DCP 公共模块 —— hooks/auto-watch.cjs 与 dist/mcp/server.js 共用。
 * 改动本文件必须同时验证 hook（计量/提醒）与 server（工具）两侧。
 *
 * 内容：状态目录常量、原子 JSON 读写、会话/项目命名空间、config.json 的
 * zcode-dcp 插件选项遍历。字段级配置收敛逻辑（DEFAULTS/类型门槛）留在两侧各自实现。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".zcode", "dcp");
const ROLLOUT_DIR = path.join(HOME, ".zcode", "cli", "rollout");
const USAGE_FILE = path.join(STATE_DIR, "usage.json");
const BLOCKS_LEGACY_FILE = path.join(STATE_DIR, "blocks.json");

// 内核压缩触发点 ≈ 窗口 − 34K（逆向 zcode.cjs：窗口 − 21K 输出预留 − 13K buffer）
const KERNEL_COMPACT_RESERVE = 34000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

// 原子写：tmp + rename，防写中程崩溃损坏状态文件；rename 失败（Windows 偶发 EPERM）回退直写
function writeJson(file, obj) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const data = JSON.stringify(obj, null, 2);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, data, "utf-8");
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.writeFileSync(file, data, "utf-8");
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  } catch {}
}

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

// 归档命名空间：project scope 按项目哈希分文件；目标文件缺失时从旧全局文件一次性种子迁移
function blocksFileFor(projectDir, scope) {
  if (scope !== "project" || !projectDir) return BLOCKS_LEGACY_FILE;
  const f = path.join(STATE_DIR, `blocks-${projectHash(projectDir)}.json`);
  if (!fs.existsSync(f)) {
    const legacy = readJson(BLOCKS_LEGACY_FILE);
    if (legacy && Array.isArray(legacy.blocks)) writeJson(f, legacy);
  }
  return f;
}

// 遍历 config.json 里 key 含 "zcode-dcp" 的插件选项（userConfig 到达 hook 的唯一正式通道）
function eachPluginOption(cb) {
  try {
    const configPath = path.join(HOME, ".zcode", "cli", "config.json");
    if (!fs.existsSync(configPath)) return;
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const options = (raw.plugins && raw.plugins.options) || {};
    for (const [key, val] of Object.entries(options)) {
      if (!val || typeof val !== "object") continue;
      if (!key.toLowerCase().includes("zcode-dcp")) continue;
      cb(val);
    }
  } catch {}
}

module.exports = {
  HOME,
  STATE_DIR,
  ROLLOUT_DIR,
  USAGE_FILE,
  BLOCKS_LEGACY_FILE,
  KERNEL_COMPACT_RESERVE,
  readJson,
  writeJson,
  sanitizeSid,
  normalizeProjectDir,
  projectHash,
  blocksFileFor,
  eachPluginOption,
};
