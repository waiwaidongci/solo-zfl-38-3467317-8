// 真实浏览器端到端 · 共享依赖索位的撤销隔离：
// 同一模型两批次召回共享一个依赖索位 → A 全部完成并关闭 → B 全部完成后【误报撤销】
// → 共享索位必须保留 A 已完成的复校结果，不退回待检查；模型正常恢复
// 运行：node test/e2e-revoke.mjs
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
const dbFile = "/tmp/rig-e2e-revoke-" + process.pid + "-" + Math.random().toString(36).slice(2, 8) + ".json";
const port = 3411;
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
  await page.selectOption("#batchSelect", batchLabel ? await optionValue(page, "#batchSelect", batchLabel) : "");
  for (const dep of deps) await page.check('#depsBox input[value="' + dep + '"]');
  await Promise.all([
    page.waitForResponse(r => r.url().includes("/action") && r.request().method() === "POST"),
    page.click('#actionForm button')
  ]);
  await page.waitForFunction(p => document.body.innerText.includes(p), position);
  await page.waitForFunction(() => !document.querySelector('#actionForm input[name="position"]').value);
}
async function completeAll(page, batchId, n) {
  for (let i = 0; i < n; i++) {
    await Promise.all([
      page.waitForResponse(r => r.url().includes("/checklist/") && r.request().method() === "POST"),
      page.locator('[data-done^="' + batchId + '|"]').last().click()
    ]);
  }
}
const getState = () => fetch(base + "/api/state").then(r => r.json());

let server, browser, page;
try {
  await rm(dbFile, { force: true });
  server = await startServer();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("dialog", async d => d.type() === "prompt" ? await d.accept("撤销隔离E2E") : await d.accept());
  page.on("pageerror", e => { throw new Error("页面JS错误: " + e.message); });

  await page.goto(base);
  await page.waitForSelector("#cards .card");
  await page.selectOption("#role", "admin");

  await page.fill('#createForm input[name="code"]', "RVK-1");
  await page.click('#createForm button');
  await page.waitForFunction(() => document.body.innerText.includes("RVK-1"));
  for (const code of ["LOT-A", "LOT-B"]) {
    await page.fill('#batchForm input[name="code"]', code);
    await page.click('#batchForm button');
    await page.waitForFunction(c => document.body.innerText.includes(c), code);
  }
  const itemVal = await optionValue(page, "#itemSelect", "RVK-1");
  await addTask(page, itemVal, "A支索", "LOT-A");
  const s1 = await getState();
  const tA = s1.items.find(i => i.code === "RVK-1").tasks[0].id;
  await addTask(page, itemVal, "B支索", "LOT-B");
  const s2 = await getState();
  const tB = s2.items.find(i => i.code === "RVK-1").tasks.find(t => t.position === "B支索").id;
  await addTask(page, itemVal, "共享斜桁索", null, [tA, tB]);

  const st = await getState();
  const itemId = st.items.find(i => i.code === "RVK-1").id;
  const tD = st.items.find(i => i.id === itemId).tasks.find(t => t.position === "共享斜桁索").id;
  const batchA = st.batches.find(b => b.code === "LOT-A").id;
  const batchB = st.batches.find(b => b.code === "LOT-B").id;

  // 两个批次先后召回
  await page.click('[data-recall="' + batchA + '"]');
  await page.waitForFunction(() => document.querySelectorAll(".recall").length === 1);
  await page.click('[data-recall="' + batchB + '"]');
  await page.waitForFunction(() => document.querySelectorAll(".recall").length === 2);

  // A 全部完成（2项）并关闭
  await completeAll(page, batchA, 2);
  await Promise.all([
    page.waitForResponse(r => r.url().includes("/unfreeze") && r.request().method() === "POST"),
    page.click('button[data-unfreeze^="' + batchA + '|"]')
  ]);
  await page.waitForFunction(() => document.querySelectorAll(".recall").length === 1);
  let s = await getState();
  assert(s.items.find(i => i.id === itemId).tasks.find(t => t.id === tD).status === "复校完成", "A关闭后共享索位为复校完成");

  // B 也全部完成（含共享索位），然后【误报撤销】而不是关闭
  await completeAll(page, batchB, 2);
  await Promise.all([
    page.waitForResponse(r => r.url().includes("/revoke") && r.request().method() === "POST"),
    page.click('button[data-revoke^="' + batchB + '|"]')
  ]);
  await page.waitForSelector(".recall", { state: "detached" });

  // 核心断言：共享索位仍是复校完成（A 已结案的结果不被 B 的撤销覆盖）
  s = await getState();
  const item = s.items.find(i => i.id === itemId);
  const shared = item.tasks.find(t => t.id === tD);
  assert(shared.status === "复校完成", "共享索位必须保留A已完成的处置结果，实际：" + shared.status);
  // B 自己的直接索位随撤销回退
  assert(item.tasks.find(t => t.id === tB).status === "待检查", "B直接索位随B撤销回退基线");
  assert(item.tasks.find(t => t.id === tA).status === "复校完成", "A直接索位不受影响");
  // 无活动召回，模型解冻（默认冻结前为校准中）
  assert(item.status === "校准中", "两个召回均结束后模型解冻，实际：" + item.status);
  assert(item.frozenRecallIds.length === 0 && item.freeze === null);
  // 批次终态：A 关闭、B 误报恢复
  assert(s.batches.find(b => b.id === batchA).status === "closed");
  assert(s.batches.find(b => b.id === batchB).status === "active");
  // 页面无残留冻结徽标，状态控件可用
  await page.waitForFunction(() => {
    const c = [...document.querySelectorAll('.card')].find(x => x.innerText.includes('RVK-1'));
    return c && !c.innerText.includes("召回冻结中");
  });
  assert(await page.locator('.card [data-status]').first().isEnabled(), "解冻后可继续推进");
  await page.screenshot({ path: "/tmp/rig-e2e-revoke.png", fullPage: true });

  console.log("撤销隔离 E2E 通过：B撤销不覆盖A已关闭召回的共享索位复校结果");
} catch (err) {
  console.error("撤销隔离 E2E 失败:", err.message);
  try { await page?.screenshot({ path: "/tmp/rig-e2e-revoke-fail.png", fullPage: true }); } catch {}
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await stopServer(server);
  await rm(dbFile, { force: true }).catch(() => {});
}
