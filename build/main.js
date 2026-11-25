"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_createMode = require("./lib/alias/createMode");
var import_HistoryBackend = require("./lib/history/HistoryBackend");
var import_access = require("./lib/access");
var import_MigrationRunner = require("./lib/migration/MigrationRunner");
var import_references = require("./lib/refs/references");
var import_settings = require("./lib/settings/settings");
var import_maintenance = require("./lib/history/maintenance");
const PREVIEW_RANGES_MAX_AGE = 3e5;
function idList(ids) {
  if (!Array.isArray(ids)) {
    return [];
  }
  return ids.filter(import_MigrationRunner.isValidId).slice(0, 2e3);
}
const HISTORY_BACKUP_DIR = "history-backups";
function backupDirOf(dir) {
  const d = typeof dir === "string" ? dir : "";
  if (!d.startsWith(`${HISTORY_BACKUP_DIR}/`) || d.includes("..") || d.split("/").length !== 2) {
    throw new Error("Invalid backup folder");
  }
  return d;
}
const isBackupName = (name) => /^[\w.-]+\.json$/.test(name) && !name.startsWith(".");
const stamp = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[:T]/g, "-");
function periodOf(p) {
  const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  return { start: num(p == null ? void 0 : p.start), end: num(p == null ? void 0 : p.end) };
}
function thinRuleOf(r) {
  const pos = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : void 0;
  return {
    round: pos(r == null ? void 0 : r.round),
    changesOnly: !!(r == null ? void 0 : r.changesOnly),
    deadband: pos(r == null ? void 0 : r.deadband),
    intervalMs: pos(r == null ? void 0 : r.intervalMs),
    keep: (r == null ? void 0 : r.keep) === "first" || (r == null ? void 0 : r.keep) === "minmax" ? r.keep : "avg"
  };
}
class Objectmigrator extends utils.Adapter {
  backend;
  runner;
  constructor(options = {}) {
    super({
      ...options,
      name: "objectmigrator"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    const historyInstance = this.config.historyInstance || "history.0";
    this.backend = new import_HistoryBackend.HistoryAdapterBackend(historyInstance, {
      sendTo: (instance, command, message, timeout) => this.sendToAsync(instance, command, message, { timeout }),
      getForeignState: (id) => this.getForeignStateAsync(id)
    });
    this.runner = new import_MigrationRunner.MigrationRunner(this, this.backend, {
      chunkSize: Number(this.config.chunkSize) || 5e3,
      chunkPauseMs: Number(this.config.chunkPauseMs) || 0,
      copyUninstalledSettings: this.config.copyUninstalledSettings !== false
    });
    await this.runner.init();
    if (!await this.backend.isAlive()) {
      this.log.warn(`History instance ${historyInstance} is not running - history migration is not possible`);
    }
    this.log.info(`Ready. History instance: ${historyInstance}`);
  }
  async onUnload(callback) {
    var _a;
    try {
      await ((_a = this.runner) == null ? void 0 : _a.stop());
    } catch (e) {
      this.log.error(`Error during unloading: ${e.message}`);
    }
    callback();
  }
  /** Message API for the admin tab (07 §3) */
  /**
   * Runs a delete or thin action: the IDs checked, the backup folder named, everything logged
   *
   * @param kind - for the folder and the log
   * @param msg - ids, backup, preview
   * @param msg.ids - data points
   * @param msg.backup - save the originals first (default on)
   * @param msg.preview - only count
   * @param run - the action
   */
  async maintenance(kind, msg, run) {
    const ids = idList(msg == null ? void 0 : msg.ids);
    const preview = !!(msg == null ? void 0 : msg.preview);
    const label = kind === "delete" ? "L\xF6schen" : "Ausd\xFCnnen";
    this.log.info(`Historie ${label}${preview ? " (Vorschau)" : ""}: ${ids.length} Datenpunkte`);
    return run(this.backupStore(), ids, {
      backup: (msg == null ? void 0 : msg.backup) !== false,
      backupDir: `${HISTORY_BACKUP_DIR}/${stamp()}-${kind === "delete" ? "loeschen" : "ausduennen"}`,
      preview,
      log: (text) => this.log.info(`${label}: ${text}`)
    });
  }
  /**
   * Plays back backup files: custom.json gives the adapter settings back, the other files the values
   *
   * @param files - file name → content
   */
  async restoreFiles(files) {
    const custom = files["custom.json"];
    if (custom && typeof custom === "object") {
      for (const [id, settings] of Object.entries(custom)) {
        if ((0, import_MigrationRunner.isValidId)(id) && settings && typeof settings === "object") {
          await this.extendForeignObjectAsync(id, { common: { custom: settings } });
        }
      }
      this.log.info(`Adapter-Einstellungen wiederhergestellt: ${Object.keys(custom).length} Objekte`);
    }
    const values = Object.entries(files).filter(([name]) => name !== "custom.json");
    const memory = Object.fromEntries(values);
    return (0, import_maintenance.restoreHistory)(
      this.backend,
      {
        write: () => Promise.resolve(),
        read: (path) => Promise.resolve(memory[path])
      },
      values.map(([name]) => name),
      (text) => this.log.info(`Wiederherstellen: ${text}`)
    );
  }
  /** Backup files in the files of the instance */
  backupStore() {
    return {
      write: async (path, data) => this.writeFileAsync(this.namespace, path, JSON.stringify(data)),
      read: (path) => this.readJsonFile(path)
    };
  }
  /**
   * Reads a JSON file of the instance, undefined if missing
   *
   * @param path - path in the files of the instance
   */
  async readJsonFile(path) {
    try {
      const res = await this.readFileAsync(this.namespace, path);
      return JSON.parse(res.file.toString());
    } catch {
      return void 0;
    }
  }
  /**
   * Lists a folder of the instance files, empty if missing
   *
   * @param path - folder
   */
  async readDirSafe(path) {
    try {
      return (await this.readDirAsync(this.namespace, path)).map((e) => ({ file: e.file, isDir: e.isDir }));
    } catch {
      return [];
    }
  }
  /** running long commands (job.start / job.result) */
  jobs = /* @__PURE__ */ new Map();
  handlers = {
    // ---- history
    "history.status": async () => ({
      instance: this.backend.instance,
      alive: await this.backend.isAlive()
    }),
    "history.range": async (msg) => {
      return this.backend.getRanges(idList(msg == null ? void 0 : msg.ids), (msg == null ? void 0 : msg.fresh) ? 0 : PREVIEW_RANGES_MAX_AGE);
    },
    // raw values for the preview (FR-90) - limited per ID
    "history.preview": async (msg) => {
      var _a;
      const limit = Math.min((_a = msg.limit) != null ? _a : import_HistoryBackend.MAX_RAW_PAGE, import_HistoryBackend.MAX_RAW_PAGE * 4);
      const result = {};
      for (const id of idList(msg == null ? void 0 : msg.ids)) {
        const entries = await this.backend.readRange(id, { start: Number(msg.start), end: Number(msg.end) });
        result[id] = { total: entries.length, entries: entries.slice(0, limit) };
      }
      return result;
    },
    // min/max per interval for large series (FR-95) - raw values if the range is small
    "history.aggregate": async (msg) => {
      const points = Math.min(Math.max(Number(msg.points) || 1e3, 10), 5e3);
      const ids = idList(msg == null ? void 0 : msg.ids);
      const ranges = await this.backend.getRanges(ids, PREVIEW_RANGES_MAX_AGE);
      const result = {};
      for (const id of ids) {
        const range = ranges[id];
        if (!range) {
          result[id] = { count: 0, raw: true, entries: [] };
          continue;
        }
        const window = { start: Math.max(msg.start, range.start), end: Math.min(msg.end, range.end) };
        const share = (window.end - window.start) / Math.max(1, range.end - range.start);
        if (range.count * share <= points * 2 || !this.backend.readAggregated) {
          const entries = await this.backend.readRange(id, window);
          result[id] = { count: range.count, raw: true, entries: entries.slice(0, import_HistoryBackend.MAX_RAW_PAGE * 4) };
        } else {
          const entries = await this.backend.readAggregated(id, window, points);
          result[id] = { count: range.count, raw: false, entries };
        }
      }
      return { ranges, series: result };
    },
    // ---- settings
    "settings.instances": async () => (0, import_settings.instanceStatusMap)(await this.getForeignObjectsAsync("system.adapter.*", "instance")),
    "settings.plan": async (msg) => {
      if (!(0, import_MigrationRunner.isValidId)(msg == null ? void 0 : msg.sourceId) || msg.targetId !== void 0 && !(0, import_MigrationRunner.isValidId)(msg.targetId)) {
        throw new Error("Invalid ID");
      }
      const source = await this.getForeignObjectAsync(msg.sourceId);
      if (!source) {
        throw new Error(`${msg.sourceId} not found`);
      }
      const target = msg.targetId ? await this.getForeignObjectAsync(msg.targetId) : void 0;
      const instances = (0, import_settings.instanceStatusMap)(await this.getForeignObjectsAsync("system.adapter.*", "instance"));
      return (0, import_settings.planSettings)(source, target != null ? target : void 0, instances, {
        copyUninstalled: this.config.copyUninstalledSettings !== false,
        ...msg.options
      });
    },
    // ---- create mode
    "mirror.preview": async (msg) => {
      var _a;
      const errors = (0, import_createMode.validateBasePath)(String((_a = msg == null ? void 0 : msg.basePath) != null ? _a : ""));
      if (!(0, import_MigrationRunner.isValidId)(msg == null ? void 0 : msg.sourceRoot) && !(0, import_MigrationRunner.isValidId)(`${String(msg == null ? void 0 : msg.sourceRoot)}.x`)) {
        errors.push({ code: "invalidId", args: { value: String(msg == null ? void 0 : msg.sourceRoot) } });
      }
      if (errors.length) {
        return { errors, drafts: [] };
      }
      const objects = await this.getSubtree(msg.sourceRoot);
      const root = await this.getForeignObjectAsync(msg.sourceRoot);
      if (root) {
        objects[msg.sourceRoot] = root;
      }
      const existing = await this.getSubtree(msg.basePath);
      const existingIds = new Set(Object.keys(existing));
      for (let parts = msg.basePath.split("."); parts.length > 2; parts.pop()) {
        if (await this.getForeignObjectAsync(parts.join("."))) {
          existingIds.add(parts.join("."));
        }
      }
      const drafts = (0, import_createMode.mirrorStructure)(msg.sourceRoot, objects, msg.basePath, {
        existingIds,
        onlySourceIds: msg.onlySourceIds ? new Set(idList(msg.onlySourceIds)) : void 0
      });
      return { errors: [], drafts, withSettings: (0, import_createMode.sourcesWithSettings)(drafts, objects) };
    },
    // ---- "Prüfen" / "Schreiben" (06 §5)
    "plan.check": (msg) => this.runner.check(msg),
    // ---- history maintenance (HM-20..23): count, delete a period, thin, restore, adapters off
    "history.count": async (msg) => {
      const ids = idList(msg == null ? void 0 : msg.ids);
      this.log.info(`Historie z\xE4hlen: ${ids.length} Datenpunkte`);
      return this.backend.getRanges(
        ids,
        0,
        (id, range, index) => {
          var _a;
          return this.log.info(`Historie z\xE4hlen ${index + 1}/${ids.length} ${id}: ${(_a = range == null ? void 0 : range.count) != null ? _a : 0} Eintr\xE4ge`);
        }
      );
    },
    "history.delete": async (msg) => this.maintenance(
      "delete",
      msg,
      (store, ids, options) => (0, import_maintenance.deleteHistory)(this.backend, store, ids, periodOf(msg.period), options)
    ),
    "history.thin": async (msg) => this.maintenance(
      "thin",
      msg,
      (store, ids, options) => (0, import_maintenance.thinHistory)(this.backend, store, ids, periodOf(msg.period), thinRuleOf(msg.rule), options)
    ),
    "history.backups": async () => {
      const dirs = await this.readDirSafe(HISTORY_BACKUP_DIR);
      const list = [];
      for (const dir of dirs.filter((d) => d.isDir).map((d) => d.file).sort().reverse()) {
        const filesIn = (await this.readDirSafe(`${HISTORY_BACKUP_DIR}/${dir}`)).filter((f) => !f.isDir);
        list.push({ dir: `${HISTORY_BACKUP_DIR}/${dir}`, files: filesIn.map((f) => f.file) });
      }
      return list;
    },
    "history.restore": async (msg) => {
      var _a;
      const dir = backupDirOf(msg == null ? void 0 : msg.dir);
      const files = {};
      for (const name of ((_a = msg == null ? void 0 : msg.files) != null ? _a : []).map(String).filter(isBackupName)) {
        files[name] = await this.readJsonFile(`${dir}/${name}`);
      }
      return this.restoreFiles(files);
    },
    // a downloaded backup is played back (HM-22)
    "history.restoreData": async (msg) => {
      var _a;
      return this.restoreFiles(
        Object.fromEntries(Object.entries((_a = msg == null ? void 0 : msg.files) != null ? _a : {}).filter(([name]) => isBackupName(name)))
      );
    },
    // download of a backup: all files of the folder in one object
    "history.backupGet": async (msg) => {
      const dir = backupDirOf(msg == null ? void 0 : msg.dir);
      const files = {};
      for (const f of (await this.readDirSafe(dir)).filter((e) => !e.isDir && isBackupName(e.file))) {
        files[f.file] = await this.readJsonFile(`${dir}/${f.file}`);
      }
      return { format: "objectmigrator-history-backup", dir, files };
    },
    "history.backupDelete": async (msg) => {
      const dir = backupDirOf(msg == null ? void 0 : msg.dir);
      for (const f of await this.readDirSafe(dir)) {
        await this.delFileAsync(this.namespace, `${dir}/${f.file}`);
      }
      try {
        await this.delFileAsync(this.namespace, dir);
      } catch {
      }
      this.log.info(`Sicherung gel\xF6scht: ${dir}`);
      return { deleted: dir };
    },
    "custom.disable": async (msg) => {
      var _a, _b, _c;
      const ids = idList(msg == null ? void 0 : msg.ids);
      const instances = ((_a = msg == null ? void 0 : msg.instances) != null ? _a : []).map(String).filter((k) => /^[\w-]+\.\d+$/.test(k));
      const dir = `${HISTORY_BACKUP_DIR}/${stamp()}-adapter-aus`;
      const before = {};
      let changed = 0;
      for (const id of ids) {
        const obj = await this.getForeignObjectAsync(id);
        const custom = (_b = obj == null ? void 0 : obj.common) == null ? void 0 : _b.custom;
        if (!obj || !custom) {
          continue;
        }
        const patch = {};
        for (const key of instances) {
          const settings = custom[key];
          if (!settings || settings.enabled === false) {
            continue;
          }
          ((_c = before[id]) != null ? _c : before[id] = {})[key] = settings;
          patch[key] = import_settings.HISTORY_ADAPTERS.includes(key.split(".")[0]) ? { ...settings, enabled: false } : null;
        }
        if (Object.keys(patch).length) {
          await this.extendForeignObjectAsync(id, { common: { custom: patch } });
          changed++;
        }
      }
      if ((msg == null ? void 0 : msg.backup) !== false && changed) {
        await this.writeFileAsync(this.namespace, `${dir}/custom.json`, JSON.stringify(before));
      }
      this.log.info(
        `Adapter deaktiviert (${instances.join(", ")}): ${changed} Objekte${changed && (msg == null ? void 0 : msg.backup) !== false ? `, gesichert in ${dir}` : ""}`
      );
      return { changed, backup: (msg == null ? void 0 : msg.backup) !== false && changed ? dir : void 0 };
    },
    // ---- long commands as a job: the admin answers sendTo with "timeout" after a while, so the tab
    // starts the command and asks for the result until it is there
    // eslint-disable-next-line @typescript-eslint/require-await -- handlers return promises
    "job.start": async (msg) => {
      var _a;
      const command = String((_a = msg == null ? void 0 : msg.command) != null ? _a : "");
      if (![
        "plan.check",
        "plan.write",
        "history.delete",
        "history.thin",
        "history.restore",
        "history.restoreData",
        "history.count"
      ].includes(command)) {
        throw new Error(`Command ${command} cannot run as a job`);
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const job = { done: false, at: Date.now() };
      this.jobs.set(id, job);
      void Promise.resolve(this.handlers[command](msg.message)).then((data) => Object.assign(job, { done: true, data })).catch((e) => {
        this.log.warn(`${command} failed: ${e.message}`);
        Object.assign(job, { done: true, error: e.message });
      });
      for (const [key, j] of this.jobs) {
        if (Date.now() - j.at > 6 * 36e5) {
          this.jobs.delete(key);
        }
      }
      return { id };
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- handlers return promises
    "job.result": async (msg) => {
      const job = this.jobs.get(String(msg == null ? void 0 : msg.id));
      if (!job) {
        throw new Error("Unknown job - was the instance restarted?");
      }
      if (job.done) {
        this.jobs.delete(String(msg.id));
      }
      return {
        done: job.done,
        data: job.data,
        error: job.error,
        seconds: Math.round((Date.now() - job.at) / 1e3)
      };
    },
    "plan.write": (msg) => this.runner.write(msg),
    "run.cancel": () => {
      this.runner.cancel();
      return Promise.resolve(this.runner.getCurrent());
    },
    "run.abort": () => {
      this.runner.abort();
      return Promise.resolve(this.runner.getCurrent());
    },
    "run.status": (msg) => (msg == null ? void 0 : msg.runId) ? this.runner.loadRun(msg.runId) : Promise.resolve(this.runner.getCurrent()),
    "run.list": () => this.runner.listRuns(),
    "run.rollbackPlan": (msg) => this.runner.rollbackPlan(msg == null ? void 0 : msg.runId),
    "run.rollback": (msg) => {
      if (!(0, import_MigrationRunner.isRunId)(msg == null ? void 0 : msg.runId)) {
        throw new Error("Invalid run ID");
      }
      return this.runner.rollback(msg.runId);
    },
    // ---- where are the IDs used (FR-70)
    "refs.find": async (msg) => (0, import_references.findReferences)(idList(msg == null ? void 0 : msg.ids), await this.referenceSources()),
    // DB names (aliasId) of the logging instances (FR-57) - with the values under the name at the history instance
    "dbNames.list": async () => {
      var _a, _b;
      const view = await this.getObjectViewAsync("system", "custom", {});
      const rows = [];
      for (const row of (_a = view == null ? void 0 : view.rows) != null ? _a : []) {
        const custom = (_b = row.value) != null ? _b : {};
        for (const [instance, cfg] of Object.entries(custom)) {
          const name = typeof (cfg == null ? void 0 : cfg.aliasId) === "string" ? cfg.aliasId.trim() : "";
          if (/^(history|sql|influxdb)\.\d+$/.test(instance) && name && name !== row.id) {
            rows.push({ id: row.id, instance, name, enabled: (cfg == null ? void 0 : cfg.enabled) !== false });
          }
        }
      }
      const names = rows.filter((r) => r.instance === this.backend.instance).map((r) => r.name);
      const ranges = names.length && await this.backend.isAlive() ? await this.backend.getRanges(names) : {};
      return rows.map((r) => ({ ...r, range: r.instance === this.backend.instance ? ranges[r.name] : void 0 })).sort((a, b) => a.id.localeCompare(b.id) || a.instance.localeCompare(b.instance));
    },
    // ---- templates of the create mode
    "template.list": () => this.runner.listTemplates(),
    "template.save": (msg) => this.runner.saveTemplate(msg.name, msg.template),
    "template.load": (msg) => this.runner.loadTemplate(msg.name),
    "template.delete": (msg) => this.runner.deleteTemplate(msg.name),
    // ---- drafts of the editor (WR-01)
    "plan.save": (msg) => {
      var _a;
      return this.runner.savePlan(
        String((_a = msg == null ? void 0 : msg.name) != null ? _a : "current"),
        msg == null ? void 0 : msg.plan,
        typeof (msg == null ? void 0 : msg.baseVersion) === "number" ? msg.baseVersion : void 0
      );
    },
    "plan.load": (msg) => {
      var _a;
      return this.runner.loadPlan((_a = msg == null ? void 0 : msg.name) != null ? _a : "current");
    }
  };
  /**
   * All objects below an ID. Without a type js-controller returns only states, so the four
   * structure types are read one after the other.
   *
   * @param root - parent ID
   */
  async getSubtree(root) {
    const result = {};
    for (const type of ["state", "channel", "device", "folder"]) {
      Object.assign(result, await this.getForeignObjectsAsync(`${root}.*`, type));
    }
    return result;
  }
  /** Texts of all places that may use object IDs (FR-70) */
  async referenceSources() {
    var _a;
    const sources = [];
    const name = (common) => {
      const n = common == null ? void 0 : common.name;
      return typeof n === "string" ? n : n && typeof n === "object" ? JSON.stringify(n) : void 0;
    };
    const scripts = await this.getForeignObjectsAsync("script.js.*", "script");
    for (const [id, obj] of Object.entries(scripts)) {
      const source = obj.common.source;
      if (source) {
        sources.push({
          kind: "script",
          location: id,
          name: name(obj.common),
          text: source
        });
      }
    }
    const instances = await this.getForeignObjectsAsync("system.adapter.*", "instance");
    for (const [id, obj] of Object.entries(instances)) {
      if (id === `system.adapter.${this.namespace}` || !obj.native) {
        continue;
      }
      sources.push({ kind: "instance", location: id, text: JSON.stringify(obj.native) });
      const instance = id.replace(/^system\.adapter\./, "");
      if (instance.startsWith("lovelace.")) {
        const config = await this.getForeignObjectAsync(`${instance}.configuration`);
        if (config) {
          sources.push({ kind: "lovelace", location: config._id, text: JSON.stringify((_a = config.native) != null ? _a : {}) });
        }
      }
      const adapter = instance.split(".")[0];
      if (adapter === "vis" || adapter === "vis-2") {
        try {
          const projects = await this.readDirAsync(instance, "");
          for (const project of projects.filter((p) => p.isDir)) {
            try {
              const file = await this.readFileAsync(instance, `${project.file}/vis-views.json`);
              sources.push({
                kind: "vis",
                location: `${instance}/${project.file}`,
                text: file.file.toString()
              });
            } catch {
            }
          }
        } catch {
        }
      }
    }
    const aliases = await this.getForeignObjectsAsync("alias.*", "state");
    for (const [id, obj] of Object.entries(aliases)) {
      const alias = obj.common.alias;
      if (alias) {
        sources.push({ kind: "alias", location: id, text: JSON.stringify(alias) });
      }
    }
    const enums = await this.getForeignObjectsAsync("enum.*", "enum");
    for (const [id, obj] of Object.entries(enums)) {
      const members = obj.common.members;
      if (members == null ? void 0 : members.length) {
        sources.push({
          kind: "enum",
          location: id,
          name: name(obj.common),
          text: JSON.stringify(members)
        });
      }
    }
    return sources;
  }
  async onMessage(obj) {
    if (!(obj == null ? void 0 : obj.command)) {
      return;
    }
    const handler = Object.hasOwn(this.handlers, obj.command) ? this.handlers[obj.command] : void 0;
    let response;
    if (!(0, import_access.isAllowedSender)(obj.from)) {
      this.log.warn(
        `Message "${obj.command}" from ${obj.from} rejected - only the admin may control the migrator`
      );
      response = { ok: false, error: { code: "FORBIDDEN", message: "Only the admin may control the migrator" } };
    } else if (!handler) {
      response = { ok: false, error: { code: "UNKNOWN_COMMAND", message: `Unknown command ${obj.command}` } };
    } else if (!this.backend || !this.runner) {
      response = { ok: false, error: { code: "NOT_READY", message: "Adapter is not ready yet" } };
    } else {
      const started = Date.now();
      try {
        response = { ok: true, data: await handler(obj.message) };
        if (Date.now() - started > 5e3) {
          this.log.info(`${obj.command} beantwortet nach ${Date.now() - started} ms`);
        }
      } catch (e) {
        this.log.warn(`${obj.command} failed after ${Date.now() - started} ms: ${e.message}`);
        this.log.debug(String(e.stack));
        response = { ok: false, error: { code: "FAILED", message: e.message } };
      }
    }
    if (obj.callback) {
      this.sendTo(obj.from, obj.command, response, obj.callback);
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Objectmigrator(options);
} else {
  (() => new Objectmigrator())();
}
//# sourceMappingURL=main.js.map
