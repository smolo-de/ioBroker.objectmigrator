import {
    Alert,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    FormControlLabel,
    LinearProgress,
    MenuItem,
    TextField,
} from '@mui/material';
import React from 'react';
import type { Connection } from '../connection';
import { t } from '../i18n';

/** Range of a data point as the adapter answers */
interface Range {
    start: number;
    end: number;
    count: number;
}

/** Result of a delete/thin action per data point */
interface Result {
    id: string;
    before: number;
    after: number;
    backup?: string;
}

/** A backup folder */
interface Backup {
    dir: string;
    files: string[];
}

const fmtDate = (ts: number): string => new Date(ts).toLocaleDateString();
const fmtNum = (n: number): string => n.toLocaleString();

/**
 * Local midnight of an <input type="date"> value
 *
 * @param value - yyyy-mm-dd
 * @param endOfDay - the last ms of that day
 */
function dateTs(value: string, endOfDay = false): number | undefined {
    if (!value) {
        return undefined;
    }
    const [y, m, d] = value.split('-').map(Number);
    const ts = new Date(y, m - 1, d).getTime();
    return endOfDay ? new Date(y, m - 1, d + 1).getTime() - 1 : ts;
}

const INTERVALS: [number, string][] = [
    [0, 'thinIntervalNone'],
    [1000, '1 s'],
    [10_000, '10 s'],
    [60_000, '1 min'],
    [300_000, '5 min'],
    [900_000, '15 min'],
    [3_600_000, '1 h'],
];
const ROUNDS: [number, string][] = [
    [0, 'thinRoundNone'],
    [1, '1'],
    [0.5, '0,5'],
    [0.1, '0,1'],
    [0.01, '0,01'],
];

/**
 * "Historie & Adapter" (HM-20..23): count the entries of the selected values, delete a period, thin,
 * restore a backup, switch adapters off - each with preview, backup (default on) and log
 *
 * @param props - component props
 * @param props.socket - connection to the adapter
 * @param props.ids - selected values (the values below a selected node included)
 * @param props.customKeys - adapter instances with settings at these values
 * @param props.disabled - a migration is running
 */
