import React from 'react';
import type { Compat, LineRef, Link } from '../model';
import { anchorRow } from '../model';
import { t } from '../i18n';
import { ROW_HEIGHT } from './ObjectTree';

/** A link with its display data */
export interface DrawLink extends Link {
    level: Compat;
    reason?: string;
    done?: boolean;
    /** a read-in mapping that nothing changes yet (FR-56) */
    existing?: boolean;
    /** separate write ID: the alias writes to this object, it does not read from it (AM-12) */
    write?: boolean;
}

/** Props of the line layer */
export interface LinkLayerProps {
    links: DrawLink[];
    leftIndex: Map<string, number>;
    rightIndex: Map<string, number>;
    leftScroll: number;
    rightScroll: number;
    height: number;
    width: number;
    selected?: LineRef;
    /** IDs of the selected row - its lines are emphasized (ME-14) */
    focusIds: Set<string>;
    /** selected node (no state): the lines of the values below it belong to it */
    focusNode?: string;
    /** while a row is selected, the lines not belonging to it are hidden instead of faded (ME-14) */
    hideOthers: boolean;
    onSelect: (link: DrawLink) => void;
}

/** Line styles - shared with the legend (LinkLegend) */
export const LINK_STYLE = {
    colors: { ok: '#4caf50', warn: '#ff9800', error: '#f44336' } as Record<Compat, string>,
    /** read in and unchanged (FR-56) */
    existing: '#90a4ae',
    /** written by the last run */
    done: '#9e9e9e',
    dashExisting: '7 4',
    /** an end is outside the visible area */
    dashOutside: '4 3',
    /** separate write ID (AM-12) - with an arrow head at the object written to */
    dashWrite: '1.5 3',
    width: { normal: 1.6, bundle: 2.5, focus: 3, selected: 4 },
    /** other lines while a row is selected */
    faded: 0.35,
};
const COLORS = LINK_STYLE.colors;

/**
 * Arrow head at the source end of a write line: the alias writes there (AM-12)
 *
 * @param y - height of the source end
 */
export function writeArrow(y: number): string {
    return `M 0 ${y} L 8 ${y - 4} L 8 ${y + 4} Z`;
}

/**
 * Bezier lines between the two trees (ME-10) - drawn in the gutter between them
 *
 * @param props
 */
export function LinkLayer(props: LinkLayerProps): React.JSX.Element {
    const { width, height } = props;
    const y = (row: number, scroll: number): number => row * ROW_HEIGHT - scroll + ROW_HEIGHT / 2;

    // a selected row: its lines (for a node: the lines of the values below it) - the others are hidden
    // or faded (ME-14)
    const node = props.focusNode;
    const active = props.focusIds.size > 0 || !!node;
    const below = (id: string): boolean => !!node && (id === node || id.startsWith(`${node}.`));
    const related = (x: Link): boolean =>
        props.focusIds.has(x.sourceId) || props.focusIds.has(x.targetId) || below(x.sourceId) || below(x.targetId);
    const shown = active && props.hideOthers ? props.links.filter(related) : props.links;

    // links of collapsed nodes end at the visible parent - bundle equal lines (ME-10)
    const bundles = new Map<string, { y1: number; y2: number; links: DrawLink[] }>();
    for (const link of shown) {
        const l = anchorRow(link.sourceId, props.leftIndex);
        const r = anchorRow(link.targetId, props.rightIndex);
        if (l === undefined || r === undefined) {
            continue;
        }
        const y1 = y(l, props.leftScroll);
        const y2 = y(r, props.rightScroll);
        // read and write lines stay apart - they look different
        const key = `${l}|${r}|${link.write ? 'w' : 'r'}`;
        const bundle = bundles.get(key) ?? { y1, y2, links: [] };
        bundle.links.push(link);
        bundles.set(key, bundle);
    }

    const clamp = (v: number): number => Math.max(2, Math.min(height - 2, v));
    return (
        <svg
            className="om-links"
            width={width}
            height={height}
        >
            {[...bundles.values()].map(({ y1, y2, links }) => {
                const link = links[0];
                const outside = y1 < 0 || y1 > height || y2 < 0 || y2 > height;
                if ((y1 < 0 && y2 < 0) || (y1 > height && y2 > height)) {
                    return null;
                }
                const a = clamp(y1);
                const b = clamp(y2);
                const d = `M 0 ${a} C ${width / 2} ${a}, ${width / 2} ${b}, ${width} ${b}`;
                const level: Compat = links.some(x => x.level === 'error')
                    ? 'error'
                    : links.some(x => x.level === 'warn')
                      ? 'warn'
                      : 'ok';
                const write = links.every(x => x.write);
                const isSelected =
                    !!props.selected?.write === write &&
                    links.length === 1 &&
                    props.selected?.sourceId === link.sourceId &&
                    props.selected?.targetId === link.targetId;
                const focus = links.some(x => props.focusIds.has(x.sourceId) || props.focusIds.has(x.targetId));
                const existing = links.every(x => x.existing);
                const color = existing
                    ? LINK_STYLE.existing
                    : link.done && links.every(x => x.done)
                      ? LINK_STYLE.done
                      : COLORS[level];
                const title = links
                    .map(x =>
                        x.write
                            ? `${x.targetId} ✎→ ${x.sourceId} (${t('lgWrite')})`
                            : `${x.sourceId} → ${x.targetId}${x.reason ? ` (${x.reason})` : ''}`,
                    )
                    .join('\n');
                return (
                    <g
                        key={`${link.sourceId}|${link.targetId}|${write ? 'w' : 'r'}`}
                        onClick={() => props.onSelect(link)}
                        style={{ cursor: 'pointer' }}
                    >
                        <title>{title}</title>
                        <path
                            d={d}
                            stroke="transparent"
                            strokeWidth={10}
                            fill="none"
                        />
                        <path
                            d={d}
                            stroke={color}
                            strokeWidth={
                                isSelected
                                    ? LINK_STYLE.width.selected
                                    : focus
                                      ? LINK_STYLE.width.focus
                                      : links.length > 1
                                        ? LINK_STYLE.width.bundle
                                        : LINK_STYLE.width.normal
                            }
                            strokeDasharray={
                                outside
                                    ? LINK_STYLE.dashOutside
                                    : write
                                      ? LINK_STYLE.dashWrite
                                      : existing
                                        ? LINK_STYLE.dashExisting
                                        : undefined
                            }
                            opacity={active && !links.some(related) ? LINK_STYLE.faded : 1}
                            fill="none"
                        />
                        {write && (
                            <path
                                d={writeArrow(a)}
                                fill={color}
                                opacity={active && !links.some(related) ? LINK_STYLE.faded : 1}
                            />
                        )}
                        {links.length > 1 && (
                            <text
                                x={width / 2}
                                y={(a + b) / 2 - 3}
                                className="om-link-count"
                                textAnchor="middle"
                            >
                                {links.length}
                            </text>
                        )}
                    </g>
                );
            })}
        </svg>
    );
}
