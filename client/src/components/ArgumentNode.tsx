import { Handle, Position, type NodeProps } from 'reactflow';
import type { NodeKind } from '../../../shared/graph';
import { beliefColors } from '../replay';

export interface ArgumentNodeData {
  label: string;
  kind: NodeKind;
  initialBelief: number;
  anchored: boolean;
  /** 一键整理布局时锁定坐标（位置完全不变并作为相邻层锚点） */
  positionLocked?: boolean;
  /** 当前正在展示“一键整理布局”预览（节点为预览后的位置） */
  layoutPreview?: boolean;
  /** 回放当前轮的可信度（未计算时为空） */
  displayBelief?: number;
  /** 相对上一轮的升降（第 0 轮为空） */
  roundDelta?: number;
  inCycle?: boolean;
  /** 位于当前高亮的影响路径上 */
  inTrace?: boolean;
  /** 当前高亮路径的起点（起始证据） */
  traceStart?: boolean;
  /** 当前高亮路径的终点（目标节点） */
  traceTarget?: boolean;
  /** 证据贡献分摊中被点击高亮的证据节点 */
  shapleyFocus?: boolean;
  /** 必经链路分析中被点击高亮的瓶颈节点 */
  bottleneckFocus?: boolean;
  /** 必经链路分析的目标观点 */
  bottleneckTarget?: boolean;
  /** 被当前高亮瓶颈覆盖的证据节点 */
  bottleneckCovered?: boolean;
  [key: string]: unknown;
}

const formatPercent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * 锁定 / 解锁节点位置。不把回调塞进 React Flow 的节点 data（那是可序列化的图数据），
 * 而是派发一个由 App 监听的窗口事件，在那里统一走更新 + 保存逻辑。
 */
function dispatchTogglePositionLock(nodeId: string, locked: boolean) {
  window.dispatchEvent(
    new CustomEvent('argument:toggle-position-lock', { detail: { nodeId, locked } })
  );
}

export function ArgumentNode({ id, data, selected }: NodeProps<ArgumentNodeData>) {
  const hasValue = typeof data.displayBelief === 'number';
  const colors = hasValue ? beliefColors(data.displayBelief!) : null;
  const delta = hasValue && typeof data.roundDelta === 'number' ? data.roundDelta : null;
  const flat = delta !== null && Math.abs(delta) < 0.0005;

  return (
    <div
      className={[
        'argument-node',
        `kind-${data.kind}`,
        selected ? 'selected' : '',
        data.inCycle ? 'in-cycle' : '',
        data.inTrace ? 'in-trace' : '',
        data.traceStart ? 'trace-start' : '',
        data.traceTarget ? 'trace-target' : '',
        data.shapleyFocus ? 'shapley-focus' : '',
        data.bottleneckFocus ? 'bottleneck-focus' : '',
        data.bottleneckTarget ? 'bottleneck-target' : '',
        data.bottleneckCovered ? 'bottleneck-covered' : '',
        data.anchored ? 'anchored' : '',
        data.positionLocked ? 'position-locked' : '',
        data.layoutPreview ? 'layout-preview-node' : ''
      ].join(' ')}
      style={colors ? { backgroundImage: `linear-gradient(${colors.tint}, ${colors.tint})` } : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-heading">
        <span className="node-kind">{data.kind === 'evidence' ? '证据' : '观点'}</span>
        <span className="node-badges">
          {data.traceStart && (
            <span className="trace-badge trace-badge-start" title="影响路径追踪起点">
              起点
            </span>
          )}
          {data.traceTarget && (
            <span className="trace-badge trace-badge-target" title="影响路径追踪目标">
              目标
            </span>
          )}
          {data.bottleneckFocus && (
            <span className="bottleneck-badge bottleneck-badge-focus" title="必经瓶颈：被覆盖证据到目标的所有有向路径都经过该节点">
              瓶颈
            </span>
          )}
          {data.bottleneckTarget && (
            <span className="bottleneck-badge bottleneck-badge-target" title="必经链路分析的目标观点">
              目标
            </span>
          )}
          {data.anchored && (
            <span className="anchor-badge" title="传播中固定为先验可信度">
              固定
            </span>
          )}
          {data.positionLocked && (
            <span className="layout-lock-badge" title="一键整理布局时该节点坐标保持不变">
              📌 锁定
            </span>
          )}
          <button
            type="button"
            className={`pin-toggle ${data.positionLocked ? 'is-locked' : ''}`}
            title={data.positionLocked ? '取消布局位置锁定' : '锁定布局位置（整理时坐标不变）'}
            aria-pressed={Boolean(data.positionLocked)}
            disabled={Boolean(data.layoutPreview)}
            // 阻止冒泡到节点拖拽 / 选中。
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (data.layoutPreview) return;
              dispatchTogglePositionLock(id, !data.positionLocked);
            }}
          >
            {data.positionLocked ? '📌' : '📍'}
          </button>
        </span>
      </div>
      <div className="node-label">{data.label}</div>
      <div className="belief-row">
        <span>初始 {formatPercent(data.initialBelief)}</span>
        {hasValue && <strong style={colors ? { color: colors.strong } : undefined}>{formatPercent(data.displayBelief!)}</strong>}
      </div>
      {hasValue && (
        <div className="belief-meter" aria-hidden="true">
          <span style={{ width: `${data.displayBelief! * 100}%`, background: colors!.strong }} />
        </div>
      )}
      {delta !== null && (
        <div className={`belief-delta ${flat ? 'flat' : delta >= 0 ? 'up' : 'down'}`}>
          {flat ? '— 较上轮持平' : `${delta > 0 ? '▲' : '▼'} ${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}% 较上轮`}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { argument: ArgumentNode };
