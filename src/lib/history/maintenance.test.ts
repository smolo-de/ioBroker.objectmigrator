import { expect } from 'chai';
import type { HistoryBackend } from './HistoryBackend';
import { deleteHistory, restoreHistory, roundTo, thinEntries, thinHistory, type BackupStore } from './maintenance';
import type { DataRange, HistoryEntry, TimeRange } from './types';

/** History instance in memory */
class Fake implements HistoryBackend {
    public readonly instance = 'history.0';
    public data: Record<string, HistoryEntry[]> = {};
    public isAlive(): Promise<boolean> {
        return Promise.resolve(true);
    }
    public getRanges(ids: string[]): Promise<Record<string, DataRange | undefined>> {
        const out: Record<string, DataRange | undefined> = {};
        for (const id of ids) {
            const list = [...(this.data[id] ?? [])].sort((a, b) => a.ts - b.ts);
            out[id] = list.length ? { start: list[0].ts, end: list.at(-1)!.ts, count: list.length } : undefined;
        }
        return Promise.resolve(out);
    }
    public readRange(id: string, r: TimeRange): Promise<HistoryEntry[]> {
        return Promise.resolve(
            (this.data[id] ?? []).filter(e => e.ts >= r.start && e.ts <= r.end).sort((a, b) => a.ts - b.ts),
        );
    }
    public store(id: string, entries: HistoryEntry[]): Promise<void> {
        (this.data[id] ??= []).push(...entries);
        return Promise.resolve();
    }
    public deleteRange(id: string, r: TimeRange): Promise<void> {
        this.data[id] = (this.data[id] ?? []).filter(e => e.ts < r.start || e.ts > r.end);
        return Promise.resolve();
    }
}

/** Backup files in memory */
function files(): BackupStore & { saved: Record<string, unknown> } {
    const saved: Record<string, unknown> = {};
    return {
        saved,
        write: (path, data) => {
            saved[path] = structuredClone(data);
            return Promise.resolve();
        },
        read: <T>(path: string) => Promise.resolve(saved[path] as T | undefined),
    };
}

const DAY = 86_400_000;
const day0 = new Date(2025, 0, 6).getTime();
const e = (ts: number, val: ioBroker.StateValue): HistoryEntry => ({ ts, val, ack: true });

describe('history/maintenance', () => {
    it('roundTo has no floating point noise', () => {
        expect(roundTo(21.34, 0.1)).to.equal(21.3);
        expect(roundTo(0.1 + 0.2, 0.1)).to.equal(0.3);
        expect(roundTo(21.6, 1)).to.equal(22);
        expect(roundTo(21.3, 0.5)).to.equal(21.5);
    });

    it('thinning: rounding plus changes only keeps borders and gaps', () => {
        const list = [e(1, 21.31), e(2, 21.34), e(3, 21.36), e(4, null), e(5, 21.41), e(6, 21.44), e(7, 21.39)];
        const out = thinEntries(list, { round: 0.1, changesOnly: true });
        expect(out.map(x => x.val)).to.deep.equal([21.3, 21.4, null, 21.4, 21.4]);
        expect(out.map(x => x.ts)).to.deep.equal([1, 3, 4, 5, 7]);
    });

    it('thinning: dead band keeps only bigger changes', () => {
        const list = [e(1, 20), e(2, 20.1), e(3, 20.3), e(4, 20.35), e(5, 21)];
        expect(thinEntries(list, { deadband: 0.2 }).map(x => x.val)).to.deep.equal([20, 20.3, 21]);
    });

    it('thinning: one value per interval - average, first or min and max', () => {
        const list = [e(0, 0), e(10, 1), e(20, 5), e(30, 3), e(60, 2), e(70, 4), e(119, 9)];
        // first and last entry stay as borders, inside: interval 60
        expect(thinEntries(list, { intervalMs: 60, keep: 'avg' }).map(x => x.val)).to.deep.equal([0, 3, 3, 9]);
        expect(thinEntries(list, { intervalMs: 60, keep: 'first' }).map(x => x.val)).to.deep.equal([0, 1, 2, 9]);
        expect(thinEntries(list, { intervalMs: 60, keep: 'minmax' }).map(x => x.val)).to.deep.equal([0, 1, 5, 2, 4, 9]);
    });

    it('delete a period with backup, restore brings it back', async () => {
        const b = new Fake();
        b.data.x = Array.from({ length: 20 }, (_, i) => e(day0 + i * DAY, i));
        const store = files();
        const opts = { backup: true, backupDir: 'hb/1', preview: false };

        // preview changes nothing
        const preview = await deleteHistory(b, store, ['x'], { end: day0 + 9.5 * DAY }, { ...opts, preview: true });
        expect(preview[0]).to.deep.include({ before: 10, after: 0 });
        expect(b.data.x).to.have.length(20);

        const res = await deleteHistory(b, store, ['x'], { end: day0 + 9.5 * DAY }, opts);
        expect(res[0]).to.deep.include({ before: 10, after: 0, backup: 'hb/1/x.json' });
        expect(b.data.x.map(x => x.val)).to.deep.equal([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

        await restoreHistory(b, store, ['hb/1/x.json']);
        expect(b.data.x.sort((p, q) => p.ts - q.ts).map(x => x.val)).to.deep.equal(
            Array.from({ length: 20 }, (_, i) => i),
        );
    });

    it('delete a period in the middle - wrong values', async () => {
        const b = new Fake();
        b.data.x = Array.from({ length: 10 }, (_, i) => e(day0 + i * DAY, i));
        await deleteHistory(
            b,
            files(),
            ['x'],
            { start: day0 + 3 * DAY, end: day0 + 5 * DAY },
            {
                backup: false,
                backupDir: 'hb/2',
                preview: false,
            },
        );
        expect(b.data.x.map(x => x.val)).to.deep.equal([0, 1, 2, 6, 7, 8, 9]);
    });

    it('thinning replaces the values, restore brings back the originals', async () => {
        const b = new Fake();
        // one value per minute over 3 days
        b.data.t = Array.from({ length: 3 * 1440 }, (_, i) => e(day0 + i * 60_000, 20 + (i % 10) / 10));
        const store = files();
        const res = await thinHistory(
            b,
            store,
            ['t'],
            {},
            { intervalMs: 3_600_000, keep: 'avg' },
            {
                backup: true,
                backupDir: 'hb/3',
                preview: false,
            },
        );
        expect(res[0].before).to.equal(3 * 1440);
        expect(res[0].after).to.be.lessThan(3 * 30);
        expect(b.data.t).to.have.length(res[0].after);

        await restoreHistory(b, store, ['hb/3/t.json']);
        expect(b.data.t).to.have.length(3 * 1440);
        expect(b.data.t.sort((p, q) => p.ts - q.ts)[5].val).to.equal(20.5);
    });
});
