"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var maintenance_exports = {};
__export(maintenance_exports, {
  deleteHistory: () => deleteHistory,
  restoreHistory: () => restoreHistory,
  roundTo: () => roundTo,
  thinEntries: () => thinEntries,
  thinHistory: () => thinHistory
});
module.exports = __toCommonJS(maintenance_exports);
var import_transfer = require("./transfer");
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
function roundTo(v, step) {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  return Number((Math.round(v / step) * step).toFixed(Math.min(decimals, 12)));
}
function thinEntries(entries, rule) {
  var _a;
  if (entries.length <= 2) {
    return entries;
  }
  let list = rule.round && rule.round > 0 ? entries.map((e) => isNum(e.val) ? { ...e, val: roundTo(e.val, rule.round) } : e) : entries;
  if (rule.changesOnly || rule.deadband && rule.deadband > 0) {
    const out = [];
    let prev;
    list.forEach((e, i) => {
      const border = i === 0 || i === list.length - 1 || e.val === null || (prev == null ? void 0 : prev.val) === null;
      const same = prev !== void 0 && (rule.deadband && rule.deadband > 0 && isNum(e.val) && isNum(prev.val) ? Math.abs(e.val - prev.val) < rule.deadband : !!rule.changesOnly && e.val === prev.val);
      if (border || !same) {
        out.push(e);
        prev = e;
      }
    });
    list = out;
  }
  if (rule.intervalMs && rule.intervalMs > 0) {
    const keep = (_a = rule.keep) != null ? _a : "avg";
    const out = [];
    let bucket = [];
    let bucketStart = 0;
    const flush = () => {
      if (!bucket.length) {
        return;
      }
      const nums = bucket.filter((e) => isNum(e.val));
      if (keep === "first" || nums.length !== bucket.length) {
        out.push(bucket[0]);
      } else if (keep === "avg") {
        const avg = nums.reduce((s, e) => s + e.val, 0) / nums.length;
        out.push({ ...bucket[0], val: rule.round ? roundTo(avg, rule.round) : Number(avg.toFixed(6)) });
      } else {
        let min = nums[0];
        let max = nums[0];
        for (const e of nums) {
          if (e.val < min.val) {
            min = e;
          }
          if (e.val > max.val) {
            max = e;
          }
        }
        out.push(...min === max ? [min] : min.ts < max.ts ? [min, max] : [max, min]);
      }
      bucket = [];
    };
    list.forEach((e, i) => {
      const border = i === 0 || i === list.length - 1 || e.val === null;
      if (border) {
        flush();
        out.push(e);
        return;
      }
      const start = Math.floor(e.ts / rule.intervalMs) * rule.intervalMs;
      if (bucket.length && start !== bucketStart) {
        flush();
      }
      bucketStart = start;
      bucket.push(e);
    });
    flush();
    list = out;
  }
  return list;
}
const backupFile = (dir, id) => `${dir}/${id.replace(/[^\w.-]/g, "_")}.json`;
function windows(range, period, end) {
  var _a, _b;
  const from = Math.max(range.start, (_a = period.start) != null ? _a : range.start);
  const to = Math.min(range.end, (_b = period.end) != null ? _b : range.end, end);
  const list = [];
  for (let w = (0, import_transfer.startOfDay)(from); w <= to; w = (0, import_transfer.nextWindow)(w)) {
    list.push({ start: Math.max(w, from), end: Math.min((0, import_transfer.nextWindow)(w) - 1, to) });
  }
  return list;
}
async function deleteHistory(backend, store, ids, period, options) {
  return processHistory(
    backend,
    store,
    ids,
    period,
    options,
    (entries) => entries.filter(() => false),
    Date.now() + 6e4
  );
}
async function thinHistory(backend, store, ids, period, rule, options) {
  return processHistory(
    backend,
    store,
    ids,
    period,
    options,
    (entries) => thinEntries(entries, rule),
    (0, import_transfer.startOfDay)(Date.now()) - 1
  );
}
async function processHistory(backend, store, ids, period, options, keep, latest) {
  var _a, _b, _c, _d, _e;
  const results = [];
  const ranges = await backend.getRanges(ids);
  for (const id of ids) {
    const range = ranges[id];
    const result = { id, before: 0, after: 0 };
    results.push(result);
    if (!range) {
      (_a = options.log) == null ? void 0 : _a.call(options, `${id}: keine Historie`);
      continue;
    }
    const saved = [];
    for (const window of windows(range, period, latest)) {
      if ((_b = options.isCancelled) == null ? void 0 : _b.call(options)) {
        (_c = options.log) == null ? void 0 : _c.call(options, `${id}: abgebrochen`);
        break;
      }
      const entries = await backend.readRange(id, window);
      const kept = keep(entries);
      result.before += entries.length;
      result.after += kept.length;
      if (options.preview || kept.length === entries.length) {
        continue;
      }
      if (options.backup) {
        saved.push(...entries);
        await store.write(backupFile(options.backupDir, id), { id, entries: saved });
      }
      await backend.deleteRange(id, window);
      if (kept.length) {
        await backend.store(id, kept);
      }
    }
    if (saved.length) {
      result.backup = backupFile(options.backupDir, id);
    }
    (_d = options.log) == null ? void 0 : _d.call(
      options,
      `${id}: ${result.before} \u2192 ${result.after} Eintr\xE4ge${options.preview ? " (Vorschau)" : ""}${result.backup ? `, gesichert in ${result.backup}` : ""}`
    );
  }
  (_e = backend.invalidate) == null ? void 0 : _e.call(backend);
  return results;
}
async function restoreHistory(backend, store, files, log) {
  var _a, _b, _c, _d, _e;
  const results = [];
  for (const file of files) {
    const data = await store.read(file);
    if (!(data == null ? void 0 : data.id) || !Array.isArray(data.entries)) {
      log == null ? void 0 : log(`${file}: keine Sicherung`);
      continue;
    }
    const sorted = [...data.entries].sort((a, b) => a.ts - b.ts);
    const range = { start: (_b = (_a = sorted[0]) == null ? void 0 : _a.ts) != null ? _b : 0, end: (_d = (_c = sorted.at(-1)) == null ? void 0 : _c.ts) != null ? _d : 0 };
    const current = await backend.readRange(data.id, range);
    const saved = new Set(sorted.map((e) => e.ts));
    const all = [...sorted, ...current.filter((e) => !saved.has(e.ts))].sort((a, b) => a.ts - b.ts);
    await backend.deleteRange(data.id, range);
    for (let i = 0; i < all.length; i += 5e3) {
      await backend.store(data.id, all.slice(i, i + 5e3));
    }
    results.push({ id: data.id, before: current.length, after: all.length });
    log == null ? void 0 : log(
      `${data.id}: ${all.length - current.length} Eintr\xE4ge wiederhergestellt (${sorted.length} aus der Sicherung)`
    );
  }
  (_e = backend.invalidate) == null ? void 0 : _e.call(backend);
  return results;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  deleteHistory,
  restoreHistory,
  roundTo,
  thinEntries,
  thinHistory
});
//# sourceMappingURL=maintenance.js.map
