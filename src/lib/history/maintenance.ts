import type { HistoryBackend } from './HistoryBackend';
import { nextWindow, startOfDay } from './transfer';
import type { HistoryEntry, TimeRange } from './types';

/** What an interval keeps when thinning (HM-20) */
export type ThinKeep = 'avg' | 'first' | 'minmax';

/** Rules for thinning the history of a data point (HM-20) - applied in this order */
export interface ThinRule {
    /** round numbers to this step first, e.g. 1, 0.5, 0.1 */
    round?: number;
    /** drop a value that equals the previous kept one */
    changesOnly?: boolean;
    /** drop a number that differs less than this from the previous kept one */
    deadband?: number;
    /** at most one value (two for minmax) per interval in ms */
    intervalMs?: number;
    /** what an interval keeps - default average */
    keep?: ThinKeep;
}

/** Period of a maintenance action; open ends: from the first value / up to now */
export interface Period {
    /** from (ms), open: from the first value */
    start?: number;
    /** up to (ms), open: up to now */
    end?: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Rounds a number to a step without floating point noise (0.1 + 0.2)
 *
 * @param v - value
 * @param step - e.g. 0.1
 */
export function roundTo(v: number, step: number): number {
    const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
    return Number((Math.round(v / step) * step).toFixed(Math.min(decimals, 12)));
}

/**
 * Thins sorted entries by the rules (HM-20). The first and the last entry and every null (a gap)
 * stay, so the curve keeps its borders and gaps. Values that are no numbers are only reduced by
 * "changes only".
 *
 * @param entries - sorted ascending
 * @param rule - rules
 */
export function thinEntries(entries: HistoryEntry[], rule: ThinRule): HistoryEntry[] {
    if (entries.length <= 2) {
        return entries;
    }
    // 1. round
    let list =
        rule.round && rule.round > 0
            ? entries.map(e => (isNum(e.val) ? { ...e, val: roundTo(e.val, rule.round!) } : e))
            : entries;
    // 2. changes only / dead band
    if (rule.changesOnly || (rule.deadband && rule.deadband > 0)) {
        const out: HistoryEntry[] = [];
        let prev: HistoryEntry | undefined;
        list.forEach((e, i) => {
            const border = i === 0 || i === list.length - 1 || e.val === null || prev?.val === null;
            const same =
                prev !== undefined &&
                (rule.deadband && rule.deadband > 0 && isNum(e.val) && isNum(prev.val)
                    ? Math.abs(e.val - prev.val) < rule.deadband
                    : !!rule.changesOnly && e.val === prev.val);
            if (border || !same) {
                out.push(e);
                prev = e;
            }
        });
        list = out;
    }
    // 3. interval
    if (rule.intervalMs && rule.intervalMs > 0) {
        const keep = rule.keep ?? 'avg';
        const out: HistoryEntry[] = [];
        let bucket: HistoryEntry[] = [];
        let bucketStart = 0;
        const flush = (): void => {
            if (!bucket.length) {
                return;
            }
            const nums = bucket.filter(e => isNum(e.val));
            if (keep === 'first' || nums.length !== bucket.length) {
                out.push(bucket[0]);
            } else if (keep === 'avg') {
                const avg = nums.reduce((s, e) => s + (e.val as number), 0) / nums.length;
                out.push({ ...bucket[0], val: rule.round ? roundTo(avg, rule.round) : Number(avg.toFixed(6)) });
            } else {
                let min = nums[0];
                let max = nums[0];
                for (const e of nums) {
                    if ((e.val as number) < (min.val as number)) {
                        min = e;
                    }
                    if ((e.val as number) > (max.val as number)) {
                        max = e;
                    }
                }
                out.push(...(min === max ? [min] : min.ts < max.ts ? [min, max] : [max, min]));
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
            const start = Math.floor(e.ts / rule.intervalMs!) * rule.intervalMs!;
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

/** Progress and result of a maintenance action per data point */
export interface MaintenanceResult {
    /** data point */
    id: string;
    /** entries before */
    before: number;
    /** entries after */
    after: number;
    /** saved original values (file in the files of the instance) */
    backup?: string;
}

/** Writes and reads the backup files (files of the instance) */
export interface BackupStore {
    /** writes a JSON file */
    write(path: string, data: unknown): Promise<void>;
    /** reads a JSON file, undefined if missing */
    read<T>(path: string): Promise<T | undefined>;
}

/** Options of a delete or thin run */
export interface MaintenanceOptions {
    /** save the original values first (default on) */
    backup: boolean;
    /** folder of this action, e.g. history-backups/2026-11-25T10-00-00 */
    backupDir: string;
    /** only count, change nothing */
    preview: boolean;
    /** log line */
    log?: (text: string) => void;
    /** stop after the current week */
    isCancelled?: () => boolean;
}

/**
 * File name of the backup of one data point
 *
 * @param dir - backup folder
 * @param id - data point
 */
const backupFile = (dir: string, id: string): string => `${dir}/${id.replace(/[^\w.-]/g, '_')}.json`;

/**
 * The windows (weeks) of a period, from the first value of the data point on
 *
 * @param range - first and last value
 * @param period - chosen period, open ends allowed
 * @param end - latest end
 */
function windows(range: TimeRange, period: Period, end: number): TimeRange[] {
    const from = Math.max(range.start, period.start ?? range.start);
    const to = Math.min(range.end, period.end ?? range.end, end);
    const list: TimeRange[] = [];
    for (let w = startOfDay(from); w <= to; w = nextWindow(w)) {
        list.push({ start: Math.max(w, from), end: Math.min(nextWindow(w) - 1, to) });
    }
    return list;
}

/**
 * Deletes the history of data points in a period (HM-21) - week by week, the original values saved
 * first if wanted
 *
 * @param backend - history instance
 * @param store - backup files
 * @param ids - data points
 * @param period - open ends: from the first value / up to now
 * @param options - backup, preview, log
 */
export async function deleteHistory(
    backend: HistoryBackend,
    store: BackupStore,
    ids: string[],
    period: Period,
    options: MaintenanceOptions,
): Promise<MaintenanceResult[]> {
    return processHistory(
        backend,
        store,
        ids,
        period,
        options,
        entries => entries.filter(() => false),
        Date.now() + 60_000,
    );
}

/**
 * Thins the history of data points in a period (HM-20) - the current day is left out, the adapter
 * still writes there
 *
 * @param backend - history instance
 * @param store - backup files
 * @param ids - data points
 * @param period - open ends: from the first value / up to yesterday
 * @param rule - thinning rules
 * @param options - backup, preview, log
 */
export async function thinHistory(
    backend: HistoryBackend,
    store: BackupStore,
    ids: string[],
    period: Period,
    rule: ThinRule,
    options: MaintenanceOptions,
): Promise<MaintenanceResult[]> {
    return processHistory(
        backend,
        store,
        ids,
        period,
        options,
        entries => thinEntries(entries, rule),
        startOfDay(Date.now()) - 1,
    );
}

/**
 * Week by week: read, compute what stays, save the originals, delete the week and write what stays
 *
 * @param backend - history instance
 * @param store - backup files
 * @param ids - data points
 * @param period - period
 * @param options - options
 * @param keep - what stays of the entries of a week
 * @param latest - nothing after this point is changed
 */
async function processHistory(
    backend: HistoryBackend,
    store: BackupStore,
    ids: string[],
    period: Period,
    options: MaintenanceOptions,
    keep: (entries: HistoryEntry[]) => HistoryEntry[],
    latest: number,
): Promise<MaintenanceResult[]> {
    const results: MaintenanceResult[] = [];
    const ranges = await backend.getRanges(ids);
    for (const id of ids) {
        const range = ranges[id];
        const result: MaintenanceResult = { id, before: 0, after: 0 };
        results.push(result);
        if (!range) {
            options.log?.(`${id}: keine Historie`);
            continue;
        }
        const saved: HistoryEntry[] = [];
        for (const window of windows(range, period, latest)) {
            if (options.isCancelled?.()) {
                options.log?.(`${id}: abgebrochen`);
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
                // saved before the week is changed - a crash leaves the originals in the file
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
        options.log?.(
            `${id}: ${result.before} → ${result.after} Einträge${options.preview ? ' (Vorschau)' : ''}${
                result.backup ? `, gesichert in ${result.backup}` : ''
            }`,
        );
    }
    backend.invalidate?.();
    return results;
}

/**
 * Writes saved values back (HM-22) - values that exist again are skipped by the history adapter
 * key (ts), so restoring twice does not double them
 *
 * @param backend - history instance
 * @param store - backup files
 * @param files - backup files of the data points
 * @param log - log
 */
export async function restoreHistory(
    backend: HistoryBackend,
    store: BackupStore,
    files: string[],
    log?: (text: string) => void,
): Promise<MaintenanceResult[]> {
    const results: MaintenanceResult[] = [];
    for (const file of files) {
        const data = await store.read<{ id: string; entries: HistoryEntry[] }>(file);
        if (!data?.id || !Array.isArray(data.entries)) {
            log?.(`${file}: keine Sicherung`);
            continue;
        }
        const sorted = [...data.entries].sort((a, b) => a.ts - b.ts);
        const range = { start: sorted[0]?.ts ?? 0, end: sorted.at(-1)?.ts ?? 0 };
        // in the period of the backup the originals replace what is there (also averaged values of a
        // thinning); values that are not in the backup stay
        const current = await backend.readRange(data.id, range);
        const saved = new Set(sorted.map(e => e.ts));
        const all = [...sorted, ...current.filter(e => !saved.has(e.ts))].sort((a, b) => a.ts - b.ts);
        await backend.deleteRange(data.id, range);
        for (let i = 0; i < all.length; i += 5000) {
            await backend.store(data.id, all.slice(i, i + 5000));
        }
        results.push({ id: data.id, before: current.length, after: all.length });
        log?.(
            `${data.id}: ${all.length - current.length} Einträge wiederhergestellt (${sorted.length} aus der Sicherung)`,
        );
    }
    backend.invalidate?.();
    return results;
}
