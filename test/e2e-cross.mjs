// 真实浏览器端到端 · 多批次交叉召回：
// 同一模型两个批次先后召回 → 单边解冻（另一批次仍冻结、进度保留）→ 重启持久化 → 最后解冻恢复
// 运行：node test/e2e-cross.mjs
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

for (const p of ["/tmp/chromelibs/usr/lib/aarch64-linux-gnu", "/tmp/chromelibs/lib/aarch64-linux-gnu"]) {
  if (existsSync(p)) process.env.LD_LIBRARY_PATH = [p, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbFile = "/tmp/rig-e2e-cross-" + process.pid + "-" + Math.random().toString(36).slice(2, 8) + ".json";
const port = 3409;
const base = "http://localhost:" + port;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

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
        for (let i = 0; i < 30; i++) {
          try { if ((await fetch(base + "/api/state")).ok) return resolve(proc); } catch {}
          await sleep(100);
        }
        reject(new Error("server not reachable"));
      }
    });
    proc.on("exit", code => reject(new Error("server exited early: " + code)));
  });
}
const stopServer = proc => new Promise(resolve => { if (!proc || proc.killed) return resolve(); proc.on("exit", resolve); proc.kill("SIGTERM"); });

async function optionValue(page, sel, text) {
  return page.locator(sel + " option", { hasText: text }).first().getAttribute("value");
}
async function addTask(page, itemVal, position, batchLabel, deps = []) {
  await page.selectOption("#itemSelect", itemVal);
  await page.waitForTimeout(50);
  await page.fill('#actionForm input[name="position"]', position);
  if (batchLabel) await page.selectOption("#batchSelect", await optionValue(page, "#batchSelect", batchLabel));
  else await page.selectOption("#batchSelect", "");
  for (const dep of deps) await page.check('#depsBox input[value="' + dep + '"]');
  await Promise.all([
    page.waitForResponse(r => r.url().includes("/action") && r.request().method() === "POST"),
    page.click('#actionForm button')
  ]);
  await page.waitForFunction(p => document.body.innerText.includes(p), position);
  await page.waitForFunction(() => !document.querySelector('#actionForm input[name="position"]').value);
}

