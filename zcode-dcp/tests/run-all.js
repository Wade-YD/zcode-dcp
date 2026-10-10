/* 全量冒烟 runner：顺序执行全部套件，任一失败整体非零退出 */
"use strict";
const { execFileSync } = require("child_process");
const path = require("path");

const suites = ["smoke-regression.js", "smoke-v04.js", "smoke-v041.js", "smoke-v05.js"];
let failed = 0;

for (const t of suites) {
  console.log(`\n========== ${t} ==========`);
  try {
    execFileSync("node", [path.join(__dirname, t)], { stdio: "inherit" });
  } catch {
    failed++;
    console.log(`^^^ ${t} FAILED ^^^`);
  }
}

console.log(`\n==== runner: ${suites.length - failed}/${suites.length} suites passed ====`);
process.exit(failed > 0 ? 1 : 0);
