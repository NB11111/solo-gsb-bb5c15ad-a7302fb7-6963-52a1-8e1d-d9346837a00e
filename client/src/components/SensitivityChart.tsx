import { useMemo, useState } from 'react';
import type { SensitivityPoint, SensitivityResult } from '../../../shared/graph';

interface SensitivityChartProps {
  scan: SensitivityResult;
  edgeLabel: string;
  targetLabel: string;
}

const WIDTH = 316;
const HEIGHT = 256;
const MARGIN = { top: 18, right: 14, bottom: 46, left: 40 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const DECISION_Y = 0.5;

const STATUS_META: Record<SensitivityPoint['status'], { label: string; color: string; symbol: string }> = {
  converged: { label: '收敛', color: '#2563eb', symbol: 'circle' },
  oscillating: { label: '振荡', color: '#dc2626', symbol: 'diamond' },
  limit: { label: '达到上限', color: '#d97706', symbol: 'square' }
};

const xFor = (weight: number) => MARGIN.left + weight * PLOT_WIDTH;
const yFor = (value: number) => MARGIN.top + (1 - value) * PLOT_HEIGHT;
/** 无稳定目标值的点统一落在绘图区下方的“无值刻度”上，避免被误读为 0.5。 */
const NO_VALUE_Y = MARGIN.top + PLOT_HEIGHT + 22;
const yForPoint = (point: SensitivityPoint) =>
  point.targetValue === null ? NO_VALUE_Y : yFor(point.targetValue);

function Marker({
  point,
  onEnter,
  onLeave,
  onToggle,
  active
}: {
  point: SensitivityPoint;
  onEnter: () => void;
  onLeave: () => void;
  onToggle: () => void;
  active: boolean;
}) {
  const x = xFor(point.weight);
  const y = yForPoint(point);
  const meta = STATUS_META[point.status];
  const size = active ? 7 : 5.5;
  const common = {
    tabIndex: 0,
    role: 'button' as const,
    'aria-label': `边权 ${point.weight.toFixed(2)}，${meta.label}，停止于第 ${point.iterations} 轮${
      point.targetValue === null ? '，无稳定目标值' : `，目标值 ${point.targetValue.toFixed(4)}`
    }`,
    onMouseEnter: onEnter,
    onMouseLeave: onLeave,
    onFocus: onEnter,
    onBlur: onLeave,
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation();
      onToggle();
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onToggle();
      }
    }
  };

  if (meta.symbol === 'circle') {
    return (
      <circle
        {...common}
        cx={x}
        cy={y}
        r={size}
        fill={meta.color}
        stroke="#fff"
        strokeWidth={1.6}
      />
    );
  }
  if (meta.symbol === 'diamond') {
    const points = `${x},${y - size} ${x + size},${y} ${x},${y + size} ${x - size},${y}`;
    return <polygon {...common} points={points} fill="#fff" stroke={meta.color} strokeWidth={2} />;
  }
  return (
    <rect
      {...common}
      x={x - size}
      y={y - size}
      width={size * 2}
      height={size * 2}
      fill="#fff"
      stroke={meta.color}
      strokeWidth={2}
    />
  );
}

/**
 * 边权敏感性曲线：
 * - 仅相邻的收敛点之间连成实线曲线；振荡点与达到上限点只画独立标记，不参与连线；
 * - 0.5 判定线虚线标出；首个跨过 0.5 的连续收敛区间用色带高亮；
 * - 悬停（或点击/键盘聚焦）点位显示边权、状态、停止轮次和目标值，无目标值时显示原因。
 */
