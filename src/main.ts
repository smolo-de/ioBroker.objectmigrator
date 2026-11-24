/*
 * ioBroker.objectmigrator
 * Migrates object settings and history data to alias objects or objects of another adapter.
 * Requirements: docs/requirements/*.md
 */

import * as utils from '@iobroker/adapter-core';
import { mirrorStructure, sourcesWithSettings, validateBasePath } from './lib/alias/createMode';
import { HistoryAdapterBackend, MAX_RAW_PAGE, type HistoryBackend } from './lib/history/HistoryBackend';
import { isAllowedSender } from './lib/access';
import { isRunId, isValidId, MigrationRunner } from './lib/migration/MigrationRunner';
import { findReferences, type RefSource } from './lib/refs/references';
import type { MigrationPlan } from './lib/migration/types';
import { HISTORY_ADAPTERS, instanceStatusMap, planSettings, type SettingsOptions } from './lib/settings/settings';
import {
    deleteHistory,
    restoreHistory,
    thinHistory,
    type BackupStore,
    type Period,
    type ThinRule,
} from './lib/history/maintenance';

type Handler = (message: any) => Promise<unknown>;

/** The preview may use history ranges of the last 5 minutes (getDpStatistics scans all files) */
const PREVIEW_RANGES_MAX_AGE = 300_000;

/**
 * IDs of a message - only valid object IDs, at most 2000
 *
 * @param ids - IDs from a message
 */
function idList(ids: unknown): string[] {
    if (!Array.isArray(ids)) {
        return [];
    }
    return ids.filter(isValidId).slice(0, 2000);
}

/** Folder of the history backups in the files of the instance */
const HISTORY_BACKUP_DIR = 'history-backups';

/** Timestamp for folder names */
const stamp = (): string => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

/**
 * A period from the tab: only numbers, open ends allowed
 *
 * @param p - period
 */
function periodOf(p: Period | undefined): Period {
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return { start: num(p?.start), end: num(p?.end) };
}

/**
 * Thinning rules from the tab: only known fields with sensible numbers
 *
 * @param r - rules
 */
function thinRuleOf(r: ThinRule | undefined): ThinRule {
    const pos = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
    return {
        round: pos(r?.round),
        changesOnly: !!r?.changesOnly,
        deadband: pos(r?.deadband),
        intervalMs: pos(r?.intervalMs),
        keep: r?.keep === 'first' || r?.keep === 'minmax' ? r.keep : 'avg',
    };
}

/** A long command running in the background */
interface Job {
    done: boolean;
    at: number;
    data?: unknown;
    error?: string;
}

class Objectmigrator extends utils.Adapter {
    private backend?: HistoryBackend;
    private runner?: MigrationRunner;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'objectmigrator',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        const historyInstance = this.config.historyInstance || 'history.0';
        this.backend = new HistoryAdapterBackend(historyInstance, {
            sendTo: (instance, command, message, timeout) =>
                this.sendToAsync(instance, command, message as ioBroker.MessagePayload, { timeout }),
            getForeignState: id => this.getForeignStateAsync(id),
        });
        this.runner = new MigrationRunner(this, this.backend, {
            chunkSize: Number(this.config.chunkSize) || 5000,
            chunkPauseMs: Number(this.config.chunkPauseMs) || 0,
            copyUninstalledSettings: this.config.copyUninstalledSettings !== false,
        });
        await this.runner.init();

