import type { Edge, Node } from 'reactflow';
import type { PropagateResult, Stance } from '../../shared/graph';
import type { ArgumentNodeData } from './components/ArgumentNode';

export interface EdgeContribution {
  edgeId: string;
  sourceId: string;
  sourceLabel: string;
  stance: Stance;
  weight: number;
  /** 源节点在基准轮的可信度 */
  sourceValue: number;
  /** 有符号贡献：支持为正、反驳为负，即 ±weight × sourceValue */
  signedContribution: number;
}

export interface RoundDecomposition {
  nodeId: string;
  /** 基准轮 t：用第 t 轮的值计算第 t+1 轮 */
  baseRound: number;
  /** 目标轮 t+1 */
  targetRound: number;
  /** 当前已停在最后一轮，分解展示的是最后一次迭代 */
  isLastTransition: boolean;
  anchored: boolean;
  prior: number;
  lambda: number;
  /** 固定节点不参与入边计算，此数组恒为空（不伪造贡献） */
  contributions: EdgeContribution[];
  /** Σ 有符号贡献（未乘 λ） */
  influenceSum: number;
  /** 裁剪前：prior + λ·influenceSum */
  raw: number;
  /** 裁剪到 0..1 后的值 */
  clipped: number;
  /** 裁剪量 = raw − clipped；>0 被上界裁去，<0 被下界抬升 */
  clipAmount: number;
  /** 结果中记录的第 targetRound 轮值，用于核对 */
  recorded: number;
  /** 本地重算与记录是否一致 */
  matches: boolean;
}

const MATCH_EPSILON = 1e-9;

/**
 * 由回放轨迹与当前图在本地重算「第 baseRound → targetRound 轮」的完整分解，
 * 并与服务器记录的轨迹逐位核对。纯函数，不触发任何保存或重新计算。
 */
export function buildRoundDecomposition(
  node: Node<ArgumentNodeData>,
  nodes: Node<ArgumentNodeData>[],
  edges: Edge[],
  result: PropagateResult,
  round: number
): RoundDecomposition | null {
  const trace = result.traces[node.id];
  if (!trace || result.iterations < 1) return null;

  const baseRound = Math.min(Math.max(0, round), result.iterations - 1);
  const targetRound = baseRound + 1;
  const prior = node.data.initialBelief;
  const anchored = Boolean(node.data.anchored);
  const lambda = result.options.lambda;
  const recorded = trace[targetRound] ?? trace[trace.length - 1];

  if (anchored) {
    // 固定节点的值由先验锁定：不列出任何入边贡献。
    return {
      nodeId: node.id,
      baseRound,
      targetRound,
      isLastTransition: round >= result.iterations,
      anchored: true,
      prior,
      lambda,
      contributions: [],
      influenceSum: 0,
      raw: prior,
      clipped: prior,
      clipAmount: 0,
      recorded,
      matches: Math.abs(recorded - prior) <= MATCH_EPSILON
    };
  }

  const labelById = new Map(nodes.map((item) => [item.id, item.data.label] as const));
  const contributions: EdgeContribution[] = edges
    .filter((edge) => edge.target === node.id)
    .map((edge) => {
      const stance = (edge.data?.stance as Stance) ?? 'support';
      const weight = Number(edge.data?.weight ?? 0);
      const sourceTrace = result.traces[edge.source];
      const sourceValue = sourceTrace?.[baseRound] ?? 0;
      const sign = stance === 'support' ? 1 : -1;
      return {
        edgeId: edge.id,
        sourceId: edge.source,
        sourceLabel: labelById.get(edge.source) ?? edge.source,
        stance,
        weight,
        sourceValue,
        signedContribution: sign * weight * sourceValue
      };
    });

  const influenceSum = contributions.reduce((sum, item) => sum + item.signedContribution, 0);
  const raw = prior + lambda * influenceSum;
  const clipped = Math.min(1, Math.max(0, raw));

  return {
    nodeId: node.id,
    baseRound,
    targetRound,
    isLastTransition: round >= result.iterations,
    anchored: false,
    prior,
    lambda,
    contributions,
    influenceSum,
    raw,
    clipped,
    clipAmount: raw - clipped,
    recorded,
    matches: Math.abs(recorded - clipped) <= MATCH_EPSILON
  };
}

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** 可信度 → 红(0) 黄(0.5) 绿(1) 的着色。 */
export function beliefColors(value: number): { tint: string; strong: string } {
  const hue = Math.round(130 * clamp01(value));
  return {
    tint: `hsla(${hue}, 82%, 58%, 0.22)`,
    strong: `hsl(${hue}, 72%, 36%)`
  };
}
