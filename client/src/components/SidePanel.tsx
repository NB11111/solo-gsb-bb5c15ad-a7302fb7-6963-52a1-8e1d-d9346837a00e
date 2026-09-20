import type { Edge, Node } from 'reactflow';
import type { ArgumentNodeData } from './ArgumentNode';
import type { RoundDecomposition } from '../replay';
import { SensitivityChart } from './SensitivityChart';
import { ShapleyWaterfall } from './ShapleyWaterfall';
import type {
  BottleneckItem,
  BottleneckResult,
  GraphDocument,
  NodeKind,
  PathSign,
  PropagateOptions,
  PropagateResult,
  SensitivityResult,
  ShapleyResult,
  Stance,
  TraceResult
} from '../../../shared/graph';

export interface SelectionState {
  node?: Node<ArgumentNodeData>;
  edge?: Edge;
}

export interface SensitivitySelection {
  edgeId: string;
  targetNodeId: string;
}

export interface TraceSelection {
  startNodeId: string;
  targetNodeId: string;
  maxHops: number;
}

export interface ShapleySelection {
  claimNodeId: string;
  evidenceNodeIds: string[];
}

export interface BottleneckSelection {
  targetNodeId: string;
}

interface SidePanelProps {
  options: PropagateOptions;
  onOptionsChange: (options: PropagateOptions) => void;
  result: PropagateResult | null;
  selection: SelectionState;
  decomposition: RoundDecomposition | null;
  onUpdateNode: (id: string, patch: Partial<ArgumentNodeData>) => void;
  /** 只切换“布局位置锁定”：不清空传播分析（属于布局属性，类似拖拽） */
  onUpdateNodeLayoutLock: (id: string, locked: boolean) => void;
  onUpdateEdge: (id: string, patch: { weight?: number; stance?: Stance }) => void;
  onDeleteSelection: () => void;
  /** 布局整理预览期间：禁止一切图结构 / 属性编辑（锁定切换也不可用，先确认或取消） */
  graphEditingDisabled?: boolean;
  sensitivity: {
    selection: SensitivitySelection;
    onSelectionChange: (patch: Partial<SensitivitySelection>) => void;
    scan: SensitivityResult | null;
    scanning: boolean;
    status: string;
    onRun: () => void;
    onClose: () => void;
    edgeLabel: string;
    targetLabel: string;
  };
  trace: {
    selection: TraceSelection;
    onSelectionChange: (patch: Partial<TraceSelection>) => void;
    result: TraceResult | null;
    tracing: boolean;
    status: string;
    activeIndex: number;
    onActiveIndexChange: (index: number) => void;
    onRun: () => void;
    onClose: () => void;
  };
  shapley: {
    selection: ShapleySelection;
    /** 选择变化会同时清空已展示的分摊结果 */
    onSelectionChange: (patch: Partial<ShapleySelection>) => void;
    result: ShapleyResult | null;
    running: boolean;
    status: string;
    /** 画布上当前高亮的证据节点（点击瀑布条切换） */
    activeNodeId: string | null;
    onToggleNode: (nodeId: string) => void;
    onRun: () => void;
    onClose: () => void;
  };
  bottleneck: {
    selection: BottleneckSelection;
    /** 目标变化会同时清空已展示的分析结果与高亮 */
    onSelectionChange: (patch: Partial<BottleneckSelection>) => void;
    result: BottleneckResult | null;
    running: boolean;
    status: string;
    /** 画布上当前高亮的瓶颈（`${kind}:${id}`），null 表示未选中 */
    activeKey: string | null;
    onToggle: (key: string | null) => void;
    onRun: () => void;
    onClose: () => void;
  };
  nodes: Node<ArgumentNodeData>[];
  edges: Edge[];
}