        if (!(await this.backend.isAlive())) {
            this.log.warn(`History instance ${historyInstance} is not running - history migration is not possible`);
        }
        this.log.info(`Ready. History instance: ${historyInstance}`);
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            await this.runner?.stop();
        } catch (e) {
            this.log.error(`Error during unloading: ${(e as Error).message}`);
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
    private async maintenance(
        kind: 'delete' | 'thin',
        msg: { ids?: string[]; backup?: boolean; preview?: boolean },
        run: (
            store: BackupStore,
            ids: string[],
            options: { backup: boolean; backupDir: string; preview: boolean; log: (t: string) => void },
        ) => Promise<unknown>,
    ): Promise<unknown> {
        const ids = idList(msg?.ids);
        const preview = !!msg?.preview;
        const label = kind === 'delete' ? 'Löschen' : 'Ausdünnen';
        this.log.info(`Historie ${label}${preview ? ' (Vorschau)' : ''}: ${ids.length} Datenpunkte`);
        return run(this.backupStore(), ids, {
            backup: msg?.backup !== false,
            backupDir: `${HISTORY_BACKUP_DIR}/${stamp()}-${kind === 'delete' ? 'loeschen' : 'ausduennen'}`,
            preview,
            log: text => this.log.info(`${label}: ${text}`),
        });
    }

    /** Backup files in the files of the instance */
    private backupStore(): BackupStore {
        return {
            write: async (path, data) => this.writeFileAsync(this.namespace, path, JSON.stringify(data)),
            read: <T>(path: string) => this.readJsonFile<T>(path),
        };
    }

    /**
     * Reads a JSON file of the instance, undefined if missing
     *
     * @param path - path in the files of the instance
     */
    private async readJsonFile<T>(path: string): Promise<T | undefined> {
        try {
            const res = await this.readFileAsync(this.namespace, path);
            return JSON.parse(res.file.toString()) as T;
        } catch {
            return undefined;
        }
    }

    /**
     * Lists a folder of the instance files, empty if missing
     *
     * @param path - folder
     */
    private async readDirSafe(path: string): Promise<{ file: string; isDir: boolean }[]> {
        try {
            return (await this.readDirAsync(this.namespace, path)).map(e => ({ file: e.file, isDir: e.isDir }));
        } catch {
            return [];
        }
    }

    /** running long commands (job.start / job.result) */
    private readonly jobs = new Map<string, Job>();

    private readonly handlers: Record<string, Handler> = {
        // ---- history
        'history.status': async () => ({
            instance: this.backend!.instance,
            alive: await this.backend!.isAlive(),
        }),
        'history.range': async (msg: { ids: string[]; fresh?: boolean }) => {
            return this.backend!.getRanges(idList(msg?.ids), msg?.fresh ? 0 : PREVIEW_RANGES_MAX_AGE);
        },
        // raw values for the preview (FR-90) - limited per ID
        'history.preview': async (msg: { ids: string[]; start: number; end: number; limit?: number }) => {
            const limit = Math.min(msg.limit ?? MAX_RAW_PAGE, MAX_RAW_PAGE * 4);
            const result: Record<string, unknown> = {};
            for (const id of idList(msg?.ids)) {
                const entries = await this.backend!.readRange(id, { start: Number(msg.start), end: Number(msg.end) });
                result[id] = { total: entries.length, entries: entries.slice(0, limit) };
            }
            return result;
        },

        // min/max per interval for large series (FR-95) - raw values if the range is small
        'history.aggregate': async (msg: { ids: string[]; start: number; end: number; points?: number }) => {
            const points = Math.min(Math.max(Number(msg.points) || 1000, 10), 5000);
            const ids = idList(msg?.ids);
            const ranges = await this.backend!.getRanges(ids, PREVIEW_RANGES_MAX_AGE);
            const result: Record<string, { count: number; raw: boolean; entries: unknown[] }> = {};
            for (const id of ids) {
                const range = ranges[id];
                if (!range) {
                    result[id] = { count: 0, raw: true, entries: [] };
                    continue;
                }
                const window = { start: Math.max(msg.start, range.start), end: Math.min(msg.end, range.end) };
                // a small part of the series: raw values (the count is only known for the whole series)
                const share = (window.end - window.start) / Math.max(1, range.end - range.start);
                if (range.count * share <= points * 2 || !this.backend!.readAggregated) {
                    const entries = await this.backend!.readRange(id, window);
                    result[id] = { count: range.count, raw: true, entries: entries.slice(0, MAX_RAW_PAGE * 4) };
                } else {
                    const entries = await this.backend!.readAggregated(id, window, points);
                    result[id] = { count: range.count, raw: false, entries };
                }
            }
            return { ranges, series: result };
        },

        // ---- settings
        'settings.instances': async () =>
            instanceStatusMap(await this.getForeignObjectsAsync('system.adapter.*', 'instance')),
        'settings.plan': async (msg: { sourceId: string; targetId?: string; options?: SettingsOptions }) => {
            if (!isValidId(msg?.sourceId) || (msg.targetId !== undefined && !isValidId(msg.targetId))) {
                throw new Error('Invalid ID');
            }
            const source = await this.getForeignObjectAsync(msg.sourceId);
            if (!source) {
                throw new Error(`${msg.sourceId} not found`);
            }
            const target = msg.targetId ? await this.getForeignObjectAsync(msg.targetId) : undefined;
            const instances = instanceStatusMap(await this.getForeignObjectsAsync('system.adapter.*', 'instance'));
            return planSettings(source, target ?? undefined, instances, {
                copyUninstalled: this.config.copyUninstalledSettings !== false,
                ...msg.options,
            });
        },

        // ---- create mode
        'mirror.preview': async (msg: { sourceRoot: string; basePath: string; onlySourceIds?: string[] }) => {
            const errors = validateBasePath(String(msg?.basePath ?? ''));
            // the source root may be a top level like "hm-rpc" (all instances) - only read
            if (!isValidId(msg?.sourceRoot) && !isValidId(`${String(msg?.sourceRoot)}.x`)) {
                errors.push({ code: 'invalidId', args: { value: String(msg?.sourceRoot) } });
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
            for (let parts = msg.basePath.split('.'); parts.length > 2; parts.pop()) {
                if (await this.getForeignObjectAsync(parts.join('.'))) {
                    existingIds.add(parts.join('.'));
                }
            }
            const drafts = mirrorStructure(msg.sourceRoot, objects, msg.basePath, {
                existingIds,
                onlySourceIds: msg.onlySourceIds ? new Set(idList(msg.onlySourceIds)) : undefined,
            });
            // the tab links on request only the values with adapter settings (EM-14)
            return { errors: [], drafts, withSettings: sourcesWithSettings(drafts, objects) };
        },

        // ---- "Prüfen" / "Schreiben" (06 §5)
        'plan.check': (msg: MigrationPlan) => this.runner!.check(msg),

        // ---- history maintenance (HM-20..23): count, delete a period, thin, restore, adapters off
        'history.count': async (msg: { ids?: string[] }) => {
            const ids = idList(msg?.ids);
            this.log.info(`Historie zählen: ${ids.length} Datenpunkte`);
            return this.backend!.getRanges(ids, 0, (id, range, index) =>
                this.log.info(`Historie zählen ${index + 1}/${ids.length} ${id}: ${range?.count ?? 0} Einträge`),
            );
        },
        'history.delete': async (msg: { ids?: string[]; period?: Period; backup?: boolean; preview?: boolean }) =>
            this.maintenance('delete', msg, (store, ids, options) =>
                deleteHistory(this.backend!, store, ids, periodOf(msg.period), options),
            ),
        'history.thin': async (msg: {
            ids?: string[];
            period?: Period;
            rule?: ThinRule;
            backup?: boolean;
            preview?: boolean;
        }) =>
            this.maintenance('thin', msg, (store, ids, options) =>
                thinHistory(this.backend!, store, ids, periodOf(msg.period), thinRuleOf(msg.rule), options),
            ),
        'history.backups': async () => {
            const dirs = await this.readDirSafe(HISTORY_BACKUP_DIR);
            const list = [];
            for (const dir of dirs
                .filter(d => d.isDir)
                .map(d => d.file)
                .sort()
                .reverse()) {
                const filesIn = (await this.readDirSafe(`${HISTORY_BACKUP_DIR}/${dir}`)).filter(f => !f.isDir);
                list.push({ dir: `${HISTORY_BACKUP_DIR}/${dir}`, files: filesIn.map(f => f.file) });
            }
            return list;
        },
        'history.restore': async (msg: { dir?: string; files?: string[] }) => {
            const dir = String(msg?.dir ?? '');
            if (!dir.startsWith(`${HISTORY_BACKUP_DIR}/`) || dir.includes('..')) {
                throw new Error('Invalid backup folder');
            }
            const names = (msg?.files ?? []).map(String).filter(n => /^[\w.-]+\.json$/.test(n) && n !== 'custom.json');
            const custom = await this.readJsonFile<Record<string, Record<string, unknown>>>(`${dir}/custom.json`);
            if (custom) {
                // adapter settings switched off with this action come back
                for (const [id, settings] of Object.entries(custom)) {
                    await this.extendForeignObjectAsync(id, { common: { custom: settings } });
                }
                this.log.info(`Adapter-Einstellungen wiederhergestellt: ${Object.keys(custom).length} Objekte`);
            }
            return restoreHistory(
                this.backend!,
                this.backupStore(),
                names.map(n => `${dir}/${n}`),
                text => this.log.info(`Wiederherstellen: ${text}`),
            );
        },
        'custom.disable': async (msg: { ids?: string[]; instances?: string[]; backup?: boolean }) => {
            const ids = idList(msg?.ids);
            const instances = (msg?.instances ?? []).map(String).filter(k => /^[\w-]+\.\d+$/.test(k));
            const dir = `${HISTORY_BACKUP_DIR}/${stamp()}-adapter-aus`;
            const before: Record<string, Record<string, unknown>> = {};
            let changed = 0;
            for (const id of ids) {
                const obj = await this.getForeignObjectAsync(id);
                const custom = (obj?.common as { custom?: Record<string, Record<string, unknown> | null> } | undefined)
                    ?.custom;
                if (!obj || !custom) {
                    continue;
                }
                const patch: Record<string, Record<string, unknown> | null> = {};
                for (const key of instances) {
                    const settings = custom[key];
                    if (!settings || settings.enabled === false) {
                        continue;
                    }
                    (before[id] ??= {})[key] = settings;
                    // history adapters evaluate "enabled"; the others (lovelace, ...) treat every entry as
                    // active - the admin removes it when switched off, so does this
                    patch[key] = HISTORY_ADAPTERS.includes(key.split('.')[0]) ? { ...settings, enabled: false } : null;
                }
                if (Object.keys(patch).length) {
                    await this.extendForeignObjectAsync(id, { common: { custom: patch } });
                    changed++;
                }
            }
            if (msg?.backup !== false && changed) {
                await this.writeFileAsync(this.namespace, `${dir}/custom.json`, JSON.stringify(before));
            }
            this.log.info(
                `Adapter deaktiviert (${instances.join(', ')}): ${changed} Objekte${changed && msg?.backup !== false ? `, gesichert in ${dir}` : ''}`,
            );
            return { changed, backup: msg?.backup !== false && changed ? dir : undefined };
        },

        // ---- long commands as a job: the admin answers sendTo with "timeout" after a while, so the tab
        // starts the command and asks for the result until it is there
        // eslint-disable-next-line @typescript-eslint/require-await -- handlers return promises
        'job.start': async (msg: { command?: string; message?: unknown }) => {
            const command = String(msg?.command ?? '');
            if (!['plan.check', 'plan.write', 'history.delete', 'history.thin', 'history.restore'].includes(command)) {
                throw new Error(`Command ${command} cannot run as a job`);
            }
            const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const job: Job = { done: false, at: Date.now() };
            this.jobs.set(id, job);
            void Promise.resolve(this.handlers[command](msg.message))
                .then(data => Object.assign(job, { done: true, data }))
                .catch((e: Error) => {
                    this.log.warn(`${command} failed: ${e.message}`);
                    Object.assign(job, { done: true, error: e.message });
                });
            // forget old jobs
            for (const [key, j] of this.jobs) {
                if (Date.now() - j.at > 6 * 3600_000) {
                    this.jobs.delete(key);
                }
            }
            return { id };
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- handlers return promises
        'job.result': async (msg: { id?: string }) => {
            const job = this.jobs.get(String(msg?.id));
            if (!job) {
                throw new Error('Unknown job - was the instance restarted?');
            }
            if (job.done) {
                this.jobs.delete(String(msg.id));
            }
            return {
                done: job.done,
                data: job.data,
                error: job.error,
                seconds: Math.round((Date.now() - job.at) / 1000),
            };
        },
        'plan.write': (msg: MigrationPlan) => this.runner!.write(msg),
        'run.cancel': () => {
            this.runner!.cancel();
            return Promise.resolve(this.runner!.getCurrent());
        },
        'run.abort': () => {
            this.runner!.abort();
            return Promise.resolve(this.runner!.getCurrent());
        },
        'run.status': (msg?: { runId?: string }) =>
            msg?.runId ? this.runner!.loadRun(msg.runId) : Promise.resolve(this.runner!.getCurrent()),
        'run.list': () => this.runner!.listRuns(),
        'run.rollbackPlan': (msg: { runId: string }) => this.runner!.rollbackPlan(msg?.runId),
        'run.rollback': (msg: { runId: string }) => {
            if (!isRunId(msg?.runId)) {
                throw new Error('Invalid run ID');
            }
            return this.runner!.rollback(msg.runId);
        },

        // ---- where are the IDs used (FR-70)
        'refs.find': async (msg: { ids: string[] }) => findReferences(idList(msg?.ids), await this.referenceSources()),
        // DB names (aliasId) of the logging instances (FR-57) - with the values under the name at the history instance
        'dbNames.list': async () => {
            const view = await this.getObjectViewAsync('system', 'custom', {});
            const rows: { id: string; instance: string; name: string; enabled: boolean }[] = [];
            for (const row of view?.rows ?? []) {
                const custom = (row.value ?? {}) as Record<string, { aliasId?: unknown; enabled?: unknown } | null>;
                for (const [instance, cfg] of Object.entries(custom)) {
                    const name = typeof cfg?.aliasId === 'string' ? cfg.aliasId.trim() : '';
                    if (/^(history|sql|influxdb)\.\d+$/.test(instance) && name && name !== row.id) {
                        rows.push({ id: row.id, instance, name, enabled: cfg?.enabled !== false });
                    }
                }
            }
            const names = rows.filter(r => r.instance === this.backend!.instance).map(r => r.name);
            const ranges = names.length && (await this.backend!.isAlive()) ? await this.backend!.getRanges(names) : {};
            return rows
                .map(r => ({ ...r, range: r.instance === this.backend!.instance ? ranges[r.name] : undefined }))
                .sort((a, b) => a.id.localeCompare(b.id) || a.instance.localeCompare(b.instance));
        },

        // ---- templates of the create mode
        'template.list': () => this.runner!.listTemplates(),
        'template.save': (msg: { name: string; template: unknown }) =>
            this.runner!.saveTemplate(msg.name, msg.template),
        'template.load': (msg: { name: string }) => this.runner!.loadTemplate(msg.name),
        'template.delete': (msg: { name: string }) => this.runner!.deleteTemplate(msg.name),

        // ---- drafts of the editor (WR-01)
        'plan.save': (msg: { name?: string; plan: unknown; baseVersion?: number }) =>
            this.runner!.savePlan(
                String(msg?.name ?? 'current'),
                msg?.plan,
                typeof msg?.baseVersion === 'number' ? msg.baseVersion : undefined,
            ),
        'plan.load': (msg?: { name?: string }) => this.runner!.loadPlan(msg?.name ?? 'current'),
    };

    /**
     * All objects below an ID. Without a type js-controller returns only states, so the four
     * structure types are read one after the other.
     *
     * @param root - parent ID
     */
    private async getSubtree(root: string): Promise<Record<string, ioBroker.Object>> {
        const result: Record<string, ioBroker.Object> = {};
        for (const type of ['state', 'channel', 'device', 'folder'] as const) {
            Object.assign(result, await this.getForeignObjectsAsync(`${root}.*`, type));
        }
        return result;
    }

    /** Texts of all places that may use object IDs (FR-70) */
    private async referenceSources(): Promise<RefSource[]> {
        const sources: RefSource[] = [];
        const name = (common: Record<string, unknown> | undefined): string | undefined => {
            const n = common?.name;
            return typeof n === 'string' ? n : n && typeof n === 'object' ? JSON.stringify(n) : undefined;
        };
        const scripts = await this.getForeignObjectsAsync('script.js.*', 'script');
        for (const [id, obj] of Object.entries(scripts)) {
            const source = (obj.common as { source?: string }).source;
            if (source) {
                sources.push({
                    kind: 'script',
                    location: id,
                    name: name(obj.common as unknown as Record<string, unknown>),
                    text: source,
                });
            }
        }
        const instances = await this.getForeignObjectsAsync('system.adapter.*', 'instance');
        for (const [id, obj] of Object.entries(instances)) {
            if (id === `system.adapter.${this.namespace}` || !obj.native) {
                continue;
            }
            sources.push({ kind: 'instance', location: id, text: JSON.stringify(obj.native) });
            const instance = id.replace(/^system\.adapter\./, '');
            // lovelace keeps its dashboards in <instance>.configuration
            if (instance.startsWith('lovelace.')) {
                const config = await this.getForeignObjectAsync(`${instance}.configuration`);
                if (config) {
                    sources.push({ kind: 'lovelace', location: config._id, text: JSON.stringify(config.native ?? {}) });
                }
            }
            // VIS / VIS-2 projects
            const adapter = instance.split('.')[0];
            if (adapter === 'vis' || adapter === 'vis-2') {
                try {
                    const projects = await this.readDirAsync(instance, '');
                    for (const project of projects.filter(p => p.isDir)) {
                        try {
                            const file = await this.readFileAsync(instance, `${project.file}/vis-views.json`);
                            sources.push({
                                kind: 'vis',
                                location: `${instance}/${project.file}`,
                                text: file.file.toString(),
                            });
                        } catch {
                            // project without views
                        }
                    }
                } catch {
                    // no projects
                }
            }
        }
        const aliases = await this.getForeignObjectsAsync('alias.*', 'state');
        for (const [id, obj] of Object.entries(aliases)) {
            const alias = obj.common.alias;
            if (alias) {
                sources.push({ kind: 'alias', location: id, text: JSON.stringify(alias) });
            }
        }
        const enums = await this.getForeignObjectsAsync('enum.*', 'enum');
        for (const [id, obj] of Object.entries(enums)) {
            const members = obj.common.members;
            if (members?.length) {
                sources.push({
                    kind: 'enum',
                    location: id,
                    name: name(obj.common as unknown as Record<string, unknown>),
                    text: JSON.stringify(members),
                });
            }
        }
        return sources;
    }

    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (!obj?.command) {
            return;
        }
        const handler = Object.hasOwn(this.handlers, obj.command) ? this.handlers[obj.command] : undefined;
        let response: unknown;
        if (!isAllowedSender(obj.from)) {
            this.log.warn(
                `Message "${obj.command}" from ${obj.from} rejected - only the admin may control the migrator`,
            );
            response = { ok: false, error: { code: 'FORBIDDEN', message: 'Only the admin may control the migrator' } };
        } else if (!handler) {
            response = { ok: false, error: { code: 'UNKNOWN_COMMAND', message: `Unknown command ${obj.command}` } };
        } else if (!this.backend || !this.runner) {
            response = { ok: false, error: { code: 'NOT_READY', message: 'Adapter is not ready yet' } };
        } else {
            const started = Date.now();
            try {
                response = { ok: true, data: await handler(obj.message) };
                if (Date.now() - started > 5000) {
                    this.log.info(`${obj.command} beantwortet nach ${Date.now() - started} ms`);
                }
            } catch (e) {
                this.log.warn(`${obj.command} failed after ${Date.now() - started} ms: ${(e as Error).message}`);
                this.log.debug(String((e as Error).stack));
                response = { ok: false, error: { code: 'FAILED', message: (e as Error).message } };
            }
        }
        if (obj.callback) {
            this.sendTo(obj.from, obj.command, response as ioBroker.MessagePayload, obj.callback);
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Objectmigrator(options);
} else {
    // otherwise start the instance directly
    (() => new Objectmigrator())();
}