let server, browser, page;
try {
  await rm(dbFile, { force: true });
  server = await startServer();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("dialog", async d => {
    if (d.type() === "prompt") await d.accept(d.message().includes("召回") ? "交叉E2E：批次异常" : "交叉E2E复校");
    else await d.accept();
  });
  page.on("pageerror", e => { throw new Error("页面JS错误: " + e.message); });

  await page.goto(base);
  await page.waitForSelector("#cards .card");
  await page.selectOption("#role", "admin");

  /* 建档 + 两个批次 + 三条索位：tP 用批次P，tQ 用批次Q，tShared 无批次且依赖两者 */
  await page.fill('#createForm input[name="code"]', "CRS-1");
  await page.click('#createForm button');
  await page.waitForFunction(() => document.body.innerText.includes("CRS-1"));
  for (const [code, mat] of [["LOT-P", "蜡线P"], ["LOT-Q", "蜡线Q"]]) {
    await page.fill('#batchForm input[name="code"]', code);
    await page.fill('#batchForm input[name="material"]', mat);
    await page.click('#batchForm button');
    await page.waitForFunction(c => document.body.innerText.includes(c), code);
  }
  const itemVal = await optionValue(page, "#itemSelect", "CRS-1");
  await addTask(page, itemVal, "P支索", "LOT-P");
  const state1 = await (await fetch(base + "/api/state")).json();
  const tP = state1.items.find(i => i.code === "CRS-1").tasks[0].id;
  await addTask(page, itemVal, "Q支索", "LOT-Q");
  const state2 = await (await fetch(base + "/api/state")).json();
  const tQ = state2.items.find(i => i.code === "CRS-1").tasks.find(t => t.position === "Q支索").id;
  await addTask(page, itemVal, "共享升帆索", null, [tP, tQ]);

  // 召回前先推进到待复核，最终解冻应恢复该状态
  await page.selectOption('.card [data-status]', "待复核");
  await page.waitForFunction(() => [...document.querySelectorAll('.card')].some(c => c.innerText.includes("CRS-1") && c.innerText.includes("待复核")));

  const st = await (await fetch(base + "/api/state")).json();
  const batchP = st.batches.find(b => b.code === "LOT-P").id;
  const batchQ = st.batches.find(b => b.code === "LOT-Q").id;

  /* 先后召回两个批次 */
  await page.click('[data-recall="' + batchP + '"]');
  await page.waitForFunction(() => document.querySelectorAll(".recall").length === 1);
  await page.click('[data-recall="' + batchQ + '"]');
  await page.waitForFunction(() => document.querySelectorAll(".recall").length === 2);
  // 卡片显示 2 个活动召回且状态控件禁用
  const card = page.locator('.card', { hasText: "CRS-1" }).first();
  await page.waitForFunction(() => {
    const c = [...document.querySelectorAll('.card')].find(x => x.innerText.includes('CRS-1'));
    return c && c.innerText.includes("2 个活动召回");
  });
  assert(await card.locator('[data-status]').isDisabled(), "双重召回冻结中禁止推进/交付");
  // 两个召回面板都列出共享依赖项
  const panels = await page.locator(".recall").allInnerTexts();
  assert(panels.every(t => t.includes("共享升帆索（依赖项")), "两个召回都包含共享依赖索位");

  /* 单边完成并解冻 P：Q 仍处置中，冻结保护与 Q 的进度保留 */
  // P 面板内逐条完成（2 项：P支索=换料、共享升帆索=复校）
  for (let i = 0; i < 2; i++) {
    const doneBtn = page.locator('[data-done^="' + batchP + '|"]').last();
    await doneBtn.waitFor();
    await Promise.all([
      page.waitForResponse(r => r.url().includes("/checklist/") && r.request().method() === "POST"),
      doneBtn.click()
    ]);
  }
  await page.waitForFunction(() => {
    const btns = [...document.querySelectorAll('[data-unfreeze]')];
    return btns.some(b => b.textContent.includes("完成本批次处置（仍冻结）"));
  }, "P 全部完成后按钮应提示仍冻结");
  await page.click('button[data-unfreeze^="' + batchP + '|"]');
  await page.waitForFunction(() => document.querySelectorAll(".recall").length === 1, "P 面板消失，Q 面板保留");
  // 模型仍冻结，且只剩 1 个活动召回
  await page.waitForFunction(() => {
    const c = [...document.querySelectorAll('.card')].find(x => x.innerText.includes('CRS-1'));
    return c && c.innerText.includes("召回冻结中") && !c.innerText.includes("2 个活动召回");
  });
  assert(await card.locator('[data-status]').isDisabled(), "单边解冻后冻结保护未消失");
  // 批次行：P 已关闭、Q 召回处置中
  const batchLines = await page.locator("#batches").innerText();
  assert(batchLines.includes("LOT-P") && batchLines.includes("已关闭"), "P 批次已关闭");
  assert(batchLines.includes("LOT-Q") && batchLines.includes("召回处置中"), "Q 批次仍处置中");

  /* Q 做一项后重启：冻结、活动召回、处置进度持久化 */
  await Promise.all([
    page.waitForResponse(r => r.url().includes("/checklist/") && r.request().method() === "POST"),
    page.locator('[data-done^="' + batchQ + '|"]').last().click()
  ]);
  await page.waitForFunction(() => document.body.innerText.match(/进度 1\/2/));
  await browser.close();
  await stopServer(server);
  server = null;
  server = await startServer();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("dialog", async d => d.type() === "prompt" ? await d.accept("重启后复校") : await d.accept());
  page.on("pageerror", e => { throw new Error("页面JS错误: " + e.message); });
  await page.goto(base);
  await page.selectOption("#role", "admin");
  await page.waitForSelector(".recall");
  const after = await page.locator(".recall").innerText();
  assert(after.includes("进度 1/2"), "重启后 Q 处置进度保留");
  assert(after.includes("共享升帆索"), "重启后影响范围保留");
  await page.waitForFunction(() => {
    const c = [...document.querySelectorAll('.card')].find(x => x.innerText.includes('CRS-1'));
    return c && c.innerText.includes("召回冻结中");
  }, "重启后仍冻结");
  await page.screenshot({ path: "/tmp/rig-e2e-cross.png", fullPage: true });

  /* 走完 Q 最后一项并解冻，恢复冻结前（待复核）状态 */
  await Promise.all([
    page.waitForResponse(r => r.url().includes("/checklist/") && r.request().method() === "POST"),
    page.locator('[data-done^="' + batchQ + '|"]').last().click()
  ]);
  await page.waitForFunction(() => document.body.innerText.match(/进度 2\/2/));
  const btn = page.locator('button[data-unfreeze^="' + batchQ + '|"]');
  assert((await btn.innerText()).includes("解冻恢复"), "最后一个召回结束时按钮为解冻恢复");
  await btn.click();
  await page.waitForSelector(".recall", { state: "detached" });
  await page.waitForFunction(() => {
    const c = [...document.querySelectorAll('.card')].find(x => x.innerText.includes('CRS-1'));
    return c && !c.innerText.includes("召回冻结中") && c.innerText.includes("待复核");
  });
  const s3 = await (await fetch(base + "/api/state")).json();
  const item = s3.items.find(i => i.code === "CRS-1");
  assert(item.status === "待复核", "最终恢复冻结前状态");
  assert(item.frozenRecallIds.length === 0 && item.freeze === null, "冻结引用清空");
  // 推进恢复可用
  assert(await page.locator('.card [data-status]').first().isEnabled(), "解冻后状态控件恢复可用");

  console.log("交叉召回 E2E 通过：双召回/单边解冻仍冻结/进度保留/重启持久化/末次解冻恢复");
} catch (err) {
  console.error("交叉召回 E2E 失败:", err.message);
  try { await page?.screenshot({ path: "/tmp/rig-e2e-cross-fail.png", fullPage: true }); } catch {}
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await stopServer(server);
  await rm(dbFile, { force: true }).catch(() => {});
}
