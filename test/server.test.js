import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import { JsonStore, RiggingApp, createServer } from "../server.js";

describe("帆索批次召回", { concurrency: false }, () => {
  let ctx;

  class Ctx {
    constructor() {
      this.file = "/tmp/rig-test-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".json";
      this.curVer = 0;
    }
    async start() {
      await rm(this.file, { force: true });
      this.store = new JsonStore(this.file);
      await this.store.init();
      this.app = new RiggingApp(this.store);
      this.server = createServer(this.app);
      await new Promise(resolve => this.server.listen(0, resolve));
      this.base = "http://localhost:" + this.server.address().port;
    }
    async stop() {
      await new Promise(r => this.server.close(r));
      await rm(this.file, { force: true });
    }
    async req(method, path, body, role = "calibrator", ver = undefined) {
      const useVer = ver === undefined ? this.curVer : ver;
      const payload = body === undefined ? undefined : JSON.stringify({ ...body, version: useVer });
      const res = await fetch(this.base + path, {
        method,
        headers: { "Content-Type": "application/json", "X-User-Role": role },
        body: payload
      });
      const data = await res.json();
      if (data.version !== undefined) this.curVer = data.version;
      return { status: res.status, data };
    }
    state() { return this.req("GET", "/api/state").then(r => r.data); }
    async fixture() {
      // 模型 + 批次 + 三条索位：t1 直接用批次，t2 依赖 t1（后续依赖索位），t3 无批次
      let r = await this.req("POST", "/api/items", { code: "M-" + Math.random().toString(36).slice(2, 7), shipType: "福船", owner: "周宁" });
      const itemId = r.data.item.id;
      r = await this.req("POST", "/api/batches", { code: "LOT-" + Math.random().toString(36).slice(2, 7), material: "蜡线" });
      const batchId = r.data.batch.id;
      r = await this.req("POST", "/api/items/" + itemId + "/action", { position: "前桅侧支索", tension: "偏松", batchId });
      const t1 = r.data.task.id;
      r = await this.req("POST", "/api/items/" + itemId + "/action", { position: "主桅侧支索", tension: "正常", dependsOn: [t1] });
      const t2 = r.data.task.id;
      r = await this.req("POST", "/api/items/" + itemId + "/action", { position: "后桅升帆索", tension: "偏紧" });
      return { itemId, batchId, t1, t2, t3: r.data.task.id };
    }
    // 同一模型两个批次：tA 用批次A，tB 用批次B，tD 无批次且同时依赖 tA、tB（共享后续依赖索位）
    async twoBatchFixture() {
      const code = "M2-" + Math.random().toString(36).slice(2, 7);
      let r = await this.req("POST", "/api/items", { code, shipType: "福船", owner: "周宁", status: "待复核" });
      const itemId = r.data.item.id;
      r = await this.req("POST", "/api/batches", { code: "LA-" + Math.random().toString(36).slice(2, 6), material: "蜡线A" });
      const batchA = r.data.batch.id;
      r = await this.req("POST", "/api/batches", { code: "LB-" + Math.random().toString(36).slice(2, 6), material: "蜡线B" });
      const batchB = r.data.batch.id;
      r = await this.req("POST", "/api/items/" + itemId + "/action", { position: "前桅支索", tension: "偏松", batchId: batchA });
      const tA = r.data.task.id; // addTask 会把模型置为校准中
      r = await this.req("POST", "/api/items/" + itemId + "/action", { position: "主桅支索", tension: "偏紧", batchId: batchB });
      const tB = r.data.task.id;
      r = await this.req("POST", "/api/items/" + itemId + "/action", { position: "后桅升帆索", tension: "正常", dependsOn: [tA, tB] });
      const tD = r.data.task.id;
      // 额外两个已使用批次，专供并发提交用例
      r = await this.req("POST", "/api/batches", { code: "LC-" + Math.random().toString(36).slice(2, 6), material: "蜡线C" });
      const batchC = r.data.batch.id;
      r = await this.req("POST", "/api/batches", { code: "LD-" + Math.random().toString(36).slice(2, 6), material: "蜡线D" });
      const batchD = r.data.batch.id;
      await this.req("POST", "/api/items/" + itemId + "/action", { position: "艏斜桅支索", batchId: batchC });
      await this.req("POST", "/api/items/" + itemId + "/action", { position: "尾桅横桁索", batchId: batchD });
      return { itemId, batchA, batchB, batchC, batchD, tA, tB, tD };
    }
  }

  beforeEach(async () => { ctx = new Ctx(); await ctx.start(); });
  afterEach(async () => { await ctx.stop(); });

  test("正常流程：召回→影响范围→冻结→换料复校全部完成→解冻恢复原状态", async () => {
    const { itemId, batchId, t1, t2 } = await ctx.fixture();
    let s = await ctx.state();
    assert.equal(s.items.find(i => i.id === itemId).status, "校准中");

    // 校准员不能召回（越权拒绝）
    let r = await ctx.req("POST", "/api/batches/" + batchId + "/recall", { reason: "脆化" }, "calibrator", s.version);
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "forbidden");

    // 管理员召回
    r = await ctx.req("POST", "/api/batches/" + batchId + "/recall", { reason: "批次脆化异常" }, "admin", s.version);
    assert.equal(r.status, 200);
    const recallId = r.data.recall.id;
    const impact = r.data.recall.impact;
    assert.equal(impact.length, 1, "列出受影响模型");
    assert.deepEqual(impact[0].positions.map(p => p.taskId), [t1], "直接索位");
    assert.deepEqual(impact[0].dependents.map(p => p.taskId), [t2], "后续依赖索位");
    assert.equal(r.data.recall.total, 2, "清单含直接+依赖项");

    // 冻结：状态修改（推进/交付）与新增任务都拒绝
    s = await ctx.state();
    assert.equal(s.items.find(i => i.id === itemId).status, "已冻结");
    r = await ctx.req("PATCH", "/api/items/" + itemId, { status: "待复核" }, "calibrator", s.version);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "item_frozen");
    r = await ctx.req("POST", "/api/items/" + itemId + "/action", { position: "新索位" }, "calibrator", s.version);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "item_frozen");

    // 未全部复校，管理员也不能解冻
    r = await ctx.req("POST", `/api/batches/${batchId}/recalls/${recallId}/unfreeze`, {}, "admin");
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "recall_recheck_incomplete");

    // 逐条完成换料复校：第一条换料，第二条依赖复校
    s = await ctx.state();
    const rows = s.recalls.find(x => x.id === recallId).checklist;
    assert.equal(rows.find(x => x.taskId === t1).kind, "换料");
    assert.equal(rows.find(x => x.taskId === t2).kind, "复校");
    r = await ctx.req("POST", `/api/batches/${batchId}/recalls/${recallId}/checklist/${rows[0].id}`, { note: "换0.9mm线" });
    assert.equal(r.status, 200);
    // 重复提交同一条拒绝
    r = await ctx.req("POST", `/api/batches/${batchId}/recalls/${recallId}/checklist/${rows[0].id}`, {});
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "checklist_row_done");

    // 校准员不能解冻（越权）
    r = await ctx.req("POST", `/api/batches/${batchId}/recalls/${recallId}/unfreeze`, {}, "calibrator");
    assert.equal(r.status, 403);

    r = await ctx.req("POST", `/api/batches/${batchId}/recalls/${recallId}/checklist/${rows[1].id}`, {});
    assert.equal(r.status, 200);
    // 全部完成后管理员解冻，恢复冻结前状态
    r = await ctx.req("POST", `/api/batches/${batchId}/recalls/${recallId}/unfreeze`, {}, "admin");
    assert.equal(r.status, 200);
    s = await ctx.state();
    assert.equal(s.items.find(i => i.id === itemId).status, "校准中", "解冻恢复冻结前状态");
    assert.equal(s.items.find(i => i.id === itemId).frozenRecallIds.length, 0);
    const batch = s.batches.find(b => b.id === batchId);
    assert.equal(batch.status, "closed");
    assert.equal(batch.recalls[0].status, "closed");

    // 解冻后推进/交付恢复可用
    r = await ctx.req("PATCH", "/api/items/" + itemId, { status: "待复核" });
    assert.equal(r.status, 200);
  });

  test("并发召回：同版本并发只成功一次；串行重复召回也拒绝", async () => {
    const { itemId, batchId } = await ctx.fixture();
    const s = await ctx.state();
    const results = await Promise.all([
      ctx.req("POST", "/api/batches/" + batchId + "/recall", { reason: "并发1" }, "admin", s.version),
      ctx.req("POST", "/api/batches/" + batchId + "/recall", { reason: "并发2" }, "admin", s.version),
      ctx.req("POST", "/api/batches/" + batchId + "/recall", { reason: "并发3" }, "admin", s.version)
    ]);
    const ok = results.filter(r => r.status === 200);
    const rejected = results.filter(r => r.status === 409).map(r => r.data.error);
    assert.equal(ok.length, 1, "只有一个召回成功");
    assert.ok(rejected.every(e => e === "version_stale" || e === "recall_active"), "其余因过期版本或处置中被拒绝");

    // 刷新后再提交 → 已在处置中
    const s2 = await ctx.state();
    const r = await ctx.req("POST", "/api/batches/" + batchId + "/recall", { reason: "再次" }, "admin", s2.version);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "recall_active");

    // 处置期间不能用该批次在其他模型上登记新索位（批次不可用先于冻结校验）
    const other = await ctx.req("POST", "/api/items", { code: "M-OTHER" });
    const r2 = await ctx.req("POST", "/api/items/" + other.data.item.id + "/action", { position: "新索位", batchId });
    assert.equal(r2.status, 409);
    assert.equal(r2.data.error, "batch_unavailable");

    // 不影响：处置中仍可对冻结模型追加备注
    const r3 = await ctx.req("POST", "/api/items/" + itemId + "/logs", { step: "备注", note: "冻结期备注应保留" });
    assert.equal(r3.status, 200);
  });

  test("过期版本：任何带旧 version 的变更都被拒绝且不产生副作用；并发建档只成一个", async () => {
    const { itemId } = await ctx.fixture();
    const s = await ctx.state();
    const v = s.version;
    // 先成功制造新版本
    let r = await ctx.req("POST", "/api/batches", { code: "LOT-2" }, "calibrator", v);
    assert.equal(r.status, 200);
    // 旧版本再建批次 → 409
    r = await ctx.req("POST", "/api/batches", { code: "LOT-3" }, "calibrator", v);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "version_stale");
    // 缺版本号 → 400
    const res = await fetch(ctx.base + "/api/items/" + itemId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "已交付" })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, "version_required");
    // 同版本并发建档（相同编号）只有一个成功
    const fresh = (await ctx.state()).version;
    const dup = await Promise.all([
      ctx.req("POST", "/api/items", { code: "DUP" }, "calibrator", fresh),
      ctx.req("POST", "/api/items", { code: "DUP" }, "calibrator", fresh)
    ]);
    assert.equal(dup.filter(x => x.status === 200).length, 1, "并发建档只有一个成功");
    assert.ok(dup.some(x => x.status === 409));
  });

  test("回滚：写盘失败时整体回滚，内存与磁盘均保持原状", async () => {
    const { itemId, batchId } = await ctx.fixture();
    const s = await ctx.state();
    const beforeVersion = s.version;

    // 第二个 store 绑定同一文件，注入写盘故障，在提交点失败
    const store2 = new JsonStore(ctx.file);
    await store2.init();
    store2.failNextWrite = "simulated disk full";
    const app2 = new RiggingApp(store2);
    await assert.rejects(
      () => app2.recallBatch(batchId, { version: store2.read().version, reason: "应回滚" }, "admin"),
      /simulated disk full/
    );
    // 内存未变
    const after = store2.read();
    assert.equal(after.version, beforeVersion, "版本号不前进");
    assert.ok(!after.batches.find(b => b.id === batchId).recalls.length, "召回未落库");
    assert.equal(after.items.find(i => i.id === itemId).status, "校准中", "模型未冻结");

    // 磁盘文件仍是失败前内容
    const raw = JSON.parse(await readFile(ctx.file, "utf8"));
    assert.equal(raw.version, beforeVersion);
    assert.equal(raw.items.find(i => i.id === itemId).status, "校准中");

    // 回滚后系统仍可继续正常工作
    const r = await ctx.req("POST", "/api/batches/" + batchId + "/recall", { reason: "磁盘恢复后召回" }, "admin");
    assert.equal(r.status, 200);
  });

  test("误报撤销：恢复冻结前状态，批次恢复正常，冻结期备注保留", async () => {
    const { itemId, batchId, t1 } = await ctx.fixture();
    // 先把模型推进到待复核再召回，验证恢复到冻结前环节
    let r = await ctx.req("PATCH", "/api/items/" + itemId, { status: "待复核" });
    assert.equal(r.status, 200);
    r = await ctx.req("POST", "/api/batches/" + batchId + "/recall", { reason: "疑似异常" }, "admin");
    assert.equal(r.status, 200);
    const recallId = r.data.recall.id;

    // 冻结期：完成一条复校 + 追加备注
    let s = await ctx.state();
    const row = s.recalls.find(x => x.id === recallId).checklist[0];
    r = await ctx.req("POST", `/api/batches/${batchId}/recalls/${recallId}/checklist/${row.id}`, {});
    assert.equal(r.status, 200);
    r = await ctx.req("POST", "/api/items/" + itemId + "/logs", { step: "备注", note: "冻结期人工备注" });
    assert.equal(r.status, 200);

    // 校准员撤销被拒绝
    r = await ctx.req("POST", `/api/batches/${batchId}/recalls/${recallId}/revoke`, {}, "calibrator");
    assert.equal(r.status, 403);

    // 管理员误报撤销
    r = await ctx.req("POST", `/api/batches/${batchId}/recalls/${recallId}/revoke`, {}, "admin");
    assert.equal(r.status, 200);
    s = await ctx.state();
    const item = s.items.find(i => i.id === itemId);
    assert.equal(item.status, "待复核", "恢复冻结前状态（待复核）");
    assert.equal(item.frozenRecallIds.length, 0);
    assert.equal(s.batches.find(b => b.id === batchId).status, "active", "批次恢复正常可继续使用");
    assert.equal(s.recalls.find(x => x.id === recallId).status, "revoked");
    // 索位回到快照（复校完成标记被整体回滚）
    const task = item.tasks.find(t => t.id === t1);
    assert.notEqual(task.status, "复校完成");
    // 冻结期备注保留
    assert.ok(item.logs.some(l => l.note === "冻结期人工备注"), "冻结期备注保留");
    assert.ok(item.logs.some(l => l.step === "误报撤销"));

    // 撤销后该批次可再次召回
    r = await ctx.req("POST", "/api/batches/" + batchId + "/recall", { reason: "这次是真的" }, "admin");
    assert.equal(r.status, 200);
  });

  test("持久化：重启进程后批次、召回、冻结与处置进度仍在", async () => {
    const { itemId, batchId } = await ctx.fixture();
    let r = await ctx.req("POST", "/api/batches/" + batchId + "/recall", { reason: "持久化验证" }, "admin");
    const recallId = r.data.recall.id;
    let s = await ctx.state();
    const row = s.recalls.find(x => x.id === recallId).checklist[0];
    r = await ctx.req("POST", `/api/batches/${batchId}/recalls/${recallId}/checklist/${row.id}`, {});
    assert.equal(r.status, 200);

    // 重启：关闭服务器，用同一文件新建 store/server
    await new Promise(res => ctx.server.close(res));
    ctx.store = new JsonStore(ctx.file);
    await ctx.store.init();
    ctx.app = new RiggingApp(ctx.store);
    ctx.server = createServer(ctx.app);
    await new Promise(resolve => ctx.server.listen(0, resolve));
    ctx.base = "http://localhost:" + ctx.server.address().port;

    s = await ctx.state();
    const item = s.items.find(i => i.id === itemId);
    assert.equal(item.status, "已冻结", "重启后仍冻结");
    const rec = s.recalls.find(x => x.id === recallId);
    assert.equal(rec.status, "active");
    assert.equal(rec.done, 1, "处置进度保留");
    assert.equal(rec.total, 2, "影响清单保留");
    assert.equal(s.batches.find(b => b.id === batchId).status, "recalled");

    // 重启后旧版本号立即过期
    const stale = await ctx.req("POST", `/api/batches/${batchId}/recalls/${recallId}/checklist/${rec.checklist[1].id}`, {}, "calibrator", 0);
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, "version_stale");
    // 用持久化的版本继续走完流程
    const done = await ctx.req("POST", `/api/batches/${batchId}/recalls/${recallId}/checklist/${rec.checklist[1].id}`, {});
    assert.equal(done.status, 200);
    const unf = await ctx.req("POST", `/api/batches/${batchId}/recalls/${recallId}/unfreeze`, {}, "admin");
    assert.equal(unf.status, 200);
  });

  test("无批次索位不受召回影响；空批次召回拒绝", async () => {
    const { batchId, t3 } = await ctx.fixture();
    let s = await ctx.state();
    // 未使用批次
    let r = await ctx.req("POST", "/api/batches", { code: "LOT-IDLE" });
    const idleId = r.data.batch.id;
    r = await ctx.req("POST", "/api/batches/" + idleId + "/recall", {}, "admin");
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "batch_unused");

    r = await ctx.req("POST", "/api/batches/" + batchId + "/recall", { reason: "x" }, "admin");
    assert.equal(r.status, 200);
    assert.ok(!r.data.recall.impact[0].affectedTaskIds.includes(t3), "无批次索位不在影响范围");
  });

  test("失败整体回滚：校验失败的变更不落库、版本号不前进", async () => {
    const { itemId } = await ctx.fixture();
    const before = await ctx.state();
    // 引用不存在的前置索位 → 400
    const r = await ctx.req("POST", "/api/items/" + itemId + "/action", { position: "坏索位", dependsOn: ["T-NOPE"] });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "bad_dependency");
    const after = await ctx.state();
    assert.equal(after.version, before.version, "版本号不前进");
    assert.equal(after.items.find(i => i.id === itemId).tasks.length, before.items.find(i => i.id === itemId).tasks.length, "索位未新增");
  });

  test("交叉召回：两个批次先后召回同一模型都成功，影响范围分别正确", async () => {
    const { itemId, batchA, batchB, tA, tB, tD } = await ctx.twoBatchFixture();
    // 推进到待复核，验证最终解冻恢复该状态
    let r = await ctx.req("PATCH", "/api/items/" + itemId, { status: "待复核" });
    assert.equal(r.status, 200);

    r = await ctx.req("POST", "/api/batches/" + batchA + "/recall", { reason: "A脆化" }, "admin");
    assert.equal(r.status, 200, "第一次召回成功");
    const recallA = r.data.recall.id;
    assert.deepEqual(r.data.recall.impact[0].positions.map(p => p.taskId), [tA]);
    assert.deepEqual(r.data.recall.impact[0].dependents.map(p => p.taskId), [tD], "共享依赖项进入A的影响范围");

    // 模型已冻结时，第二个批次仍可召回（同版本并发之外的正常串行提交）
    r = await ctx.req("POST", "/api/batches/" + batchB + "/recall", { reason: "B褪色" }, "admin");
    assert.equal(r.status, 200, "第二次召回同样成功");
    const recallB = r.data.recall.id;
    assert.deepEqual(r.data.recall.impact[0].positions.map(p => p.taskId), [tB]);
    assert.deepEqual(r.data.recall.impact[0].dependents.map(p => p.taskId), [tD], "共享依赖项进入B的影响范围");

    const s = await ctx.state();
    const item = s.items.find(i => i.id === itemId);
    assert.equal(item.status, "已冻结");
    assert.deepEqual(item.frozenRecallIds.sort(), [recallA, recallB].sort(), "模型同时被两个活动召回冻结");
    assert.equal(item.freeze.status, "待复核", "冻结前状态只保存一次（待复核）");
    // 冻结保护仍在
    r = await ctx.req("PATCH", "/api/items/" + itemId, { status: "已交付" });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "item_frozen");
    // 两个批次都显示召回处置中
    assert.equal(s.batches.find(b => b.id === batchA).status, "recalled");
    assert.equal(s.batches.find(b => b.id === batchB).status, "recalled");
    // 同批次重复召回仍拒绝
    r = await ctx.req("POST", "/api/batches/" + batchA + "/recall", { reason: "再召A" }, "admin");
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "recall_active");
  });

  test("单边解冻：完成并解冻A后，B仍处置中，冻结与B的处置进度保留；B完成后才真正解冻", async () => {
    const { itemId, batchA, batchB, tA, tB, tD } = await ctx.twoBatchFixture();
    await ctx.req("PATCH", "/api/items/" + itemId, { status: "待复核" });
    let r = await ctx.req("POST", "/api/batches/" + batchA + "/recall", { reason: "A" }, "admin");
    const recallA = r.data.recall.id;
    r = await ctx.req("POST", "/api/batches/" + batchB + "/recall", { reason: "B" }, "admin");
    const recallB = r.data.recall.id;

    // 完成 B 的一个清单项（进度必须在A单边解冻后保留）
    let s = await ctx.state();
    let recB = s.recalls.find(x => x.id === recallB);
    const bFirst = recB.checklist[0];
    r = await ctx.req("POST", `/api/batches/${batchB}/recalls/${recallB}/checklist/${bFirst.id}`, { note: "B先做一项" });
    assert.equal(r.status, 200);

    // 完成 A 的全部清单并单边解冻
    s = await ctx.state();
    const recA = s.recalls.find(x => x.id === recallA);
    for (const row of recA.checklist) {
      const done = await ctx.req("POST", `/api/batches/${batchA}/recalls/${recallA}/checklist/${row.id}`, {});
      assert.equal(done.status, 200);
    }
    const pubA = (await ctx.state()).recalls.find(x => x.id === recallA);
    assert.equal(pubA.otherActiveByItem[itemId], 1, "A可完成处置，但模型还有1个活动召回");
    r = await ctx.req("POST", `/api/batches/${batchA}/recalls/${recallA}/unfreeze`, {}, "admin");
    assert.equal(r.status, 200);
    assert.equal(r.data.recall.status, "closed");

    s = await ctx.state();
    const item = s.items.find(i => i.id === itemId);
    assert.equal(item.status, "已冻结", "A结束后模型仍冻结");
    assert.deepEqual(item.frozenRecallIds, [recallB]);
    assert.equal(item.freeze.status, "待复核", "冻结前状态继续保留到最后一个召回");
    // 冻结保护没有消失
    r = await ctx.req("PATCH", "/api/items/" + itemId, { status: "已交付" });
    assert.equal(r.status, 409);
    // A 批次已关闭，B 仍处置中且进度保留
    assert.equal(s.batches.find(b => b.id === batchA).status, "closed");
    assert.equal(s.batches.find(b => b.id === batchB).status, "recalled");
    recB = s.recalls.find(x => x.id === recallB);
    assert.equal(recB.status, "active");
    assert.equal(recB.done, 1, "B 的处置进度保留");
    assert.equal(recB.total, 2);
    // A 未全部完成时无法解冻 —— 已在单批次用例覆盖；这里验证B未完成时也不能结束
    r = await ctx.req("POST", `/api/batches/${batchB}/recalls/${recallB}/unfreeze`, {}, "admin");
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "recall_recheck_incomplete");

    // 完成 B 剩余项后解冻，才真正恢复
    const pending = recB.checklist.filter(x => !x.done);
    for (const row of pending) {
      const done = await ctx.req("POST", `/api/batches/${batchB}/recalls/${recallB}/checklist/${row.id}`, {});
      assert.equal(done.status, 200);
    }
    r = await ctx.req("POST", `/api/batches/${batchB}/recalls/${recallB}/unfreeze`, {}, "admin");
    assert.equal(r.status, 200);
    s = await ctx.state();
    const finalItem = s.items.find(i => i.id === itemId);
    assert.equal(finalItem.status, "待复核", "全部活动召回结束后恢复冻结前状态");
    assert.equal(finalItem.frozenRecallIds.length, 0);
    assert.equal(finalItem.freeze, null);
    // 推进恢复可用
    r = await ctx.req("PATCH", "/api/items/" + itemId, { status: "已交付" });
    assert.equal(r.status, 200);
  });

  test("单边撤销：撤销A恢复A直接索位，B活动共享索位保留处置进度，冻结继续", async () => {
    const { itemId, batchA, batchB, tA, tB, tD } = await ctx.twoBatchFixture();
    await ctx.req("PATCH", "/api/items/" + itemId, { status: "待复核" });
    let r = await ctx.req("POST", "/api/batches/" + batchA + "/recall", { reason: "A疑似" }, "admin");
    const recallA = r.data.recall.id;
    r = await ctx.req("POST", "/api/batches/" + batchB + "/recall", { reason: "B真异常" }, "admin");
    const recallB = r.data.recall.id;

    // A、B 各自把共享依赖项 tD 复校完成；A 再完成自己的直接索位 tA
    let s = await ctx.state();
    const rowsOf = id => s.recalls.find(x => x.id === id).checklist;
    const aD = rowsOf(recallA).find(x => x.taskId === tD).id;
    const aA = rowsOf(recallA).find(x => x.taskId === tA).id;
    const bD = rowsOf(recallB).find(x => x.taskId === tD).id;
    await ctx.req("POST", `/api/batches/${batchA}/recalls/${recallA}/checklist/${aD}`, {});
    await ctx.req("POST", `/api/batches/${batchA}/recalls/${recallA}/checklist/${aA}`, {});
    await ctx.req("POST", `/api/batches/${batchB}/recalls/${recallB}/checklist/${bD}`, { note: "B复校tD" });

    // 校准员撤销拒绝
    r = await ctx.req("POST", `/api/batches/${batchA}/recalls/${recallA}/revoke`, {}, "calibrator");
    assert.equal(r.status, 403);

    // 管理员撤销 A（误报）
    r = await ctx.req("POST", `/api/batches/${batchA}/recalls/${recallA}/revoke`, {}, "admin");
    assert.equal(r.status, 200);
    assert.equal(r.data.recall.status, "revoked");

    s = await ctx.state();
    const item = s.items.find(i => i.id === itemId);
    assert.equal(item.status, "已冻结", "B仍活动，冻结继续");
    assert.deepEqual(item.frozenRecallIds, [recallB]);
    assert.equal(item.freeze.status, "待复核", "冻结前状态保留");
    // A 直接索位恢复撤销前状态；共享索位 tD 因 B 仍活动而保留复校完成
    const taskA = item.tasks.find(t => t.id === tA);
    const taskD = item.tasks.find(t => t.id === tD);
    assert.notEqual(taskA.status, "复校完成", "A直接索位回滚");
    assert.equal(taskD.status, "复校完成", "B仍活动，共享索位保留");
    // A 批次恢复正常可再次召回，B 仍处置中且进度（1/2）保留
    assert.equal(s.batches.find(b => b.id === batchA).status, "active");
    assert.equal(s.batches.find(b => b.id === batchB).status, "recalled");
    const recB = s.recalls.find(x => x.id === recallB);
    assert.equal(recB.status, "active");
    assert.equal(recB.done, 1);
    // 冻结保护仍在
    r = await ctx.req("PATCH", "/api/items/" + itemId, { status: "已交付" });
    assert.equal(r.status, 409);
    // A 撤销后可以重新召回
    r = await ctx.req("POST", "/api/batches/" + batchA + "/recall", { reason: "A复查真异常" }, "admin");
    assert.equal(r.status, 200);
  });

  test("多召回并发：同批次并发只成一次；不同批次并发由版本锁裁决，刷新重试后都成立", async () => {
    const { itemId, batchA, batchC, batchD } = await ctx.twoBatchFixture();
    const s = await ctx.state();
    // 同批次 3 个并发召回：仅 1 个成功
    const same = await Promise.all([
      ctx.req("POST", "/api/batches/" + batchA + "/recall", { reason: "a1" }, "admin", s.version),
      ctx.req("POST", "/api/batches/" + batchA + "/recall", { reason: "a2" }, "admin", s.version),
      ctx.req("POST", "/api/batches/" + batchA + "/recall", { reason: "a3" }, "admin", s.version)
    ]);
    assert.equal(same.filter(x => x.status === 200).length, 1);

    // 不同批次并发提交：全局版本锁串行化，恰好一个成功、一个 409 version_stale，刷新重试后两者共存
    const fresh = await ctx.state();
    const cross = await Promise.all([
      ctx.req("POST", "/api/batches/" + batchC + "/recall", { reason: "C" }, "admin", fresh.version),
      ctx.req("POST", "/api/batches/" + batchD + "/recall", { reason: "D" }, "admin", fresh.version)
    ]);
    assert.equal(cross.filter(x => x.status === 200).length, 1, "并发只提交一个");
    const loserIndex = cross.findIndex(x => x.status === 409);
    assert.equal(cross[loserIndex].data.error, "version_stale");
    const lostBatch = loserIndex === 0 ? batchC : batchD;
    const retry = await ctx.req("POST", "/api/batches/" + lostBatch + "/recall", { reason: "刷新重试" }, "admin");
    assert.equal(retry.status, 200, "过期版本刷新重试后召回成功");

    const final = await ctx.state();
    const item = final.items.find(i => i.id === itemId);
    assert.equal(item.frozenRecallIds.length, 3, "三个不同批次的活动召回最终同时成立");
    assert.equal(item.status, "已冻结");
    // 各批次重复召回仍拒绝
    for (const bid of [batchA, batchC, batchD]) {
      const dup = await ctx.req("POST", "/api/batches/" + bid + "/recall", { reason: "dup" }, "admin");
      assert.equal(dup.status, 409);
      assert.equal(dup.data.error, "recall_active");
    }
  });

  test("多召回重启持久化：两个活动召回的冻结、进度单边完成后重启仍在", async () => {
    const { itemId, batchA, batchB } = await ctx.twoBatchFixture();
    await ctx.req("PATCH", "/api/items/" + itemId, { status: "待复核" });
    let r = await ctx.req("POST", "/api/batches/" + batchA + "/recall", { reason: "A" }, "admin");
    const recallA = r.data.recall.id;
    r = await ctx.req("POST", "/api/batches/" + batchB + "/recall", { reason: "B" }, "admin");
    const recallB = r.data.recall.id;
    // A 全部完成；B 只完成一项
    let s = await ctx.state();
    for (const row of s.recalls.find(x => x.id === recallA).checklist) {
      await ctx.req("POST", `/api/batches/${batchA}/recalls/${recallA}/checklist/${row.id}`, {});
    }
    s = await ctx.state();
    const bRow = s.recalls.find(x => x.id === recallB).checklist[0];
    await ctx.req("POST", `/api/batches/${batchB}/recalls/${recallB}/checklist/${bRow.id}`, {});
    await ctx.req("POST", `/api/batches/${batchA}/recalls/${recallA}/unfreeze`, {}, "admin");

    // 重启
    await new Promise(res => ctx.server.close(res));
    ctx.store = new JsonStore(ctx.file);
    await ctx.store.init();
    ctx.app = new RiggingApp(ctx.store);
    ctx.server = createServer(ctx.app);
    await new Promise(resolve => ctx.server.listen(0, resolve));
    ctx.base = "http://localhost:" + ctx.server.address().port;

    s = await ctx.state();
    const item = s.items.find(i => i.id === itemId);
    assert.equal(item.status, "已冻结", "重启后仍被B冻结");
    assert.deepEqual(item.frozenRecallIds, [recallB]);
    assert.equal(item.freeze.status, "待复核");
    assert.equal(s.recalls.find(x => x.id === recallA).status, "closed", "A已完成处置保持关闭");
    const recB = s.recalls.find(x => x.id === recallB);
    assert.equal(recB.status, "active");
    assert.equal(recB.done, 1, "B 的处置进度重启后保留");
    assert.equal(recB.total, 2);
    // 重启后继续走完 B 并解冻
    for (const row of recB.checklist.filter(x => !x.done)) {
      const done = await ctx.req("POST", `/api/batches/${batchB}/recalls/${recallB}/checklist/${row.id}`, {});
      assert.equal(done.status, 200);
    }
    const unf = await ctx.req("POST", `/api/batches/${batchB}/recalls/${recallB}/unfreeze`, {}, "admin");
    assert.equal(unf.status, 200);
    const finalItem = (await ctx.state()).items.find(i => i.id === itemId);
    assert.equal(finalItem.status, "待复核");
    assert.equal(finalItem.frozenRecallIds.length, 0);
  });

  test("旧版单召回数据迁移：frozenByRecallId 迁移为多召回列表并可继续处置", async () => {
    // 手工写一份旧结构磁盘数据
    const oldFile = "/tmp/rig-legacy-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".json";
    const { writeFile, rm } = await import("node:fs/promises");
    try {
      const old = {
        version: 3,
        items: [{
          id: "MR-9", code: "OLD-1", shipType: "鸟船", status: "已冻结", frozenByRecallId: "R-7",
          tasks: [{ id: "T-9", position: "旧索位", tension: "偏松", status: "调整中", batchId: "B-9", dependsOn: [], logs: [] }],
          logs: []
        }],
        batches: [{
          id: "B-9", code: "OLD-LOT", material: "旧蜡线", status: "recalled",
          recalls: [{
            id: "R-7", reason: "旧批次异常", createdAt: "2026-07-01T00:00:00.000Z", status: "active",
            impact: [{ itemId: "MR-9", code: "OLD-1", positions: [{ taskId: "T-9" }], dependents: [], affectedTaskIds: ["T-9"] }],
            checklist: [{ id: "RC-9", itemId: "MR-9", taskId: "T-9", position: "旧索位", kind: "换料", done: false, doneAt: null }],
            snapshot: { items: { "MR-9": { id: "MR-9", status: "校准中", tasks: [{ id: "T-9", status: "调整中" }] } } }
          }]
        }]
      };
      await writeFile(oldFile, JSON.stringify(old));
      const store = new JsonStore(oldFile);
      await store.init();
      const migrated = store.read();
      const item = migrated.items[0];
      assert.deepEqual(item.frozenRecallIds, ["R-7"], "旧冻结字段迁移为列表");
      assert.equal(item.freeze.status, "校准中", "从旧快照恢复冻结前状态");
      assert.equal(item.tasks[0].batchId, "B-9");
      // 可通过 HTTP 继续完成处置并解冻
      await new Promise(res => ctx.server.close(res));
      ctx.file = oldFile;
      ctx.store = store;
      ctx.app = new RiggingApp(store);
      ctx.server = createServer(ctx.app);
      await new Promise(resolve => ctx.server.listen(0, resolve));
      ctx.base = "http://localhost:" + ctx.server.address().port;
      ctx.curVer = store.read().version;
      const done = await ctx.req("POST", "/api/batches/B-9/recalls/R-7/checklist/RC-9", {}, "admin");
      assert.equal(done.status, 200);
      const unf = await ctx.req("POST", "/api/batches/B-9/recalls/R-7/unfreeze", {}, "admin");
      assert.equal(unf.status, 200);
      const s = await ctx.state();
      assert.equal(s.items[0].status, "校准中", "迁移后解冻恢复冻结前状态");
    } finally {
      await rm(oldFile, { force: true });
    }
  });
});
