// 真实浏览器（Chromium）端到端：登记批次/依赖 → 召回冻结 → 换料复校 → 越权拒绝 → 管理员解冻
// → 误报撤销 → 重启后数据仍在。运行：node test/e2e.mjs
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

// 无 root 环境：Chromium 运行库解包在 /tmp/chromelibs（存在时启用）
import { existsSync } from "node:fs";
for (const p of ["/tmp/chromelibs/usr/lib/aarch64-linux-gnu", "/tmp/chromelibs/lib/aarch64-linux-gnu"]) {
  if (existsSync(p)) process.env.LD_LIBRARY_PATH = [p, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbFile = "/tmp/rig-e2e-" + process.pid + "-" + Math.random().toString(36).slice(2, 8) + ".json";
const port = 3407;
const base = "http://localhost:" + port;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startServer() {
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, DB_FILE: dbFile, PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"]
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 10000);
    proc.stdout.on("data", async chunk => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        // 等待端口真正可连
        for (let i = 0; i < 30; i++) {
          try { const res = await fetch(base + "/api/state"); if (res.ok) return resolve(proc); } catch {}
          await sleep(100);
        }
        reject(new Error("server not reachable"));
      }
    });
    proc.on("exit", code => reject(new Error("server exited early: " + code)));
  });
}
function stopServer(proc) {
  return new Promise(resolve => {
    if (!proc || proc.killed) return resolve();
    proc.on("exit", resolve);
    proc.kill("SIGTERM");
  });
}
const fail = msg => { throw new Error(msg); };
const assert = (cond, msg) => { if (!cond) fail(msg); };
const step = n => console.log("step", n, new Date().toISOString().slice(11, 19));