export function SensitivityChart({ scan, edgeLabel, targetLabel }: SensitivityChartProps) {
  const [activeWeight, setActiveWeight] = useState<number | null>(null);
  const active = scan.points.find((point) => point.weight === activeWeight) ?? null;

  const segments = useMemo(() => {
    const paths: string[] = [];
    let current: string[] = [];
    scan.points.forEach((point, index) => {
      const usable = point.status === 'converged' && point.targetValue !== null;
      if (usable) {
        const command = `${current.length === 0 ? 'M' : 'L'}${xFor(point.weight).toFixed(2)},${yFor(
          point.targetValue as number
        ).toFixed(2)}`;
        current.push(command);
      }
      const next = scan.points[index + 1];
      const nextUsable = next ? next.status === 'converged' && next.targetValue !== null : false;
      if (!usable || !nextUsable) {
        if (current.length > 0) paths.push(current.join(' '));
        current = [];
      }
    });
    return paths;
  }, [scan.points]);

  const band = scan.thresholdBand;
  const tooltipLeft = active ? Math.min(xFor(active.weight) + 12, WIDTH - 168) : 0;
  const tooltipTop = active
    ? Math.max(6, Math.min(yForPoint(active) - 56, HEIGHT - 92))
    : 0;

  return (
    <div className="sensitivity-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" role="img" aria-label="边权敏感性曲线">
        {/* 网格与坐标刻度 */}
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
          <g key={`y-${tick}`}>
            <line
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={yFor(tick)}
              y2={yFor(tick)}
              stroke={tick === DECISION_Y ? '#94a3b8' : '#e2e8f0'}
              strokeWidth={tick === DECISION_Y ? 1.4 : 1}
              strokeDasharray={tick === DECISION_Y ? '5 4' : undefined}
            />
            <text x={MARGIN.left - 6} y={yFor(tick) + 3.5} textAnchor="end" fontSize={9.5} fill="#64748b">
              {tick.toFixed(2)}
            </text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
          <text
            key={`x-${tick}`}
            x={xFor(tick)}
            y={HEIGHT - 12}
            textAnchor="middle"
            fontSize={9.5}
            fill="#64748b"
          >
            {tick.toFixed(2)}
          </text>
        ))}
        <text x={MARGIN.left + PLOT_WIDTH / 2} y={HEIGHT - 1} textAnchor="middle" fontSize={10} fill="#475569">
          边权（{edgeLabel}）
        </text>
        <text
          x={-(MARGIN.top + PLOT_HEIGHT / 2)}
          y={12}
          transform="rotate(-90)"
          textAnchor="middle"
          fontSize={10}
          fill="#475569"
        >
          {targetLabel} 最终可信度
        </text>

        {/* 首次跨过 0.5 的阈值区间色带 */}
        {band && (
          <rect
            x={xFor(band.fromWeight)}
            y={MARGIN.top}
            width={Math.max(2, xFor(band.toWeight) - xFor(band.fromWeight))}
            height={PLOT_HEIGHT}
            fill="rgba(37, 99, 235, 0.10)"
            stroke="rgba(37, 99, 235, 0.45)"
            strokeDasharray="3 3"
            rx={3}
          >
            <title>{`首次跨越 0.5 的区间：边权 ${band.fromWeight.toFixed(2)}–${band.toWeight.toFixed(2)}`}</title>
          </rect>
        )}

        {/* “无稳定目标值”底线：振荡/上限点落在此处，明确表示它们没有终值 */}
        <line
          x1={MARGIN.left}
          x2={WIDTH - MARGIN.right}
          y1={NO_VALUE_Y}
          y2={NO_VALUE_Y}
          stroke="#cbd5e1"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
        <text x={MARGIN.left - 6} y={NO_VALUE_Y + 3.5} textAnchor="end" fontSize={8.5} fill="#94a3b8">
          无值
        </text>

        {/* 仅连接连续的收敛点 */}
        {segments.map((d, index) => (
          <path key={index} d={d} fill="none" stroke="#2563eb" strokeWidth={2} strokeLinejoin="round" />
        ))}

        {scan.points.map((point) => (
          <Marker
            key={point.weight}
            point={point}
            active={point.weight === activeWeight}
            onEnter={() => setActiveWeight(point.weight)}
            onLeave={() => setActiveWeight(null)}
            onToggle={() => setActiveWeight((current) => (current === point.weight ? null : point.weight))}
          />
        ))}
      </svg>

      {active && (
        <div className="sensitivity-tooltip" style={{ left: tooltipLeft, top: tooltipTop }}>
          <div className="tooltip-row">
            <span>边权</span>
            <strong>{active.weight.toFixed(2)}</strong>
          </div>
          <div className="tooltip-row">
            <span>状态</span>
            <strong style={{ color: STATUS_META[active.status].color }}>
              {STATUS_META[active.status].label}
            </strong>
          </div>
          <div className="tooltip-row">
            <span>停止轮次</span>
            <strong>{active.iterations}</strong>
          </div>
          <div className="tooltip-row">
            <span>{active.status === 'limit' ? '末轮参考值' : '目标值'}</span>
            {active.targetValue === null ? (
              <em className="tooltip-reason">无稳定目标值</em>
            ) : (
              <strong>{active.targetValue.toFixed(4)}</strong>
            )}
          </div>
          {active.targetValue === null && <p className="tooltip-reason-text">{active.reason}</p>}
          {active.status === 'limit' && <p className="tooltip-reason-text">{active.reason}</p>}
        </div>
      )}

      <ul className="sensitivity-legend">
        {(Object.keys(STATUS_META) as Array<SensitivityPoint['status']>).map((status) => (
          <li key={status}>
            <span className={`legend-marker legend-${status}`} />
            {STATUS_META[status].label}
          </li>
        ))}
      </ul>
      {band && (
        <p className="sensitivity-band-note">
          首次跨过 0.5：边权 {band.fromWeight.toFixed(2)}（{band.fromValue.toFixed(3)}）→{' '}
          {band.toWeight.toFixed(2)}（{band.toValue.toFixed(3)}）
        </p>
      )}
    </div>
  );
}
