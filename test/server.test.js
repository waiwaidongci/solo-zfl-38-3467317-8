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
    assert.equal(s.items.find(i => i.id === itemId).frozenByRecallId, null);
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
    assert.equal(item.frozenByRecallId, null);
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
});