let server;
let browser;
let page;
try {
  await rm(dbFile, { force: true });
  server = await startServer();
  browser = await chromium.launch();
  page = await browser.newPage();

  // 收集 alert/confirm 文案；prompt 自动填入，confirm 自动确认
  const alerts = [];
  page.on("dialog", async d => {
    alerts.push(d.message());
    if (d.type() === "prompt") await d.accept(d.message().includes("召回") ? "浏览器E2E：批次脆化" : "E2E复校备注");
    else if (d.type() === "confirm") await d.accept();
    else await d.accept();
  });

  await page.goto(base);
  page.on("console", m => { if (m.type() === "error") console.log("BROWSER:", m.text()); });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.waitForSelector("#cards .card");

  step("1");
  /* 1. 校准员建档 + 登记批次 */
  await page.selectOption("#role", "calibrator");
  await page.fill('#createForm input[name="code"]', "E2E-01");
  await page.fill('#createForm input[name="shipType"]', "福船");
  await page.click('#createForm button');
  await page.waitForFunction(() => document.body.innerText.includes("E2E-01"));

  await page.fill('#batchForm input[name="code"]', "LOT-E2E");
  await page.fill('#batchForm input[name="material"]', "蜡线0.8mm");
  await page.click('#batchForm button');
  await page.waitForFunction(() => document.body.innerText.includes("LOT-E2E"));

  step("2");
  /* 2. 登记两条索位：t1 用批次，t2 依赖 t1 */
  const itemVal = await page.locator('#itemSelect option', { hasText: "E2E-01" }).first().getAttribute("value");
  const batchVal = await page.locator('#batchSelect option', { hasText: "LOT-E2E" }).first().getAttribute("value");
  await page.selectOption("#itemSelect", itemVal);
  await page.fill('#actionForm input[name="position"]', "前桅侧支索");
  await page.selectOption("#batchSelect", batchVal);
  await Promise.all([
    page.waitForResponse(r => r.url().includes("/action") && r.request().method() === "POST"),
    page.click('#actionForm button')
  ]);
  await page.waitForFunction(() => document.body.innerText.includes("前桅侧支索"));
  await page.waitForFunction(() => !document.querySelector('#actionForm input[name="position"]').value);

  await page.selectOption("#itemSelect", itemVal);
  await page.waitForSelector('#depsBox input[value]');
  await page.fill('#actionForm input[name="position"]', "主桅侧支索");
  await page.check('#depsBox input[value]');
  await Promise.all([
    page.waitForResponse(r => r.url().includes("/action") && r.request().method() === "POST"),
    page.click('#actionForm button')
  ]);
  await page.waitForFunction(() => document.body.innerText.includes("依赖：前桅侧支索"));

  step("3");
  /* 3. 校准员看不到“批次召回”按钮；越权 API 调用被拒绝 */
  assert(await page.locator('[data-recall]').count() === 0, "校准员不应看到召回按钮");
  const state1 = await (await fetch(base + "/api/state")).json();
  const batchId = state1.batches.find(b => b.code === "LOT-E2E").id;
  let res = await fetch(base + "/api/batches/" + batchId + "/recall", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Role": "calibrator" },
    body: JSON.stringify({ reason: "越权", version: state1.version })
  });
  assert(res.status === 403, "校准员召回应被拒绝，实际 " + res.status);

  step("4");
  /* 4. 管理员召回：页面出现影响范围、冻结徽标、复校清单与进度 */
  await page.selectOption("#role", "admin");
  await page.click('[data-recall="' + batchId + '"]'); // prompt 自动填原因
  await page.waitForSelector(".recall");
  const recallText = await page.locator(".recall").innerText();
  assert(recallText.includes("E2E-01"), "列出受影响模型");
  assert(recallText.includes("前桅侧支索"), "列出受影响索位");
  assert(recallText.includes("主桅侧支索（依赖项"), "列出后续依赖项");
  assert(recallText.includes("换料复校进度 0/2"), "生成换料复校清单");
  const card = page.locator('.card', { hasText: "E2E-01" }).first();
  await card.waitFor();
  assert((await card.innerText()).includes("召回冻结中"), "卡片显示冻结");
  assert(await card.locator('[data-status]').isDisabled(), "冻结后状态选择被禁用（校准/推进/交付冻结）");
  // 解冻按钮在未全部完成时禁用
  assert(await page.locator('[data-unfreeze]').isDisabled(), "未全部复校不能解冻");

  step("5");
  /* 5. 逐条完成换料复校 */
  await page.click('.recall [data-done] >> nth=0');
  await page.waitForFunction(() => document.body.innerText.includes("换料复校进度 1/2"));
  await page.click('.recall [data-done] >> nth=0');
  await page.waitForFunction(() => document.body.innerText.includes("换料复校进度 2/2"));
  assert(await page.locator('[data-unfreeze]').isEnabled(), "全部完成后解冻按钮可用");

  step("6");
  /* 6. 校准员越权解冻被拒绝（API），页面按钮也不出现 */
  await page.selectOption("#role", "calibrator");
  await page.waitForFunction(() => !document.querySelector('[data-unfreeze]'));
  const state2 = await (await fetch(base + "/api/state")).json();
  const recallId = state2.recalls[0].id;
  res = await fetch(base + `/api/batches/${batchId}/recalls/${recallId}/unfreeze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Role": "calibrator" },
    body: JSON.stringify({ version: state2.version })
  });
  assert(res.status === 403, "校准员解冻应被拒绝，实际 " + res.status);

  step("7");
  /* 7. 先走一遍误报撤销（在解冻前）：恢复冻结前状态 */
  await page.selectOption("#role", "admin");
  await page.click('[data-revoke]'); // confirm 自动确认
  await page.waitForSelector(".recall", { state: "detached" });
  await page.waitForFunction(() => {
    const c = [...document.querySelectorAll('.card')].find(x => x.innerText.includes('E2E-01'));
    return c && !c.innerText.includes("召回冻结中") && c.innerText.includes("校准中");
  });
  assert((await page.locator('#batches').innerText()).includes("LOT-E2E"), "撤销后批次仍在列表且恢复正常");

  step("8");
  /* 8. 原有筛选、状态修改、备注流程保留（此时处于撤销后已解冻） */
  await page.selectOption("#role", "calibrator");
  await page.selectOption("#statusFilter", { label: "已交付" });
  assert((await page.locator('#cards .card').count()) === 0, "按已交付筛选应无卡片");
  await page.selectOption("#statusFilter", { label: "校准中" });
  assert((await page.locator('#cards .card').count()) >= 1, "按校准中筛选应有卡片");
  await page.fill("#search", "E2E-01");
  assert((await page.locator('#cards .card').count()) === 1, "搜索应只留一张卡片");
  await page.fill("#search", "");
  await page.selectOption('.card [data-status]', "待复核");
  await page.waitForFunction(() => {
    const c = [...document.querySelectorAll('.card')].find(x => x.innerText.includes('E2E-01'));
    return c && c.innerText.includes("待复核");
  });

  step("9");
  /* 9. 重新召回（处置闭环），但只完成 1/2，用于验证重启期间处置中状态持久化 */
  await page.selectOption("#role", "admin");
  await page.click('[data-recall="' + batchId + '"]');
  await page.waitForSelector(".recall");
  await page.click('.recall [data-done] >> nth=0');
  await page.waitForFunction(() => document.body.innerText.match(/进度 1\/2/));
  await browser.close();
  await stopServer(server);
  server = null;

  step("10");
  /* 10. 重启：影响范围与处置进度保留，走完剩余复校后解冻，恢复冻结前（待复核）状态 */
  server = await startServer();
  browser = await chromium.launch();
  const page2 = await browser.newPage();
  page2.on("dialog", async d => {
    if (d.type() === "prompt") await d.accept("重启后复校");
    else await d.accept();
  });
  await page2.goto(base);
  await page2.selectOption("#role", "admin");
  await page2.waitForSelector(".recall");
  const after = await page2.locator(".recall").innerText();
  assert(after.includes("E2E-01") && after.includes("进度 1/2"), "重启后影响范围与处置进度保留");
  assert(after.includes("前桅侧支索") && after.includes("主桅侧支索（依赖项"), "重启后受影响索位/依赖项保留");
  await page2.screenshot({ path: "/tmp/rig-e2e-recall.png", fullPage: true });
  // 重启后走完剩余复校并解冻
  await page2.click('.recall [data-done] >> nth=0');
  await page2.waitForFunction(() => document.body.innerText.includes("进度 2/2"));
  await page2.click('[data-unfreeze]');
  await page2.waitForSelector(".recall", { state: "detached" });
  const s3 = await (await fetch(base + "/api/state")).json();
  assert(s3.items.find(i => i.code === "E2E-01").status === "待复核", "重启+解冻后恢复冻结前状态（待复核）");

  console.log("E2E 通过：召回/冻结/复校/越权拒绝/解冻/撤销/筛选状态/重启持久化 全部走通");
} catch (err) {
  console.error("E2E 失败:", err.message);
  try {
    const st = await (await fetch(base + "/api/state")).json();
    console.error("STATE version:", st.version, "role:", await page.$eval("#role", el => el.value).catch(() => "?"));
    console.error("BATCHES:", JSON.stringify(st.batches.map(b => ({ code: b.code, status: b.status, recalls: b.recalls.map(r => ({ status: r.status, total: r.total, done: r.done })) }))));
    console.error("ITEMS:", JSON.stringify(st.items.map(i => ({ code: i.code, status: i.status, frozen: i.frozenByRecallId, tasks: i.tasks.map(t => ({ p: t.position, b: t.batchId, d: t.dependsOn })) }))));
  } catch (e) { console.error("state dump failed", e.message); }
  try { await page?.screenshot({ path: "/tmp/rig-e2e-fail.png", fullPage: true }); } catch {}
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await stopServer(server);
  await rm(dbFile, { force: true }).catch(() => {});
}