const optionLabels: Array<{ key: keyof PropagateOptions; label: string; min: number; max: number; step: number }> = [
  { key: 'threshold', label: '收敛阈值', min: 0.0001, max: 0.05, step: 0.0001 },
  { key: 'maxIterations', label: '最大迭代', min: 5, max: 500, step: 5 },
  { key: 'lambda', label: '传播强度 λ', min: 0, max: 1, step: 0.05 }
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

const signed = (value: number, digits = 4) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;

/** 下一轮值的可核对分解：先验 + λ·Σ(入边有符号贡献)，再经 0..1 裁剪。 */
function DecompositionCard({ decomposition }: { decomposition: RoundDecomposition }) {
  const {
    baseRound,
    targetRound,
    isLastTransition,
    anchored,
    prior,
    lambda,
    contributions,
    influenceSum,
    raw,
    clipped,
    clipAmount,
    recorded,
    matches
  } = decomposition;

  return (
    <section className="panel-card decomposition-card">
      <h2>
        下一轮值分解（第 {baseRound} → {targetRound} 轮）
      </h2>
      {isLastTransition && <p className="hint">当前已是停止轮，以下展示最后一次迭代的分解。</p>}

      {anchored ? (
        <div className="decomp-locked">
          <p>
            🔒 该节点已<strong>固定</strong>，第 {targetRound} 轮值由先验锁定为{' '}
            <strong>{prior.toFixed(4)}</strong>。
          </p>
          <p className="hint">固定节点的入边不参与其取值计算，因此不列出任何入边贡献。</p>
        </div>
      ) : (
        <>
          <dl className="decomp-summary">
            <dt>先验 p</dt>
            <dd>{prior.toFixed(4)}</dd>
            <dt>传播强度 λ</dt>
            <dd>{lambda.toFixed(4)}</dd>
          </dl>
          {contributions.length === 0 ? (
            <p className="hint">该节点没有入边，下一轮值等于先验（经 0..1 裁剪）。</p>
          ) : (
            <table className="decomp-table">
              <thead>
                <tr>
                  <th>入边来源</th>
                  <th>贡献 ±w·b</th>
                </tr>
              </thead>
              <tbody>
                {contributions.map((item) => (
                  <tr key={item.edgeId}>
                    <td>
                      <span className={`decomp-stance ${item.stance}`}>
                        {item.stance === 'support' ? '支持' : '反驳'}
                      </span>{' '}
                      {item.sourceLabel}
                      <small>
                        w {item.weight.toFixed(2)} × 第{baseRound}轮 {item.sourceValue.toFixed(4)}
                      </small>
                    </td>
                    <td className={item.signedContribution >= 0 ? 'decomp-pos' : 'decomp-neg'}>
                      {signed(item.signedContribution)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <dl className="decomp-summary">
            <dt>Σ 入边贡献</dt>
            <dd>{signed(influenceSum)}</dd>
            <dt>裁剪前 p + λ·Σ</dt>
            <dd>
              {prior.toFixed(4)} {signed(lambda * influenceSum)} = {raw.toFixed(4)}
            </dd>
            <dt>0..1 裁剪量</dt>
            <dd>
              {clipAmount > 0
                ? `超出上界，裁去 ${clipAmount.toFixed(4)}`
                : clipAmount < 0
                  ? `低于下界，抬升 ${(-clipAmount).toFixed(4)}`
                  : '0（未裁剪）'}
            </dd>
            <dt>第 {targetRound} 轮值</dt>
            <dd>{clipped.toFixed(4)}</dd>
          </dl>
        </>
      )}

      <p className={`decomp-check ${matches ? 'ok' : 'bad'}`}>
        {matches ? '✓' : '✗'} 本地重算 {anchored ? prior.toFixed(6) : clipped.toFixed(6)} 与记录的第 {targetRound}{' '}
        轮值 {recorded.toFixed(6)} {matches ? '一致' : '不一致'}
      </p>
    </section>
  );
}

export function SidePanel({
  options,
  onOptionsChange,
  result,
  selection,
  decomposition,
  onUpdateNode,
  onUpdateNodeLayoutLock,
  onUpdateEdge,
  onDeleteSelection,
  graphEditingDisabled = false,
  sensitivity,
  trace,
  shapley,
  bottleneck,
  nodes,
  edges
}: SidePanelProps) {
  const stanceText = (stance: Stance) => (stance === 'support' ? '支持' : '反驳');
  const nodeLabelById = new Map(nodes.map((node) => [node.id, node.data.label] as const));

  return (
    <aside className="side-panel">
      <section className="panel-card">
        <h2>传播参数</h2>
        {optionLabels.map((item) => (
          <Field key={item.key} label={item.label}>
            <input
              type="number"
              min={item.min}
              max={item.max}
              step={item.step}
              value={options[item.key]}
              onChange={(event) =>
                onOptionsChange({ ...options, [item.key]: Number(event.target.value) })
              }
            />
          </Field>
        ))}
        <p className="hint">同步迭代：先验可信度 + λ·(支持 − 反驳)，结果裁剪到 0–1。</p>
      </section>

      <section className="panel-card">
        <h2>检查器</h2>
        {graphEditingDisabled && (
          <p className="hint layout-disabled-hint">正在预览“一键整理布局”：请先<strong>确认应用</strong>或<strong>取消</strong>，再编辑图。</p>
        )}
        {selection.node && (
          <fieldset className="inspector" disabled={graphEditingDisabled}>
            <Field label="标签">
              <input
                value={selection.node.data.label}
                onChange={(event) => onUpdateNode(selection.node!.id, { label: event.target.value })}
              />
            </Field>
            <Field label="类型">
              <select
                value={selection.node.data.kind}
                onChange={(event) =>
                  onUpdateNode(selection.node!.id, { kind: event.target.value as NodeKind })
                }
              >
                <option value="claim">观点 claim</option>
                <option value="evidence">证据 evidence</option>
              </select>
            </Field>
            <Field label={`初始可信度：${Math.round(selection.node.data.initialBelief * 100)}%`}>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={selection.node.data.initialBelief}
                onChange={(event) =>
                  onUpdateNode(selection.node!.id, { initialBelief: Number(event.target.value) })
                }
              />
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={selection.node.data.anchored}
                onChange={(event) =>
                  onUpdateNode(selection.node!.id, { anchored: event.target.checked })
                }
              />
              固定为初始可信度
            </label>
            <label className="checkbox layout-lock-checkbox">
              <input
                type="checkbox"
                checked={Boolean(selection.node.data.positionLocked)}
                onChange={(event) =>
                  onUpdateNodeLayoutLock(selection.node!.id, event.target.checked)
                }
              />
              📌 整理布局时锁定该节点坐标
            </label>
            <button className="danger" onClick={onDeleteSelection}>
              删除节点
            </button>
          </fieldset>
        )}

        {!selection.node && selection.edge && (
          <fieldset className="inspector" disabled={graphEditingDisabled}>
            <Field label="关系">
              <select
                value={(selection.edge.data?.stance as Stance) ?? 'support'}
                onChange={(event) =>
                  onUpdateEdge(selection.edge!.id, { stance: event.target.value as Stance })
                }
              >
                <option value="support">支持 support</option>
                <option value="rebut">反驳 rebut</option>
              </select>
            </Field>
            <Field label={`权重：${Math.round(Number(selection.edge.data?.weight ?? 0.6) * 100)}%`}>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={Number(selection.edge.data?.weight ?? 0.6)}
                onChange={(event) =>
                  onUpdateEdge(selection.edge!.id, { weight: Number(event.target.value) })
                }
              />
            </Field>
            <button className="danger" onClick={onDeleteSelection}>
              删除连线
            </button>
          </fieldset>
        )}

        {!selection.node && !selection.edge && (
          <p className="hint">点击节点或连线进行编辑；从节点右侧圆点拖出即可连线。</p>
        )}
      </section>

      <SensitivityCard
        sensitivity={sensitivity}
        nodes={nodes}
        edges={edges}
        nodeLabelById={nodeLabelById}
        stanceText={stanceText}
      />

      <TraceCard trace={trace} nodes={nodes} nodeLabelById={nodeLabelById} stanceText={stanceText} />

      <ShapleyCard shapley={shapley} nodes={nodes} nodeLabelById={nodeLabelById} />

      <BottleneckCard
        bottleneck={bottleneck}
        nodes={nodes}
        edges={edges}
        nodeLabelById={nodeLabelById}
        stanceText={stanceText}
      />

      {decomposition && selection.node && <DecompositionCard decomposition={decomposition} />}

      {result && (
        <section className={`panel-card result-card ${result.oscillating ? 'bad' : result.converged ? 'good' : 'warn'}`}>
          <h2>传播结果</h2>
          <p>{result.message}</p>
          <dl>
            <dt>迭代轮数</dt>
            <dd>{result.iterations}</dd>
            <dt>最终最大变化</dt>
            <dd>{result.maxChange.toFixed(5)}</dd>
            <dt>检测周期</dt>
            <dd>{result.detectedPeriod ?? '—'}</dd>
          </dl>
          {result.oscillating && (
            <div className="cycle-list">
              <strong>高亮的负反馈环（{result.cycles.length}）</strong>
              {result.cycles.length === 0 && <p className="hint">未枚举到满足强度阈值的奇数反驳环，但系统仍未稳定。</p>}
              {result.cycles.slice(0, 6).map((cycle, index) => (
                <div className="cycle-item" key={cycle.edgeIds.join('-')}>
                  <span>#{index + 1} 环：{cycle.nodeIds.join(' → ')} → {cycle.nodeIds[0]}</span>
                  <small>
                    {cycle.rebutCount} 条反驳 · |增益| {Math.abs(cycle.signedGain).toFixed(2)} · 活跃度{' '}
                    {cycle.activity.toFixed(3)}
                  </small>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </aside>
  );
}

type SensitivityCardProps = Pick<SidePanelProps, 'sensitivity' | 'nodes' | 'edges'> & {
  nodeLabelById: Map<string, string>;
  stanceText: (stance: Stance) => string;
};

/** 边权敏感性扫描卡片：选择一条连线与一个目标节点后运行 0→1 的 21 点等距扫描。 */
function SensitivityCard({ sensitivity, nodes, edges, nodeLabelById, stanceText }: SensitivityCardProps) {
  const { selection: scanSelection, onSelectionChange, scan, scanning, status, onRun, onClose } = sensitivity;
  const selectedEdge = edges.find((edge) => edge.id === scanSelection.edgeId);
  const canRun = Boolean(selectedEdge) && nodes.some((node) => node.id === scanSelection.targetNodeId);

  const edgeLabel = (edge: Edge) => {
    const stance = (edge.data?.stance as Stance) ?? 'support';
    const weight = Math.round(Number(edge.data?.weight ?? 0.6) * 100);
    return `${nodeLabelById.get(edge.source) ?? edge.source} ${stanceText(stance)}→ ${
      nodeLabelById.get(edge.target) ?? edge.target
    }（${weight}%）`;
  };

  return (
    <section className="panel-card sensitivity-card">
      <div className="sensitivity-heading">
        <h2>边权敏感性扫描</h2>
        {scan && (
          <button type="button" className="sensitivity-close" onClick={onClose} title="关闭扫描结果">
            ✕
          </button>
        )}
      </div>

      {nodes.length === 0 || edges.length === 0 ? (
        <p className="hint">先创建节点与至少一条连线，才能扫描边权对目标可信度的影响。</p>
      ) : (
        <>
          <Field label="扫描连线（边权 0→1 等距 21 点）">
            <select
              value={scanSelection.edgeId}
              onChange={(event) => onSelectionChange({ edgeId: event.target.value })}
            >
              {!selectedEdge && <option value="">请选择连线…</option>}
              {edges.map((edge) => (
                <option key={edge.id} value={edge.id}>
                  {edgeLabel(edge)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="目标节点（曲线展示其最终可信度）">
            <select
              value={scanSelection.targetNodeId}
              onChange={(event) => onSelectionChange({ targetNodeId: event.target.value })}
            >
              {!nodes.some((node) => node.id === scanSelection.targetNodeId) && (
                <option value="">请选择目标节点…</option>
              )}
              {nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.data.label}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className="primary sensitivity-run" disabled={!canRun || scanning} onClick={onRun}>
            {scanning ? '扫描中…' : '运行边权扫描'}
          </button>
          <p className="hint">扫描使用上方当前传播参数，只在服务端内存中计算，不会保存或改动当前图。</p>
          {status && <p className="sensitivity-status">{status}</p>}
        </>
      )}

      {scan && (
        <>
          <SensitivityChart
            scan={scan}
            edgeLabel={sensitivity.edgeLabel}
            targetLabel={sensitivity.targetLabel}
          />
          <p className="hint">{scan.message}</p>
        </>
      )}
    </section>
  );
}

type TraceCardProps = Pick<SidePanelProps, 'trace' | 'nodes'> & {
  nodeLabelById: Map<string, string>;
  stanceText: (stance: Stance) => string;
};

const HOP_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

/** 影响路径追踪卡片：选择起始证据与目标节点，枚举至多 8 跳路径，按 |带符号边权乘积| 取前 3 条。 */
function TraceCard({ trace, nodes, nodeLabelById, stanceText }: TraceCardProps) {
  const { selection, onSelectionChange, result, tracing, status, activeIndex, onActiveIndexChange, onRun, onClose } =
    trace;
  const evidenceNodes = nodes.filter((node) => node.data.kind === 'evidence');
  const startExists = evidenceNodes.some((node) => node.id === selection.startNodeId);
  const targetExists = nodes.some((node) => node.id === selection.targetNodeId);
  const canRun =
    startExists && targetExists && selection.startNodeId !== selection.targetNodeId && selection.maxHops >= 1;

  const signMeta: Record<PathSign, { text: string; className: string }> = {
    support: { text: '净支持', className: 'trace-sign support' },
    rebut: { text: '净反驳', className: 'trace-sign rebut' }
  };

  return (
    <section className="panel-card trace-card">
      <div className="sensitivity-heading">
        <h2>影响路径追踪</h2>
        {result && (
          <button type="button" className="sensitivity-close" onClick={onClose} title="关闭追踪结果">
            ✕
          </button>
        )}
      </div>

      {nodes.length === 0 ? (
        <p className="hint">先创建节点（至少一个证据节点）与连线，才能追踪证据对目标的影响路径。</p>
      ) : (
        <>
          <Field label="起始证据（路径从该证据出发）">
            <select
              value={startExists ? selection.startNodeId : ''}
              onChange={(event) => onSelectionChange({ startNodeId: event.target.value })}
            >
              {!startExists && <option value="">请选择证据节点…</option>}
              {evidenceNodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.data.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="目标节点（路径抵达该节点）">
            <select
              value={targetExists ? selection.targetNodeId : ''}
              onChange={(event) => onSelectionChange({ targetNodeId: event.target.value })}
            >
              {!targetExists && <option value="">请选择目标节点…</option>}
              {nodes
                .filter((node) => node.id !== selection.startNodeId)
                .map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.data.label}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="最大跳数（遇到重复节点立即截断）">
            <select
              value={selection.maxHops}
              onChange={(event) => onSelectionChange({ maxHops: Number(event.target.value) })}
            >
              {HOP_OPTIONS.map((hops) => (
                <option key={hops} value={hops}>
                  {hops} 跳
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className="primary sensitivity-run" disabled={!canRun || tracing} onClick={onRun}>
            {tracing ? '追踪中…' : '运行路径追踪'}
          </button>
          <p className="hint">在画布上点击证据节点会自动设为起点、点击观点节点自动设为目标。追踪只在服务端内存中枚举，不会保存或改动当前图。</p>
          {status && <p className="sensitivity-status">{status}</p>}
        </>
      )}

      {result && (
        <div className="trace-result">
          <p className="hint">{result.message}</p>
          {result.paths.length === 0 ? (
            <p className="hint">
              从「{nodeLabelById.get(result.startNodeId) ?? result.startNodeId}」到「
              {nodeLabelById.get(result.targetNodeId) ?? result.targetNodeId}」在 {result.maxHops} 跳内无可达路径。
            </p>
          ) : (
            <ol className="trace-path-list">
              {result.paths.map((path, index) => (
                <li key={path.edgeIds.join('-')}>
                  <button
                    type="button"
                    className={`trace-path-item ${index === activeIndex ? 'active' : ''} trace-${path.sign}`}
                    onClick={() => onActiveIndexChange(index)}
                  >
                    <span className="trace-path-head">
                      <span className="trace-rank">#{index + 1}</span>
                      <span className={signMeta[path.sign].className}>{signMeta[path.sign].text}</span>
                      <strong className={path.score >= 0 ? 'decomp-pos' : 'decomp-neg'}>
                        {path.score >= 0 ? '+' : ''}
                        {path.score.toFixed(4)}
                      </strong>
                    </span>
                    <small>
                      {path.hops} 跳 · {path.rebutCount} 条反驳 · |分数| {path.absoluteScore.toFixed(4)}
                      {result.truncated ? ' · 枚举已截断' : ''}
                    </small>
                    <span className="trace-chain">
                      {path.nodeIds.map((id, nodeIndex) => (
                        <span key={`${id}-${nodeIndex}`} className="trace-chain-node">
                          {nodeIndex > 0 && (
                            <>
                              <em
                                className={`trace-chain-edge stance-text-${path.steps[nodeIndex - 1].stance}`}
                                title={`第 ${nodeIndex} 跳：${stanceText(path.steps[nodeIndex - 1].stance)} 边权 ${path.steps[nodeIndex - 1].weight}，截至本跳累计带符号乘积 ${path.steps[nodeIndex - 1].runningScore.toFixed(4)}`}
                              >
                                {stanceText(path.steps[nodeIndex - 1].stance)}{' '}
                                {Math.round(path.steps[nodeIndex - 1].weight * 100)}%
                              </em>
                              <small className="trace-chain-score">
                                {path.steps[nodeIndex - 1].runningScore >= 0 ? '+' : ''}
                                {path.steps[nodeIndex - 1].runningScore.toFixed(2)}
                              </small>
                            </>
                          )}
                          <span className="trace-chain-label">
                            {nodeIndex === 0 && '🟢 '}
                            {nodeIndex === path.nodeIds.length - 1 && '🎯 '}
                            {nodeLabelById.get(id) ?? id}
                          </span>
                        </span>
                      ))}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

type ShapleyCardProps = Pick<SidePanelProps, 'shapley' | 'nodes'> & {
  nodeLabelById: Map<string, string>;
};

const MAX_SHAPLEY_EVIDENCE = 8;

/** 证据贡献分摊卡片：选择一个观点与至多 8 个证据，对全部联盟重算传播并按精确 Shapley 公式分摊。 */
function ShapleyCard({ shapley, nodes, nodeLabelById }: ShapleyCardProps) {
  const { selection, onSelectionChange, result, running, status, activeNodeId, onToggleNode, onRun, onClose } =
    shapley;
  const claimNodes = nodes.filter((node) => node.data.kind === 'claim');
  const evidenceNodes = nodes.filter((node) => node.data.kind === 'evidence');
  const claimExists = claimNodes.some((node) => node.id === selection.claimNodeId);
  const selectedEvidence = selection.evidenceNodeIds.filter((id) =>
    evidenceNodes.some((node) => node.id === id)
  );
  const canRun = claimExists && selectedEvidence.length >= 1 && selectedEvidence.length <= MAX_SHAPLEY_EVIDENCE;
  const limitReached = selectedEvidence.length >= MAX_SHAPLEY_EVIDENCE;

  const toggleEvidence = (nodeId: string, checked: boolean) => {
    const next = checked
      ? [...selectedEvidence, nodeId]
      : selectedEvidence.filter((id) => id !== nodeId);
    onSelectionChange({ evidenceNodeIds: next });
  };

  return (
    <section className="panel-card shapley-card">
      <div className="sensitivity-heading">
        <h2>证据贡献分摊</h2>
        {result && (
          <button type="button" className="sensitivity-close" onClick={onClose} title="关闭分摊结果">
            ✕
          </button>
        )}
      </div>

      {claimNodes.length === 0 || evidenceNodes.length === 0 ? (
        <p className="hint">先创建至少一个观点节点与一个证据节点，才能分摊证据对观点的贡献。</p>
      ) : (
        <>
          <Field label="目标观点（分摊其最终可信度）">
            <select
              value={claimExists ? selection.claimNodeId : ''}
              onChange={(event) => onSelectionChange({ claimNodeId: event.target.value })}
            >
              {!claimExists && <option value="">请选择观点节点…</option>}
              {claimNodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.data.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="field">
            <span>
              参与证据（{selectedEvidence.length}/{MAX_SHAPLEY_EVIDENCE}）
            </span>
            <div className="shapley-evidence-list">
              {evidenceNodes.map((node) => {
                const checked = selectedEvidence.includes(node.id);
                return (
                  <label key={node.id} className="checkbox shapley-evidence-item">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && limitReached}
                      onChange={(event) => toggleEvidence(node.id, event.target.checked)}
                    />
                    {node.data.label}
                  </label>
                );
              })}
            </div>
          </div>
          <button type="button" className="primary sensitivity-run" disabled={!canRun || running} onClick={onRun}>
            {running ? '分摊中…' : '运行贡献分摊'}
          </button>
          <p className="hint">
            服务端在内存中对全部 2ⁿ 个证据联盟重算传播（未加入联盟的所选证据从图副本删除），沿用当前传播参数，不保存图；任一联盟振荡或达到上限则整体不可计算。
          </p>
          {status && <p className="sensitivity-status">{status}</p>}
        </>
      )}

      {result && !result.computable && result.failure && (
        <div className="shapley-failure" role="alert">
          <strong>整体不可计算</strong>
          <p>
            首个失败联盟：
            {result.failure.evidenceIds.length === 0
              ? '空联盟（未保留任何所选证据）'
              : result.failure.evidenceIds.map((id) => nodeLabelById.get(id) ?? id).join('、')}
          </p>
          <p>
            {result.failure.status === 'oscillating' ? '持续振荡' : '达到迭代上限'}，第{' '}
            {result.failure.iterations} 轮停止。{result.failure.reason}
          </p>
          <p className="hint">未使用该联盟或任何后续联盟的末轮值，分摊结果不予给出。</p>
        </div>
      )}

      {result && result.computable && result.contributions && result.sumCheck && (
        <div className="shapley-result">
          <dl className="decomp-summary">
            <dt>空联盟基准 v(∅)</dt>
            <dd>{result.baselineValue?.toFixed(4)}</dd>
            <dt>全联盟 v(N)</dt>
            <dd>{result.fullValue?.toFixed(4)}</dd>
            <dt>被分摊差值</dt>
            <dd className={(result.totalDifference ?? 0) >= 0 ? 'decomp-pos' : 'decomp-neg'}>
              {signed(result.totalDifference ?? 0)}
            </dd>
            <dt>重算联盟数</dt>
            <dd>{result.coalitionCount}</dd>
          </dl>
          <ShapleyWaterfall
            result={result}
            nodeLabelById={nodeLabelById}
            activeNodeId={activeNodeId}
            onToggleNode={onToggleNode}
          />
          <p className={`decomp-check ${result.sumCheck.matches ? 'ok' : 'bad'}`}>
            {result.sumCheck.matches ? '✓' : '✗'} 和式校验：Σ 贡献 {signed(result.sumCheck.sum, 6)} 与 全联盟−空联盟{' '}
            {signed(result.sumCheck.expected, 6)} 相差 {result.sumCheck.difference.toExponential(2)}，
            {result.sumCheck.matches ? '一致' : '不一致'}
          </p>
        </div>
      )}
    </section>
  );
}

type BottleneckCardProps = Pick<SidePanelProps, 'bottleneck' | 'nodes' | 'edges'> & {
  nodeLabelById: Map<string, string>;
  stanceText: (stance: Stance) => string;
};

/** 必经链路分析卡片：选择目标观点后，服务端精确计算每个瓶颈（节点/连线）覆盖的证据集合。 */
function BottleneckCard({ bottleneck, nodes, edges, nodeLabelById, stanceText }: BottleneckCardProps) {
  const { selection, onSelectionChange, result, running, status, activeKey, onToggle, onRun, onClose } = bottleneck;
  const claimNodes = nodes.filter((node) => node.data.kind === 'claim');
  const evidenceCount = nodes.filter((node) => node.data.kind === 'evidence').length;
  const targetExists = claimNodes.some((node) => node.id === selection.targetNodeId);
  const canRun = targetExists && evidenceCount > 0;

  const edgeById = new Map(edges.map((edge) => [edge.id, edge] as const));

  const bottleneckLabel = (item: BottleneckItem): string => {
    if (item.kind === 'node') return nodeLabelById.get(item.id) ?? item.id;
    const edge = edgeById.get(item.id);
    if (!edge) return item.id;
    const stance = (edge.data?.stance as Stance) ?? 'support';
    return `${nodeLabelById.get(edge.source) ?? edge.source} ${stanceText(stance)}→ ${
      nodeLabelById.get(edge.target) ?? edge.target
    }`;
  };

  return (
    <section className="panel-card bottleneck-card">
      <div className="sensitivity-heading">
        <h2>必经链路分析</h2>
        {result && (
          <button type="button" className="sensitivity-close" onClick={onClose} title="关闭分析结果">
            ✕
          </button>
        )}
      </div>

      {claimNodes.length === 0 || evidenceCount === 0 ? (
        <p className="hint">先创建至少一个观点节点与一个证据节点，才能分析证据到观点的必经链路。</p>
      ) : (
        <>
          <Field label="目标观点（分析各证据到它的必经节点与连线）">
            <select
              value={targetExists ? selection.targetNodeId : ''}
              onChange={(event) => onSelectionChange({ targetNodeId: event.target.value })}
            >
              {!targetExists && <option value="">请选择观点节点…</option>}
              {claimNodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.data.label}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className="primary sensitivity-run" disabled={!canRun || running} onClick={onRun}>
            {running ? '分析中…' : '运行必经链路分析'}
          </button>
          <p className="hint">
            对每个能到达目标的证据，服务端按「删除后不可达」精确求出其所有有向路径共同经过的节点与连线（证据自身与目标不计），环被严格处理而非枚举有限条路径；只在服务端内存中计算，不会保存或改动当前图。
          </p>
          {status && <p className="sensitivity-status">{status}</p>}
        </>
      )}

      {result && (
        <div className="bottleneck-result">
          <p className="hint">{result.message}</p>
          <dl className="decomp-summary">
            <dt>可达目标的证据</dt>
            <dd>{result.reachableEvidenceIds.length}</dd>
            <dt>无法到达目标的证据</dt>
            <dd>{result.unreachableEvidenceIds.length}</dd>
            <dt>必经瓶颈</dt>
            <dd>{result.bottlenecks.length}</dd>
          </dl>

          {result.reachableEvidenceIds.length > 0 && result.bottlenecks.length === 0 && (
            <p className="hint">没有必经瓶颈：任一中间节点或连线都可被某条可达通路绕过。</p>
          )}

          {result.bottlenecks.length > 0 && (
            <ol className="bottleneck-list">
              {result.bottlenecks.map((item) => {
                const key = `${item.kind}:${item.id}`;
                const active = key === activeKey;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className={`bottleneck-item ${active ? 'active' : ''}`}
                      onClick={() => onToggle(active ? null : key)}
                      title={
                        active
                          ? '再次点击取消高亮'
                          : '点击在画布上高亮该瓶颈、目标与覆盖证据'
                      }
                    >
                      <span className="bottleneck-item-head">
                        <span className={`bottleneck-kind ${item.kind}`}>
                          {item.kind === 'node' ? '节点' : '连线'}
                        </span>
                        <strong className="bottleneck-label">{bottleneckLabel(item)}</strong>
                        <span className="bottleneck-count">覆盖 {item.coveredCount}</span>
                      </span>
                      <span className="bottleneck-covered">
                        {item.coveredEvidenceIds.map((id) => (
                          <span key={id} className="bottleneck-chip">
                            {nodeLabelById.get(id) ?? id}
                          </span>
                        ))}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}

          {result.unreachableEvidenceIds.length > 0 && (
            <div className="bottleneck-unreachable">
              <strong>无法到达目标的证据（{result.unreachableEvidenceIds.length}）</strong>
              <span className="bottleneck-covered">
                {result.unreachableEvidenceIds.map((id) => (
                  <span key={id} className="bottleneck-chip muted">
                    {nodeLabelById.get(id) ?? id}
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function graphToDocument(name: string, nodes: Node<ArgumentNodeData>[], edges: Edge[]): GraphDocument {  return {
    version: 1,
    name,
    nodes: nodes.map((node) => ({
      id: node.id,
      label: node.data.label,
      kind: node.data.kind,
      initialBelief: node.data.initialBelief,
      anchored: node.data.anchored,
      positionLocked: Boolean(node.data.positionLocked),
      position: { x: node.position.x, y: node.position.y }
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      stance: (edge.data?.stance as Stance) ?? 'support',
      weight: Number(edge.data?.weight ?? 0.6)
    }))
  };
}
