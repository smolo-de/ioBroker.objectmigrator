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
var HistoryBackend_exports = {};
__export(HistoryBackend_exports, {
  DIRECT_RANGES_MAX: () => DIRECT_RANGES_MAX,
  HistoryAdapterBackend: () => HistoryAdapterBackend,
  MAX_RAW_PAGE: () => MAX_RAW_PAGE,
  historySafeId: () => historySafeId
});
module.exports = __toCommonJS(HistoryBackend_exports);
function historySafeId(id) {
  return id.replace(/[\u0000|*,;"'<>?:/\\]/g, "~");
}
const DIRECT_RANGES_MAX = 100;
const MAX_RAW_PAGE = 5e3;
class HistoryAdapterBackend {
  /**
   * @param instance - e.g. `history.0`
   * @param transport - message transport
   * @param timeoutMs - timeout per message
   */
  constructor(instance, transport, timeoutMs = 12e4) {
    this.instance = instance;
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }
  async send(command, message, timeoutMs = this.timeoutMs) {
    const answer = await this.transport.sendTo(this.instance, command, message, timeoutMs);
    if (answer === void 0 || answer === null) {
      throw new Error(`${this.instance}: no answer to "${command}"`);
    }
    if (typeof answer === "object" && answer.error) {
      throw new Error(`${this.instance}: ${command} failed: ${answer.error}`);
    }
    return answer;
  }
  async enabledDPs() {
    var _a;
    return (_a = await this.send("getEnabledDPs", {})) != null ? _a : {};
  }
  async isAlive() {
    const state = await this.transport.getForeignState(`system.adapter.${this.instance}.alive`);
    return !!(state == null ? void 0 : state.val);
  }
  async rawPage(id, options) {
    var _a;
    const answer = await this.send("getRawEntries", { id, noTotal: true, ...options });
    return ((_a = answer.result) != null ? _a : []).filter((e) => e && typeof e.ts === "number");
  }
  /**
   * Uses `getDpStatistics`: it scans all files once and has no limit. `getRawEntries` without a range
   * reads only the newest 100000 values, so it can not determine the first value of a large series.
   *
   * @param ids - state IDs
   * @param maxAgeMs - a cached result may be this old, 0 = always fresh
   * @param onEach - called for every data point asked directly (log while it takes long)
   */
  async getRanges(ids, maxAgeMs = 0, onEach) {
    var _a;
    const result = {};
    if (!ids.length) {
      return result;
    }
    const cached = maxAgeMs > 0 && this.stats && Date.now() - this.stats.at <= maxAgeMs;
    if (!cached && ids.length <= DIRECT_RANGES_MAX) {
      try {
        for (const [index, id] of ids.entries()) {
          result[id] = await this.directRange(id);
          onEach == null ? void 0 : onEach(id, result[id], index);
        }
        return result;
      } catch (e) {
        this.lastFallback = e.message;
      }
    }
    const byId = await this.statistics(maxAgeMs);
    for (const id of ids) {
      const stat = (_a = byId.get(id)) != null ? _a : byId.get(historySafeId(id));
      result[id] = stat && stat.count > 0 && stat.firstTs !== null && stat.lastTs !== null ? { start: stat.firstTs, end: stat.lastTs, count: stat.count } : void 0;
    }
    return result;
  }
  /**
   * First and last value and count of one data point via `getRawEntries` over all time - throws if the
   * adapter does not send the total or truncated the series
   *
   * @param id - state ID
   */
  async directRange(id) {
    var _a, _b, _c;
    const ask = (sort) => this.send("getRawEntries", { id, start: 0, end: Date.now() + 6e4, sort, limit: 1, offset: 0 });
    const first = await ask("asc");
    if (typeof first.total !== "number" || first.truncated) {
      throw new Error(
        `${this.instance} getRawEntries for ${id} gives no exact total (total: ${String(first.total)}, truncated: ${String(first.truncated)}, fields: ${Object.keys(first).join(", ")})`
      );
    }
    if (!first.total || !((_a = first.result) == null ? void 0 : _a.length)) {
      return void 0;
    }
    const last = await ask("desc");
    const lastTs = (_c = (_b = last.result) == null ? void 0 : _b[0]) == null ? void 0 : _c.ts;
    if (typeof lastTs !== "number") {
      throw new Error("no last value");
    }
    return { start: first.result[0].ts, end: lastTs, count: first.total };
  }
  /** Why the last direct query fell back to the full statistics (for the log), cleared when read */
  lastFallback;
  /** Statistics of all data points, cached - getDpStatistics scans all files (slow on large installations) */
  stats;
  statsPending;
  async statistics(maxAgeMs) {
    var _a;
    if (maxAgeMs > 0 && this.stats && Date.now() - this.stats.at <= maxAgeMs) {
      return this.stats.byId;
    }
    (_a = this.statsPending) != null ? _a : this.statsPending = this.send("getDpStatistics", {}, Math.max(this.timeoutMs, 6e5)).then((answer) => {
      var _a2;
      const byId = new Map(((_a2 = answer.result) != null ? _a2 : []).map((stat) => [stat.id, stat]));
      this.stats = { at: Date.now(), byId };
      return byId;
    }).finally(() => {
      this.statsPending = void 0;
    });
    return this.statsPending;
  }
  invalidate() {
    this.stats = void 0;
  }
  async readRange(id, range) {
    const all = [];
    for (let offset = 0; ; ) {
      const page = await this.rawPage(id, {
        start: range.start,
        end: range.end,
        sort: "asc",
        limit: MAX_RAW_PAGE,
        offset
      });
      if (!page.length) {
        break;
      }
      all.push(...page);
      offset += page.length;
    }
    return all.filter((e) => e.ts >= range.start && e.ts <= range.end);
  }
  async readAggregated(id, range, points) {
    var _a;
    const answer = await this.send("getHistory", {
      id,
      options: {
        start: range.start,
        end: range.end,
        aggregate: "minmax",
        count: Math.max(10, Math.min(points, 5e3)),
        ignoreNull: true,
        ack: true,
        from: true
      }
    });
    return ((_a = answer.result) != null ? _a : []).filter((e) => e && typeof e.ts === "number" && e.ts >= range.start && e.ts <= range.end).sort((a, b) => a.ts - b.ts);
  }
  async store(id, entries) {
    if (!entries.length) {
      return;
    }
    await this.send("storeState", { id, state: entries });
  }
  async deleteRange(id, range) {
    await this.send("deleteRange", [{ id, start: range.start, end: range.end }]);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DIRECT_RANGES_MAX,
  HistoryAdapterBackend,
  MAX_RAW_PAGE,
  historySafeId
});
//# sourceMappingURL=HistoryBackend.js.map
