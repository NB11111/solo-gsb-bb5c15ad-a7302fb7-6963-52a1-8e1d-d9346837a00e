import { useMemo } from 'react';
import type { ShapleyResult } from '../../../shared/graph';

interface ShapleyWaterfallProps {
  /** 仅当 result.computable 为 true 时渲染（调用方保证） */
  result: ShapleyResult;
  nodeLabelById: Map<string, string>;
  /** 当前在画布上高亮的证据节点 */
  activeNodeId: string | null;
  /** 点击某一行：在画布上高亮 / 取消高亮对应证据 */
  onToggleNode: (nodeId: string) => void;
}

const WIDTH = 316;
const ROW_HEIGHT = 32;
const LABEL_WIDTH = 84;
const VALUE_WIDTH = 80;
const MARGIN = { top: 18, bottom: 20 };
const PLOT_LEFT = LABEL_WIDTH + 6;
const PLOT_RIGHT = WIDTH - VALUE_WIDTH - 6;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const BAR_HEIGHT = 16;

const POSITIVE = '#16a34a';
const NEGATIVE = '#dc2626';

const truncate = (label: string) => (label.length > 9 ? `${label.slice(0, 8)}…` : label);
const signed = (value: number, digits = 4) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;

interface WaterfallRow {
  nodeId: string;
  label: string;
  contribution: number;
  share: number | null;
  /** 本行起始累计值（空联盟基准 + 之前各行贡献） */
  from: number;
  /** 本行结束累计值 */
  to: number;
}

/**
 * Shapley 贡献瀑布条：从空联盟基准出发，每行一个证据的累计条形，
 * 正贡献向右（绿）、负贡献向左（红），最终抵达全联盟值。
 * 行可点击 / 键盘聚焦，用于在画布上高亮对应证据节点。
 */
export function ShapleyWaterfall({ result, nodeLabelById, activeNodeId, onToggleNode }: ShapleyWaterfallProps) {
  const contributions = result.contributions ?? [];
  const baseline = result.baselineValue ?? 0;
  const full = result.fullValue ?? baseline;

  const rows = useMemo<WaterfallRow[]>(() => {
    let running = baseline;
    return contributions.map((item) => {
      const from = running;
      running += item.contribution;
      return {
        nodeId: item.nodeId,
        label: nodeLabelById.get(item.nodeId) ?? item.nodeId,
        contribution: item.contribution,
        share: item.share,
        from,
        to: running
      };
    });
  }, [baseline, contributions, nodeLabelById]);

  const height = MARGIN.top + rows.length * ROW_HEIGHT + MARGIN.bottom;
  const plotTop = MARGIN.top;
  const plotBottom = height - MARGIN.bottom;

  // 值域始终覆盖 0..1 与全部累计值（部分累计可能短暂越出 0..1）。
  const domain = useMemo(() => {
    let lo = Math.min(0, baseline, full);
    let hi = Math.max(1, baseline, full);
    rows.forEach((row) => {
      lo = Math.min(lo, row.from, row.to);
      hi = Math.max(hi, row.from, row.to);
    });
    const pad = Math.max((hi - lo) * 0.03, 0.005);
    return { lo: lo - pad, hi: hi + pad };
  }, [baseline, full, rows]);

  const xFor = (value: number) =>
    PLOT_LEFT + ((value - domain.lo) / (domain.hi - domain.lo)) * PLOT_WIDTH;
  const rowCenter = (index: number) => plotTop + index * ROW_HEIGHT + ROW_HEIGHT / 2;

  const baselineX = xFor(baseline);
  const fullX = xFor(full);
  const clampLabelX = (x: number) => Math.max(PLOT_LEFT + 26, Math.min(PLOT_RIGHT - 26, x));

  return (
    <div className="shapley-waterfall">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} width="100%" role="img" aria-label="证据贡献瀑布条">
        {/* 0 / 0.5 / 1 参考网格线 */}
        {[0, 0.5, 1].map((tick) =>
          tick >= domain.lo && tick <= domain.hi ? (
            <line
              key={tick}
              x1={xFor(tick)}
              x2={xFor(tick)}
              y1={plotTop - 4}
              y2={plotBottom + 4}
              stroke="#e2e8f0"
              strokeWidth={1}
            />
          ) : null
        )}

        {/* 空联盟基准线（虚线）与全联盟线（实线） */}
        <line
          x1={baselineX}
          x2={baselineX}
          y1={plotTop - 4}
          y2={plotBottom + 4}
          stroke="#64748b"
          strokeWidth={1.2}
          strokeDasharray="4 3"
        />
        <line x1={fullX} x2={fullX} y1={plotTop - 4} y2={plotBottom + 4} stroke="#1d4ed8" strokeWidth={1.6} />
        <text x={clampLabelX(baselineX)} y={11} textAnchor="middle" fontSize={9.5} fill="#475569">
          空联盟 {baseline.toFixed(3)}
        </text>
        <text x={clampLabelX(fullX)} y={height - 6} textAnchor="middle" fontSize={9.5} fill="#1d4ed8">
          全联盟 {full.toFixed(3)}
        </text>

        {rows.map((row, index) => {
          const center = rowCenter(index);
          const fromX = xFor(row.from);
          const toX = xFor(row.to);
          const barX = Math.min(fromX, toX);
          // 零贡献也给 2px 刻度，保证可见、可点击。
          const barWidth = Math.max(2, Math.abs(toX - fromX));
          const color = row.contribution >= 0 ? POSITIVE : NEGATIVE;
          const active = row.nodeId === activeNodeId;
          const toggle = () => onToggleNode(row.nodeId);
          return (
            <g
              key={row.nodeId}
              className={`shapley-row ${active ? 'active' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`证据 ${row.label}，贡献 ${signed(row.contribution)}${
                row.share === null ? '' : `，占比 ${(row.share * 100).toFixed(1)}%`
              }`}
              onClick={toggle}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  toggle();
                }
              }}
            >
              <rect
                className="shapley-row-hit"
                x={2}
                y={center - ROW_HEIGHT / 2 + 1}
                width={WIDTH - 4}
                height={ROW_HEIGHT - 2}
                rx={6}
              />
              <text x={LABEL_WIDTH} y={center + 3.5} textAnchor="end" fontSize={10} fill="#334155">
                <title>{row.label}</title>
                {truncate(row.label)}
              </text>
              <rect
                className="shapley-bar"
                x={barX}
                y={center - BAR_HEIGHT / 2}
                width={barWidth}
                height={BAR_HEIGHT}
                rx={2.5}
                fill={color}
                stroke={active ? '#4f46e5' : 'none'}
                strokeWidth={active ? 2 : 0}
              />
              {/* 到下一行的瀑布连接线 */}
              {index < rows.length - 1 && (
                <line
                  x1={toX}
                  x2={toX}
                  y1={center + BAR_HEIGHT / 2}
                  y2={rowCenter(index + 1) - BAR_HEIGHT / 2}
                  stroke="#94a3b8"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                />
              )}
              <text x={WIDTH - VALUE_WIDTH + 4} y={center - 1} fontSize={9.5} fontWeight={700} fill={color}>
                {signed(row.contribution)}
              </text>
              <text x={WIDTH - VALUE_WIDTH + 4} y={center + 9} fontSize={8.5} fill="#64748b">
                {row.share === null ? '占比 —' : `占比 ${(row.share * 100).toFixed(1)}%`}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="hint">点击任一条形可在画布上高亮对应证据（再次点击取消）。</p>
    </div>
  );
}