export function HistoryTools(props: {
    socket: Connection;
    ids: string[];
    customKeys: string[];
    disabled?: boolean;
}): React.JSX.Element | null {
    const [open, setOpen] = React.useState(false);
    const [busy, setBusy] = React.useState<string>();
    const [error, setError] = React.useState<string>();
    const [counts, setCounts] = React.useState<Record<string, Range | undefined>>();
    const [from, setFrom] = React.useState('');
    const [to, setTo] = React.useState('');
    const [backup, setBackup] = React.useState(true);
    const [round, setRound] = React.useState(0);
    const [changesOnly, setChangesOnly] = React.useState(false);
    const [deadband, setDeadband] = React.useState('');
    const [interval, setInterval] = React.useState(60_000);
    const [keep, setKeep] = React.useState<'avg' | 'first' | 'minmax'>('avg');
    const [preview, setPreview] = React.useState<{ kind: 'delete' | 'thin'; results: Result[] }>();
    const [confirm, setConfirm] = React.useState<{ kind: 'delete' | 'thin' | 'custom'; text: string }>();
    const [instances, setInstances] = React.useState<Set<string>>(new Set());
    const [backups, setBackups] = React.useState<Backup[]>();
    const [done, setDone] = React.useState<string>();

    const key = props.ids.join('|');
    React.useEffect(() => {
        setCounts(undefined);
        setPreview(undefined);
        setDone(undefined);
        setError(undefined);
    }, [key]);

    if (!props.ids.length) {
        return null;
    }
    const period = { start: dateTs(from), end: dateTs(to, true) };
    const rule = {
        round: round || undefined,
        changesOnly,
        deadband: Number(deadband.replace(',', '.')) || undefined,
        intervalMs: interval || undefined,
        keep,
    };
    const run = async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
        setBusy(label);
        setError(undefined);
        setDone(undefined);
        try {
            return await fn();
        } catch (e) {
            setError((e as Error).message);
            return undefined;
        } finally {
            setBusy(undefined);
        }
    };
    const count = (): void =>
        void run(t('htCount'), () =>
            props.socket.send<Record<string, Range | undefined>>('history.count', { ids: props.ids }),
        ).then(r => r && setCounts(r));
    const doPreview = (kind: 'delete' | 'thin'): void =>
        void run(t('htPreview'), () =>
            props.socket.sendLong<Result[]>(kind === 'delete' ? 'history.delete' : 'history.thin', {
                ids: props.ids,
                period,
                rule,
                preview: true,
            }),
        ).then(results => results && setPreview({ kind, results }));
    const execute = (kind: 'delete' | 'thin'): void =>
        void run(kind === 'delete' ? t('htDelete') : t('htThin'), () =>
            props.socket.sendLong<Result[]>(kind === 'delete' ? 'history.delete' : 'history.thin', {
                ids: props.ids,
                period,
                rule,
                backup,
                preview: false,
            }),
        ).then(results => {
            if (results) {
                const before = results.reduce((s, r) => s + r.before, 0);
                const after = results.reduce((s, r) => s + r.after, 0);
                setDone(t('htDone', { before: fmtNum(before), after: fmtNum(after) }));
                setPreview(undefined);
                setCounts(undefined);
            }
        });
    const disableCustom = (): void =>
        void run(t('htCustomOff'), () =>
            props.socket.send<{ changed: number; backup?: string }>('custom.disable', {
                ids: props.ids,
                instances: [...instances],
                backup,
            }),
        ).then(r => r && setDone(t('htCustomDone', { n: r.changed })));
    const loadBackups = (): void =>
        void run(t('htBackups'), () => props.socket.send<Backup[]>('history.backups', {})).then(
            list => list && setBackups(list),
        );
    const restore = (b: Backup): void =>
        void run(t('htRestore'), () =>
            props.socket.sendLong<Result[]>('history.restore', { dir: b.dir, files: b.files }),
        ).then(r => r && setDone(t('htRestored', { n: r.length })));

    const sum = (list: Result[], field: 'before' | 'after'): number => list.reduce((s, r) => s + r[field], 0);
    const periodText = `${from ? fmtDate(dateTs(from)!) : t('htFromFirst')} – ${to ? fmtDate(dateTs(to)!) : t('htToNow')}`;

    return (
        <div className="om-panel om-history-tools">
            <h4
                className="om-clickable"
                onClick={() => setOpen(!open)}
            >
                {open ? '▾' : '▸'} 🧹 {t('htTitle')} <span className="om-chip">{props.ids.length}</span>
            </h4>
            {open && (
                <>
                    {busy && (
                        <div>
                            <span className="om-muted">{busy} …</span>
                            <LinearProgress />
                        </div>
                    )}
                    {error && <Alert severity="error">{error}</Alert>}
                    {done && <Alert severity="success">{done}</Alert>}

                    {/* ---- count */}
                    <div className="om-ht-block">
                        <Button
                            size="small"
                            variant="outlined"
                            disabled={!!busy}
                            onClick={count}
                        >
                            # {t('htCount')}
                        </Button>
                        {counts && (
                            <table className="om-table om-ht-table">
                                <tbody>
                                    {props.ids.map(id => (
                                        <tr key={id}>
                                            <td className="om-ellipsis">{id}</td>
                                            <td>{fmtNum(counts[id]?.count ?? 0)}</td>
                                            <td className="om-muted">
                                                {counts[id]
                                                    ? `${fmtDate(counts[id].start)} – ${fmtDate(counts[id].end)}`
                                                    : '–'}
                                            </td>
                                        </tr>
                                    ))}
                                    <tr>
                                        <td>
                                            <b>{t('htSum')}</b>
                                        </td>
                                        <td>
                                            <b>
                                                {fmtNum(Object.values(counts).reduce((s, r) => s + (r?.count ?? 0), 0))}
                                            </b>
                                        </td>
                                        <td />
                                    </tr>
                                </tbody>
                            </table>
                        )}
                    </div>

                    {/* ---- period and backup: shared by delete and thin */}
                    <div className="om-ht-block">
                        <b>{t('htPeriod')}</b>
                        <div className="om-ht-row">
                            <TextField
                                type="date"
                                size="small"
                                label={t('htFrom')}
                                value={from}
                                onChange={e => setFrom(e.target.value)}
                                slotProps={{ inputLabel: { shrink: true } }}
                                helperText={from ? '' : t('htFromFirst')}
                            />
                            <TextField
                                type="date"
                                size="small"
                                label={t('htTo')}
                                value={to}
                                onChange={e => setTo(e.target.value)}
                                slotProps={{ inputLabel: { shrink: true } }}
                                helperText={to ? '' : t('htToNow')}
                            />
                        </div>
                        <FormControlLabel
                            control={
                                <Checkbox
                                    size="small"
                                    checked={backup}
                                    onChange={e => setBackup(e.target.checked)}
                                />
                            }
                            label={t('htBackup')}
                        />
                    </div>

                    {/* ---- delete */}
                    <div className="om-ht-block">
                        <b>🗑 {t('htDelete')}</b>
                        <div className="om-muted">{t('htDeleteHelp')}</div>
                        <div className="om-ht-row">
                            <Button
                                size="small"
                                disabled={!!busy || props.disabled}
                                onClick={() => doPreview('delete')}
                            >
                                {t('htPreview')}
                            </Button>
                        </div>
                    </div>

                    {/* ---- thin */}
                    <div className="om-ht-block">
                        <b>✂ {t('htThin')}</b>
                        <div className="om-muted">{t('htThinHelp')}</div>
                        <div className="om-ht-row">
                            <TextField
                                select
                                size="small"
                                label={t('thinRound')}
                                value={round}
                                onChange={e => setRound(Number(e.target.value))}
                            >
                                {ROUNDS.map(([v, l]) => (
                                    <MenuItem
                                        key={v}
                                        value={v}
                                    >
                                        {v ? l : t(l as 'thinRoundNone')}
                                    </MenuItem>
                                ))}
                            </TextField>
                            <TextField
                                size="small"
                                label={t('thinDeadband')}
                                value={deadband}
                                onChange={e => setDeadband(e.target.value)}
                                placeholder="0,2"
                            />
                        </div>
                        <FormControlLabel
                            control={
                                <Checkbox
                                    size="small"
                                    checked={changesOnly}
                                    onChange={e => setChangesOnly(e.target.checked)}
                                />
                            }
                            label={t('thinChangesOnly')}
                        />
                        <div className="om-ht-row">
                            <TextField
                                select
                                size="small"
                                label={t('thinInterval')}
                                value={interval}
                                onChange={e => setInterval(Number(e.target.value))}
                            >
                                {INTERVALS.map(([v, l]) => (
                                    <MenuItem
                                        key={v}
                                        value={v}
                                    >
                                        {v ? l : t(l as 'thinRoundNone')}
                                    </MenuItem>
                                ))}
                            </TextField>
                            <TextField
                                select
                                size="small"
                                label={t('thinKeep')}
                                value={keep}
                                disabled={!interval}
                                onChange={e => setKeep(e.target.value as 'avg' | 'first' | 'minmax')}
                            >
                                <MenuItem value="avg">{t('thinKeepAvg')}</MenuItem>
                                <MenuItem value="first">{t('thinKeepFirst')}</MenuItem>
                                <MenuItem value="minmax">{t('thinKeepMinMax')}</MenuItem>
                            </TextField>
                        </div>
                        <div className="om-ht-row">
                            <Button
                                size="small"
                                disabled={
                                    !!busy ||
                                    props.disabled ||
                                    (!rule.round && !changesOnly && !rule.deadband && !interval)
                                }
                                onClick={() => doPreview('thin')}
                            >
                                {t('htPreview')}
                            </Button>
                        </div>
                    </div>

                    {preview && (
                        <div className="om-ht-block om-ht-preview">
                            <b>
                                {preview.kind === 'delete' ? t('htDelete') : t('htThin')} – {t('htPreview')} (
                                {periodText})
                            </b>
                            <table className="om-table om-ht-table">
                                <tbody>
                                    {preview.results.map(r => (
                                        <tr key={r.id}>
                                            <td className="om-ellipsis">{r.id}</td>
                                            <td>
                                                {fmtNum(r.before)} → {fmtNum(r.after)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <div>
                                {t('htPreviewSum', {
                                    before: fmtNum(sum(preview.results, 'before')),
                                    after: fmtNum(sum(preview.results, 'after')),
                                    removed: fmtNum(sum(preview.results, 'before') - sum(preview.results, 'after')),
                                })}
                            </div>
                            <Button
                                size="small"
                                color="error"
                                variant="contained"
                                disabled={
                                    !!busy ||
                                    props.disabled ||
                                    sum(preview.results, 'before') === sum(preview.results, 'after')
                                }
                                onClick={() =>
                                    setConfirm({
                                        kind: preview.kind,
                                        text: t(preview.kind === 'delete' ? 'htConfirmDelete' : 'htConfirmThin', {
                                            removed: fmtNum(
                                                sum(preview.results, 'before') - sum(preview.results, 'after'),
                                            ),
                                            n: preview.results.length,
                                            period: periodText,
                                        }),
                                    })
                                }
                            >
                                {preview.kind === 'delete' ? `🗑 ${t('htDelete')}` : `✂ ${t('htThin')}`}…
                            </Button>
                        </div>
                    )}

                    {/* ---- adapters off */}
                    {props.customKeys.length > 0 && (
                        <div className="om-ht-block">
                            <b>⏻ {t('htCustomOff')}</b>
                            <div className="om-muted">{t('htCustomOffHelp')}</div>
                            {props.customKeys.map(k => (
                                <FormControlLabel
                                    key={k}
                                    control={
                                        <Checkbox
                                            size="small"
                                            checked={instances.has(k)}
                                            onChange={e =>
                                                setInstances(prev => {
                                                    const next = new Set(prev);
                                                    if (e.target.checked) {
                                                        next.add(k);
                                                    } else {
                                                        next.delete(k);
                                                    }
                                                    return next;
                                                })
                                            }
                                        />
                                    }
                                    label={k}
                                />
                            ))}
                            <div className="om-ht-row">
                                <Button
                                    size="small"
                                    color="warning"
                                    disabled={!!busy || props.disabled || !instances.size}
                                    onClick={() =>
                                        setConfirm({
                                            kind: 'custom',
                                            text: t('htConfirmCustom', {
                                                instances: [...instances].join(', '),
                                                n: props.ids.length,
                                            }),
                                        })
                                    }
                                >
                                    ⏻ {t('htCustomOff')}…
                                </Button>
                            </div>
                        </div>
                    )}

                    {/* ---- backups */}
                    <div className="om-ht-block">
                        <Button
                            size="small"
                            disabled={!!busy}
                            onClick={loadBackups}
                        >
                            ↺ {t('htBackups')}
                        </Button>
                        {backups && !backups.length && <div className="om-muted">{t('htNoBackups')}</div>}
                        {backups?.map(b => (
                            <div
                                key={b.dir}
                                className="om-ht-row"
                            >
                                <span className="om-ellipsis">
                                    {b.dir.split('/').pop()} <span className="om-muted">({b.files.length})</span>
                                </span>
                                <Button
                                    size="small"
                                    disabled={!!busy || props.disabled}
                                    onClick={() => restore(b)}
                                >
                                    {t('htRestore')}
                                </Button>
                            </div>
                        ))}
                    </div>
                </>
            )}

            {confirm && (
                <Dialog
                    open
                    onClose={() => setConfirm(undefined)}
                >
                    <DialogTitle>{t('htConfirmTitle')}</DialogTitle>
                    <DialogContent>
                        <DialogContentText>{confirm.text}</DialogContentText>
                        <DialogContentText>{backup ? t('htWithBackup') : t('htWithoutBackup')}</DialogContentText>
                    </DialogContent>
                    <DialogActions>
                        <Button
                            autoFocus
                            onClick={() => setConfirm(undefined)}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            color="error"
                            variant="contained"
                            onClick={() => {
                                const kind = confirm.kind;
                                setConfirm(undefined);
                                if (kind === 'custom') {
                                    disableCustom();
                                } else {
                                    execute(kind);
                                }
                            }}
                        >
                            {t('htConfirmDo')}
                        </Button>
                    </DialogActions>
                </Dialog>
            )}
        </div>
    );
}
