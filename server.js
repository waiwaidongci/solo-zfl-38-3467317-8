import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);

const FROZEN = "已冻结";
const stages = ["待检查", "校准中", "待复核", "已交付"];
const statLabels = [...stages, FROZEN];
const RECHECK_DONE = "复校完成";

const seed = {
  items: [
    {
      code: "MR-001",
      shipType: "福船",
      scale: "1:48",
      mastCount: 3,
      riggingMaterial: "蜡线",
      owner: "周宁",
      dueDate: "2026-06-28",
      status: "校准中",
      tasks: [
        { id: "T-1", position: "前桅侧支索", tension: "偏松", status: "调整中", batchId: null, dependsOn: [], logs: [{ at: "2026-06-12", note: "已缩短2mm" }] }
      ],
      logs: []
    }
  ]
};

const fields = [["code", "模型编号", "text"], ["shipType", "船型", "text"], ["scale", "比例", "text"], ["mastCount", "桅杆数量", "number"], ["riggingMaterial", "帆索材料", "text"], ["owner", "负责人", "text"], ["dueDate", "交付日期", "date"]];
const extraFields = [["position", "索具位置"], ["tension", "松紧状态"], ["note", "调整备注"]];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

/* ---------------- 存储：进程内互斥 + 临时文件原子写入，写入失败即整体回滚 ---------------- */

class JsonStore {
  #db = null;
  #chain = Promise.resolve();
  constructor(file, { clock } = {}) {
    this.file = file;
    this.clock = clock || (() => new Date().toISOString());
    this.failNextWrite = null; // 测试用故障注入
  }
  async init() {
    if (!existsSync(this.file)) {
      await mkdir(dirname(this.file), { recursive: true });
      this.#db = migrate({ items: structuredClone(seed.items) });
      await this.#flush(this.#db);
    } else {
      this.#db = migrate(JSON.parse(await readFile(this.file, "utf8")));
    }
  }
  async #flush(db) {
    const tmp = this.file + ".tmp";
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, this.file);
  }
  read() {
    return structuredClone(this.#db);
  }
  now() {
    return this.clock();
  }
  // 所有变更在互斥队列内完成：先在深拷贝草稿上执行，提交点（原子写盘）失败则丢弃草稿，内存与磁盘都保持原样。
  async mutate(fn) {
    const run = async () => {
      const draft = structuredClone(this.#db);
      const result = await fn(draft);
      if (this.failNextWrite) {
        const err = new Error(this.failNextWrite);
        this.failNextWrite = null;
        throw err;
      }
      draft.version += 1;
      await this.#flush(draft);
      this.#db = draft;
      return result;
    };
    const result = this.#chain.then(run, run);
    this.#chain = result.catch(() => {});
    return result;
  }
}

function nextSeq(db, prefix) {
  db.seq += 1;
  return prefix + db.seq;
}

function migrate(raw) {
  const db = {
    version: Number(raw.version) || 0,
    seq: Number(raw.seq) || 0,
    batches: Array.isArray(raw.batches) ? raw.batches : [],
    items: Array.isArray(raw.items) ? raw.items : []
  };
  const usedIds = new Set();
  for (const item of db.items) {
    if (!item.id) {
      let id;
      do { id = "MR-" + (++db.seq); } while (db.items.some(i => i.id === id));
      item.id = id;
    }
    usedIds.add(item.id);
    item.frozenByRecallId ||= null;
    for (const task of item.tasks || []) {
      if (!task.id) task.id = "T-" + (++db.seq);
      task.batchId = task.batchId ?? null;
      task.dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn : [];
      task.logs ||= [];
    }
    item.logs ||= [];
  }
  for (const batch of db.batches) {
    batch.recalls ||= [];
    for (const recall of batch.recalls) {
      recall.checklist ||= [];
      recall.impact ||= [];
    }
  }
  return db;
}

/* ---------------- 领域逻辑 ---------------- */

class RiggingApp {
  constructor(store) {
    this.store = store;
  }
  #checkVersion(db, input) {
    if (input.version === undefined || input.version === null) throw new HttpError(400, "version_required", "缺少版本号");
    if (input.version !== db.version) throw new HttpError(409, "version_stale", "版本已过期，请刷新后重试");
  }
  #requireRole(role, adminOnly) {
    if (adminOnly && role !== "admin") throw new HttpError(403, "forbidden", "仅质量管理员可执行该操作");
  }
  #findItem(db, key) {
    const item = db.items.find(x => x.id === key || x.code === key);
    if (!item) throw new HttpError(404, "item_not_found", "模型不存在");
    return item;
  }
  #findBatch(db, id) {
    const batch = db.batches.find(b => b.id === id);
    if (!batch) throw new HttpError(404, "batch_not_found", "批次不存在");
    return batch;
  }
  #assertNotFrozen(item) {
    if (item.frozenByRecallId) throw new HttpError(409, "item_frozen", "材料召回冻结中，校准/推进/交付已暂停");
  }
  #activeRecall(batch) {
    return batch.recalls.find(r => r.status === "active");
  }
  #batchCode(db, id) {
    return db.batches.find(b => b.id === id)?.code || "无批次";
  }

  // 直接使用该批次的索位 + 通过 dependsOn 反向闭包得到的后续依赖索位
  #impact(db, batchId) {
    const models = [];
    for (const item of db.items) {
      const tasks = item.tasks || [];
      const direct = new Set(tasks.filter(t => t.batchId === batchId).map(t => t.id));
      if (!direct.size) continue;
      const reverse = new Map();
      for (const t of tasks) for (const dep of t.dependsOn || []) {
        if (!reverse.has(dep)) reverse.set(dep, []);
        reverse.get(dep).push(t.id);
      }
      const affected = new Set(direct);
      const queue = [...direct];
      while (queue.length) {
        for (const depId of reverse.get(queue.shift()) || []) {
          if (!affected.has(depId)) { affected.add(depId); queue.push(depId); }
        }
      }
      const brief = id => {
        const t = tasks.find(x => x.id === id);
        return { taskId: id, position: t?.position || id, tension: t?.tension || "", status: t?.status || "" };
      };
      models.push({
        itemId: item.id,
        code: item.code,
        shipType: item.shipType,
        owner: item.owner,
        status: item.status,
        positions: [...direct].map(brief),
        dependents: [...affected].filter(id => !direct.has(id)).map(brief),
        affectedTaskIds: [...affected]
      });
    }
    return models;
  }

  createItem(input, role) {
    return this.store.mutate(db => {
      this.#checkVersion(db, input);
      const code = String(input.code || "").trim();
      if (!code) throw new HttpError(400, "code_required", "模型编号必填");
      if (db.items.some(i => i.code === code)) throw new HttpError(409, "item_exists", "模型编号重复，请勿重复提交");
      const item = {
        id: nextSeq(db, "MR-"),
        code,
        shipType: input.shipType || "",
        scale: input.scale || "",
        mastCount: input.mastCount === "" ? "" : Number(input.mastCount) || 0,
        riggingMaterial: input.riggingMaterial || "",
        owner: input.owner || "",
        dueDate: input.dueDate || "",
        status: stages.includes(input.status) ? input.status : "待检查",
        frozenByRecallId: null,
        tasks: [],
        logs: [{ at: this.store.now(), step: "建档", note: "创建模型" }]
      };
      db.items.unshift(item);
      return { item, version: db.version + 1 };
    });
  }

  patchItem(key, input, role) {
    return this.store.mutate(db => {
      this.#checkVersion(db, input);
      const item = this.#findItem(db, key);
      this.#assertNotFrozen(item);
      if (!stages.includes(input.status)) throw new HttpError(400, "bad_status", "非法状态");
      item.status = input.status;
      item.logs.push({ at: this.store.now(), step: "状态", note: "更新为" + input.status });
      return { item, version: db.version + 1 };
    });
  }

  addLog(key, input, role) {
    return this.store.mutate(db => {
      this.#checkVersion(db, input);
      const item = this.#findItem(db, key);
      const note = String(input.note || "").trim();
      if (!note) throw new HttpError(400, "note_required", "备注内容必填");
      item.logs.push({ at: this.store.now(), step: input.step || "备注", note });
      return { item, version: db.version + 1 };
    });
  }

  addTask(key, input, role) {
    return this.store.mutate(db => {
      this.#checkVersion(db, input);
      const item = this.#findItem(db, key);
      this.#assertNotFrozen(item);
      const position = String(input.position || "").trim();
      if (!position) throw new HttpError(400, "position_required", "索具位置必填");
      let batchId = null;
      if (input.batchId) {
        const batch = this.#findBatch(db, input.batchId);
        if (batch.status !== "active" || this.#activeRecall(batch)) throw new HttpError(409, "batch_unavailable", "该批次已召回或停用，不能登记索位");
        batchId = batch.id;
      }
      const dependsOn = [];
      for (const depId of input.dependsOn || []) {
        const dep = (item.tasks || []).find(t => t.id === depId);
        if (!dep) throw new HttpError(400, "bad_dependency", "前置索位不存在");
        if (dep.batchId && batchId && dep.batchId === batchId) {
          // 同批次前后序都会在召回闭包内，允许登记
        }
        dependsOn.push(dep.id);
      }
      const task = {
        id: nextSeq(db, "T-"),
        position,
        tension: input.tension || "",
        status: "待检查",
        batchId,
        dependsOn,
        logs: [{ at: this.store.now(), note: input.note || "新增帆索任务" }]
      };
      item.tasks.push(task);
      item.status = "校准中";
      item.logs.push({ at: this.store.now(), step: "帆索", note: position + " · " + (input.tension || "—") + "（批次：" + this.#batchCode(db, batchId) + "）" });
      return { item, task, version: db.version + 1 };
    });
  }

  createBatch(input, role) {
    return this.store.mutate(db => {
      this.#checkVersion(db, input);
      const code = String(input.code || "").trim();
      if (!code) throw new HttpError(400, "code_required", "批次编号必填");
      if (db.batches.some(b => b.code === code)) throw new HttpError(409, "batch_exists", "批次编号重复，请勿重复提交");
      const batch = {
        id: nextSeq(db, "B-"),
        code,
        material: input.material || "",
        supplier: input.supplier || "",
        receivedAt: input.receivedAt || "",
        note: input.note || "",
        status: "active",
        recalls: []
      };
      db.batches.unshift(batch);
      return { batch, version: db.version + 1 };
    });
  }

  recallBatch(batchId, input, role) {
    this.#requireRole(role, true);
    return this.store.mutate(db => {
      this.#checkVersion(db, input);
      const batch = this.#findBatch(db, batchId);
      if (batch.status === "closed") throw new HttpError(409, "batch_closed", "批次已关闭");
      if (this.#activeRecall(batch)) throw new HttpError(409, "recall_active", "该批次已在召回处置中，重复召回被拒绝");
      const impact = this.#impact(db, batch.id);
      if (!impact.length) throw new HttpError(409, "batch_unused", "该批次没有登记任何索位，无需召回");
      const reason = String(input.reason || "").trim() || "材料批次异常";
      const recall = {
        id: nextSeq(db, "R-"),
        reason,
        createdAt: this.store.now(),
        status: "active",
        impact,
        checklist: [],
        snapshot: { items: {} }
      };
      // 冻结：逐模型保存冻结前快照，状态改为已冻结，暂停校准、推进与交付
      for (const entry of impact) {
        const item = db.items.find(i => i.id === entry.itemId);
        recall.snapshot.items[item.id] = structuredClone(item);
        item.frozenByRecallId = recall.id;
        item.status = FROZEN;
        for (const taskId of entry.affectedTaskIds) {
          const task = item.tasks.find(t => t.id === taskId);
          recall.checklist.push({
            id: nextSeq(db, "RC-"),
            itemId: item.id,
            taskId,
            position: task.position,
            kind: entry.positions.some(p => p.taskId === taskId) ? "换料" : "复校",
            done: false,
            doneAt: null
          });
        }
        item.logs.push({ at: recall.createdAt, step: "召回冻结", note: "批次 " + batch.code + " 召回：" + reason + "，冻结校准/推进/交付" });
      }
      batch.status = "recalled";
      batch.recalls.push(recall);
      return { batch, recall: this.#publicRecall(recall), version: db.version + 1 };
    });
  }

  completeChecklist(batchId, recallId, rowId, input, role) {
    return this.store.mutate(db => {
      this.#checkVersion(db, input);
      const batch = this.#findBatch(db, batchId);
      const recall = batch.recalls.find(r => r.id === recallId);
      if (!recall) throw new HttpError(404, "recall_not_found", "召回记录不存在");
      if (recall.status !== "active") throw new HttpError(409, "recall_not_active", "召回流程已结束");
      const row = recall.checklist.find(r => r.id === rowId);
      if (!row) throw new HttpError(404, "checklist_row_not_found", "清单项不存在");
      if (row.done) throw new HttpError(409, "checklist_row_done", "该索位已完成换料复校，请勿重复提交");
      const item = db.items.find(i => i.id === row.itemId);
      const task = item?.tasks.find(t => t.id === row.taskId);
      if (!item || !task) throw new HttpError(404, "task_not_found", "索位已不存在");
      row.done = true;
      row.doneAt = this.store.now();
      task.status = RECHECK_DONE;
      task.logs.push({ at: row.doneAt, note: (row.kind === "换料" ? "换料并复校完成" : "依赖项复校完成") + (input.note ? "：" + input.note : "") });
      item.logs.push({ at: row.doneAt, step: "换料复校", note: task.position + "（" + row.kind + "）完成，剩 " + recall.checklist.filter(r => !r.done).length + " 项" });
      return { recall: this.#publicRecall(recall), version: db.version + 1 };
    });
  }

  unfreeze(batchId, recallId, input, role) {
    this.#requireRole(role, true);
    return this.store.mutate(db => {
      this.#checkVersion(db, input);
      const batch = this.#findBatch(db, batchId);
      const recall = batch.recalls.find(r => r.id === recallId);
      if (!recall) throw new HttpError(404, "recall_not_found", "召回记录不存在");
      if (recall.status !== "active") throw new HttpError(409, "recall_not_active", "召回流程已结束");
      const pending = recall.checklist.filter(r => !r.done);
      if (pending.length) throw new HttpError(409, "recall_recheck_incomplete", "仍有 " + pending.length + " 项换料复校未完成，不能解冻");
      for (const entry of recall.impact) {
        const item = db.items.find(i => i.id === entry.itemId);
        const snap = recall.snapshot.items[item.id];
        item.frozenByRecallId = null;
        item.status = snap.status; // 回到冻结前所处环节
        item.logs.push({ at: this.store.now(), step: "召回解冻", note: "批次 " + batch.code + " 换料复校全部完成，恢复校准/推进/交付" });
      }
      recall.status = "closed";
      recall.closedAt = this.store.now();
      batch.status = "closed";
      return { recall: this.#publicRecall(recall), version: db.version + 1 };
    });
  }

  // 误报撤销：精确恢复冻结前快照（冻结期备注保留），批次回到正常
  revokeRecall(batchId, recallId, input, role) {
    this.#requireRole(role, true);
    return this.store.mutate(db => {
      this.#checkVersion(db, input);
      const batch = this.#findBatch(db, batchId);
      const recall = batch.recalls.find(r => r.id === recallId);
      if (!recall) throw new HttpError(404, "recall_not_found", "召回记录不存在");
      if (recall.status !== "active") throw new HttpError(409, "recall_not_active", "召回流程已结束");
      for (const entry of recall.impact) {
        const frozenItem = db.items.find(i => i.id === entry.itemId);
        const freezeNotes = (frozenItem?.logs || []).filter(l => l.step === "备注" && l.at >= recall.createdAt);
        const snap = structuredClone(recall.snapshot.items[entry.itemId]);
        snap.logs.push({ at: this.store.now(), step: "误报撤销", note: "批次 " + batch.code + " 召回确认为误报，恢复冻结前状态" });
        snap.logs.push(...freezeNotes);
        const idx = db.items.findIndex(i => i.id === snap.id);
        if (idx >= 0) db.items[idx] = snap; else db.items.push(snap);
      }
      recall.status = "revoked";
      recall.revokedAt = this.store.now();
      batch.status = "active";
      return { recall: this.#publicRecall(recall), version: db.version + 1 };
    });
  }

  #publicRecall(recall) {
    const { snapshot, ...rest } = recall;
    return {
      ...rest,
      total: recall.checklist.length,
      done: recall.checklist.filter(r => r.done).length
    };
  }

  state() {
    const db = this.store.read();
    const batchMap = new Map(db.batches.map(b => [b.id, b]));
    const items = db.items.map(item => ({
      ...item,
      logCount: (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0),
      tasks: (item.tasks || []).map(t => ({ ...t, batchCode: batchMap.get(t.batchId)?.code || null }))
    }));
    const recalls = [];
    for (const batch of db.batches) {
      for (const recall of batch.recalls) {
        recalls.push({ batchId: batch.id, batchCode: batch.code, ...this.#publicRecall(recall) });
      }
    }
    return {
      version: db.version,
      items,
      batches: db.batches.map(b => ({ ...b, recalls: b.recalls.map(r => this.#publicRecall(r)) })),
      recalls
    };
  }
}

/* ---------------- HTTP ---------------- */

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}

function createServer(app) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://" + req.headers.host);
      const p = url.pathname;
      const role = req.headers["x-user-role"] === "admin" ? "admin" : "calibrator";
      const json = ["POST", "PATCH", "PUT"].includes(req.method) ? await readBody(req) : {};

      if (req.method === "GET" && p === "/") return html(res, page());
      if (req.method === "GET" && p === "/api/state") return send(res, 200, app.state());
      if (req.method === "GET" && p === "/api/items") return send(res, 200, app.state().items);
      if (req.method === "GET" && p === "/api/stats") return send(res, 200, computeStats(app.state().items));

      if (req.method === "POST" && p === "/api/items") return reply(res, await app.createItem(json, role));
      if (req.method === "POST" && p === "/api/batches") return reply(res, await app.createBatch(json, role));

      let m;
      if ((m = p.match(/^\/api\/batches\/([^/]+)\/recall$/)) && req.method === "POST")
        return reply(res, await app.recallBatch(decodeURIComponent(m[1]), json, role));
      if ((m = p.match(/^\/api\/batches\/([^/]+)\/recalls\/([^/]+)\/checklist\/([^/]+)$/)) && req.method === "POST")
        return reply(res, await app.completeChecklist(decodeURIComponent(m[1]), m[2], m[3], json, role));
      if ((m = p.match(/^\/api\/batches\/([^/]+)\/recalls\/([^/]+)\/unfreeze$/)) && req.method === "POST")
        return reply(res, await app.unfreeze(decodeURIComponent(m[1]), m[2], json, role));
      if ((m = p.match(/^\/api\/batches\/([^/]+)\/recalls\/([^/]+)\/revoke$/)) && req.method === "POST")
        return reply(res, await app.revokeRecall(decodeURIComponent(m[1]), m[2], json, role));
      if ((m = p.match(/^\/api\/items\/([^/]+)$/)) && req.method === "PATCH")
        return reply(res, await app.patchItem(decodeURIComponent(m[1]), json, role));
      if ((m = p.match(/^\/api\/items\/([^/]+)\/logs$/)) && req.method === "POST")
        return reply(res, await app.addLog(decodeURIComponent(m[1]), json, role));
      if ((m = p.match(/^\/api\/items\/([^/]+)\/action$/)) && req.method === "POST")
        return reply(res, await app.addTask(decodeURIComponent(m[1]), json, role));

      send(res, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.code, message: error.message });
      if (error instanceof SyntaxError) return send(res, 400, { error: "bad_json", message: "请求体不是合法 JSON" });
      send(res, 500, { error: "internal_error", message: error.message });
    }
  });
}
function reply(res, result) {
  const { version, ...data } = result;
  return send(res, 200, { ...data, version });
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) if (stats[item.status] !== undefined) stats[item.status] += 1;
  return stats;
}

/* ---------------- 页面 ---------------- */

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准 · 批次召回</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --freeze:#3d5a73; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.danger { background:var(--warn); } button.freeze { background:var(--freeze); } button:disabled { background:#aab3a6; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:150px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.frozen { background:#e8eef3; border-color:var(--freeze); color:var(--freeze); font-weight:700; } .pill.bad { background:#f7e9e5; border-color:var(--warn); color:var(--warn); }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:96px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .recall { border:1px solid var(--warn); border-radius:8px; padding:14px; margin-bottom:12px; background:#fdf7f5; }
    .row { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:7px 0; border-bottom:1px dashed var(--line); font-size:13px; }
    .progress { height:10px; background:#e6e8e3; border-radius:999px; overflow:hidden; margin:8px 0; } .progress i { display:block; height:100%; background:var(--accent); }
    .deps { margin-top:6px; display:grid; gap:6px; }
    .deps label { display:flex; gap:6px; align-items:center; margin:0; color:var(--ink); font-size:13px; } .deps input { width:auto; }
    .batchline { display:flex; justify-content:space-between; gap:8px; align-items:center; padding:6px 0; border-bottom:1px solid var(--line); font-size:13px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>古船模型帆索校准</h1><div class="meta">帆索登记批次与依赖索位；批次异常可召回、冻结、换料复校</div></div>
    <div style="display:flex;gap:10px;align-items:center">
      <label style="margin:0">当前角色</label>
      <select id="role" style="width:auto"><option value="calibrator">校准员</option><option value="admin">质量管理员</option></select>
      <button class="secondary" id="reload">刷新</button>
    </div>
  </header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => "<option>" + s + "</option>").join("")}</select><p class="meta" style="margin-top:10px"><button>保存模型</button></p></form>
      <form id="batchForm" style="margin-top:14px"><h2>新增帆索批次</h2>
        <label>批次编号</label><input name="code" required placeholder="如 LOT-2026-06">
        <label>材料</label><input name="material" placeholder="如 蜡线 0.8mm">
        <label>供应商</label><input name="supplier">
        <label>到货日期</label><input name="receivedAt" type="date">
        <p class="meta" style="margin-top:10px"><button>登记批次</button></p>
      </form>
      <form id="actionForm" style="margin-top:14px"><h2>新增帆索任务</h2>
        <label>选择模型</label><select name="id" id="itemSelect"></select>
        <div id="extraFields"></div>
        <label>使用批次</label><select name="batchId" id="batchSelect"></select>
        <label>后续依赖索位（本任务被哪些索位依赖，可多选）</label><div class="deps" id="depsBox"><span class="meta">先选择模型</span></div>
        <p class="meta" style="margin-top:10px"><button>提交记录</button></p>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${[...stages, FROZEN].map(s => "<option>" + s + "</option>").join("")}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel" id="recallPanel" style="margin-bottom:14px"><h2>批次与召回处置</h2><div id="batches"></div></div>
      <div class="panel"><h2>模型与索位</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待复核","已交付"];
    const FROZEN = "已冻结";
    const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const batchForm = document.querySelector('#batchForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const roleSel = document.querySelector('#role');
    roleSel.value = localStorage.getItem('role') || 'calibrator';
    let state = { version: 0, items: [], batches: [], recalls: [] };
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const role = () => roleSel.value;
    roleSel.onchange = () => { localStorage.setItem('role', roleSel.value); render(); };
    async function api(path, options) {
      const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-User-Role': role() } });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === 'version_stale' || data.error === 'item_frozen' || data.error === 'forbidden') alert(data.message || data.error);
        else alert(data.message || data.error || '请求失败');
        if (data.error === 'version_stale') await load();
        throw new Error(data.error || '请求失败');
      }
      return data;
    }
    const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify({ ...body, version: state.version }) });
    const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify({ ...body, version: state.version }) });
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function batchMap() { return new Map(state.batches.map(b => [b.id, b])); }
    function render() {
      const bm = batchMap();
      itemSelect.innerHTML = state.items.map(item => '<option value="'+esc(item.id)+'">'+esc(item.code)+' · '+esc(item.shipType)+'</option>').join('');
      document.querySelector('#batchSelect').innerHTML = '<option value="">无批次（散装）</option>' + state.batches.filter(b => b.status==='active').map(b => '<option value="'+esc(b.id)+'">'+esc(b.code)+' · '+esc(b.material)+'</option>').join('');
      renderDeps();
      const allStats = [...stages, FROZEN].map(s => [s, state.items.filter(i => i.status === s).length]);
      statsEl.innerHTML = allStats.map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = state.items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item, bm)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await patch('/api/items/'+sel.dataset.status, { status: sel.value }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const note = prompt('记录备注'); if (note) { await post('/api/items/'+btn.dataset.note+'/logs', { step:'备注', note }); await load(); } });
      renderBatches(bm);
    }
    function renderDeps() {
      const box = document.querySelector('#depsBox');
      const item = state.items.find(i => i.id === itemSelect.value);
      if (!item || !(item.tasks||[]).length) { box.innerHTML = '<span class="meta">该模型暂无已有索位</span>'; return; }
      box.innerHTML = item.tasks.map(t => '<label><input type="checkbox" name="dependsOn" value="'+esc(t.id)+'">'+esc(t.position)+'（'+esc(t.batchCode||'无批次')+'）</label>').join('');
    }
    itemSelect.onchange = renderDeps;
    function taskLine(t) {
      const deps = (t.dependsOn||[]).map(id => { const d = (state.items.find(i=>i.id===itemFor(t))?.tasks||[]).find(x=>x.id===id); return d?d.position:id; });
      return '<div class="meta">索位 '+esc(t.position)+' · '+esc(t.status)+' · '+esc(t.tension||'')+' · 批次 '+(t.batchCode?esc(t.batchCode):'无')+(deps.length?' · 依赖：'+deps.map(esc).join('、'):'')+'</div>';
    }
    function itemFor(task){ return state.items.find(i => (i.tasks||[]).some(t=>t.id===task.id))?.id; }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+esc(item[key])+'</div>').join('');
      const tasks = (item.tasks || []).map(taskLine).join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+esc(l.step)+'：'+esc(l.note)+'</div>').join('');
      const frozen = !!item.frozenByRecallId;
      const head = '<h3>'+esc(item.code)+'</h3><div>'+(frozen?'<span class="pill frozen">召回冻结中</span> ':'')+'<span class="pill">'+esc(item.status)+'</span></div>';
      const select = '<label>状态</label><select data-status="'+esc(item.id)+'" '+(frozen?'disabled title="召回冻结中，禁止校准/推进/交付"':'')+'>'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>';
      return '<article class="card">'+head+main+tasks+select+'<button class="secondary" data-note="'+esc(item.id)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function renderBatches(bm) {
      const el = document.querySelector('#batches');
      if (!state.batches.length) { el.innerHTML = '<div class="meta">暂无批次登记</div>'; return; }
      el.innerHTML = state.batches.map(b => {
        const active = (b.recalls||[]).find(r => r.status === 'active');
        const label = {active:'正常',recalled:'召回处置中',closed:'已关闭'}[b.status] || b.status;
        let html = '<div class="batchline"><span><b>'+esc(b.code)+'</b> · '+esc(b.material)+' · '+esc(b.supplier||'')+' <span class="pill '+(b.status==='active'?'':'bad')+'">'+label+'</span></span>';
        if (b.status === 'active' && role()==='admin') html += '<button class="danger" data-recall="'+esc(b.id)+'">批次召回</button>';
        html += '</div>';
        if (active) html += recallHtml(b, active);
        return html;
      }).join('');
      document.querySelectorAll('[data-recall]').forEach(btn => btn.onclick = async () => { const reason = prompt('召回原因（材料异常描述）'); if (reason !== null) { await post('/api/batches/'+btn.dataset.recall+'/recall', { reason }); await load(); } });
      document.querySelectorAll('[data-done]').forEach(btn => btn.onclick = async () => { const [b,r,row] = btn.dataset.done.split('|'); const note = prompt('换料/复校备注（可留空）') || ''; await post('/api/batches/'+b+'/recalls/'+r+'/checklist/'+row, { note }); await load(); });
      document.querySelectorAll('[data-unfreeze]').forEach(btn => btn.onclick = async () => { await post('/api/batches/'+btn.dataset.unfreeze.split('|')[0]+'/recalls/'+btn.dataset.unfreeze.split('|')[1]+'/unfreeze', {}); await load(); });
      document.querySelectorAll('[data-revoke]').forEach(btn => btn.onclick = async () => { if (confirm('确认该召回为误报？将恢复冻结前状态。')) { const [b,r] = btn.dataset.revoke.split('|'); await post('/api/batches/'+b+'/recalls/'+r+'/revoke', {}); await load(); } });
    }
    function recallHtml(b, r) {
      const pct = r.total ? Math.round(r.done / r.total * 100) : 0;
      const models = r.impact.map(en => {
        const pos = en.positions.map(p => '<li>'+esc(p.position)+'（'+esc(p.status)+'）</li>').join('');
        const dep = en.dependents.map(p => '<li>'+esc(p.position)+'（依赖项，'+esc(p.status)+'）</li>').join('');
        return '<div class="meta">模型 <b>'+esc(en.code)+'</b>（'+esc(en.shipType)+'，负责人 '+esc(en.owner||'—')+'，冻结前：'+esc(en.status)+'）<ul style="margin:4px 0">'+pos+dep+'</ul></div>';
      }).join('');
      const rows = r.checklist.map(row => '<div class="row"><span>'+esc(row.position) + ' <span class="pill">'+(row.kind==='换料'?'换料':'依赖复校')+'</span></span>'+(row.done?'<span class="meta">已于 '+esc((row.doneAt||'').replace('T',' ').slice(0,16))+' 完成</span>':'<button data-done="'+esc(b.id)+'|'+esc(r.id)+'|'+esc(row.id)+'">完成</button>')+'</div>').join('');
      return '<div class="recall"><div><b>召回 '+esc(r.id)+'</b>：'+esc(r.reason)+' <span class="pill bad">处置中</span></div>'
        + '<div class="meta" style="margin:6px 0">影响模型 '+r.impact.length+' 个，受影响索位 '+r.total+' 个</div>'
        + models
        + '<div class="meta">换料复校进度 '+r.done+'/'+r.total+'</div><div class="progress"><i style="width:'+pct+'%"></i></div>'
        + rows
        + (role()==='admin' ? '<div style="display:flex;gap:8px;margin-top:10px"><button class="freeze" data-unfreeze="'+esc(b.id)+'|'+esc(r.id)+'" '+(r.done<r.total?'disabled title="全部复校完成后才能解冻"':'')+'>解冻恢复</button><button class="secondary" data-revoke="'+esc(b.id)+'|'+esc(r.id)+'">误报撤销</button></div>'
          : '<div class="meta" style="margin-top:8px">仅质量管理员可解冻或撤销；越权操作将被拒绝。</div>')
        + '</div>';
    }
    async function load() {
      const res = await fetch('/api/state', { headers: { 'X-User-Role': role() } });
      state = await res.json();
      render();
    }
    createForm.onsubmit = async event => { event.preventDefault(); await post('/api/items', Object.fromEntries(new FormData(createForm).entries())); createForm.reset(); await load(); };
    batchForm.onsubmit = async event => { event.preventDefault(); await post('/api/batches', Object.fromEntries(new FormData(batchForm).entries())); batchForm.reset(); await load(); };
    actionForm.onsubmit = async event => {
      event.preventDefault();
      const fd = new FormData(actionForm);
      const dependsOn = fd.getAll('dependsOn');
      const id = fd.get('id');
      const body = Object.fromEntries(fd.entries());
      delete body.id; delete body.dependsOn;
      await post('/api/items/'+id+'/action', { ...body, dependsOn });
      actionForm.reset(); await load();
    };
    document.querySelector('#statusFilter').onchange = render;
    document.querySelector('#search').oninput = render;
    document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

/* ---------------- 启动 ---------------- */

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = new JsonStore(process.env.DB_FILE || dbPath);
  await store.init();
  const server = createServer(new RiggingApp(store));
  server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
}

export { JsonStore, RiggingApp, createServer, HttpError, FROZEN, stages };
