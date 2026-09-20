import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  NodeKind,
  PropagateOptions,
  PropagateResult,
  PropagationCycle,
  Stance
} from '../shared/graph.js';

export const DEFAULT_PROPAGATION_OPTIONS: Required<PropagateOptions> = {
  threshold: 0.001,
  maxIterations: 200,
  lambda: 0.8
};

interface RuntimeEdge extends GraphEdge {
  signedWeight: number;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateGraphDocument(value: unknown): GraphDocument {
  if (!value || typeof value !== 'object') {
    throw new Error('JSON 根对象必须包含 nodes 与 edges 数组。');
  }
  const input = value as Partial<GraphDocument>;
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw new Error('JSON 根对象必须包含 nodes 与 edges 数组。');
  }
  if (input.nodes.length > 500) throw new Error('节点数量不能超过 500。');
  if (input.edges.length > 1500) throw new Error('连线数量不能超过 1500。');

  const nodes: GraphNode[] = input.nodes.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`节点 #${index + 1} 不是对象。`);
    const node = raw as Partial<GraphNode>;
    if (typeof node.id !== 'string' || !node.id.trim()) {
      throw new Error(`节点 #${index + 1} 缺少有效 id。`);
    }
    const id = node.id.trim();
    if (id.length > 80) throw new Error(`节点 id「${id}」长度不能超过 80。`);
    const kind = node.kind === 'evidence' ? 'evidence' : 'claim';
    if (node.kind !== undefined && node.kind !== 'claim' && node.kind !== 'evidence') {
      throw new Error(`节点「${id}」的 kind 必须是 claim 或 evidence。`);
    }
    if (typeof node.label !== 'string' || !node.label.trim()) {
      throw new Error(`节点「${id}」缺少标签 label。`);
    }
    if (node.label.length > 160) throw new Error(`节点「${id}」标签过长。`);
    if (!finiteNumber(node.initialBelief) || node.initialBelief < 0 || node.initialBelief > 1) {
      throw new Error(`节点「${id}」的 initialBelief 必须是 0 到 1 的数字。`);
    }
    const x = finiteNumber(node.position?.x) ? node.position.x : 0;
    const y = finiteNumber(node.position?.y) ? node.position.y : 0;
    return {
      id,
      label: node.label,
      kind: kind as NodeKind,
      initialBelief: node.initialBelief,
      anchored: Boolean(node.anchored),
      positionLocked: Boolean(node.positionLocked),
      position: { x, y }
    };
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) throw new Error('节点 id 必须唯一。');

  const edges: GraphEdge[] = input.edges.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`连线 #${index + 1} 不是对象。`);
    const edge = raw as Partial<GraphEdge>;
    if (typeof edge.source !== 'string' || !nodeIds.has(edge.source)) {
      throw new Error(`连线 #${index + 1} 的 source 不存在。`);
    }
    if (typeof edge.target !== 'string' || !nodeIds.has(edge.target)) {
      throw new Error(`连线 #${index + 1} 的 target 不存在。`);
    }
    const stance: Stance = edge.stance === 'rebut' ? 'rebut' : 'support';
    if (edge.stance !== undefined && edge.stance !== 'support' && edge.stance !== 'rebut') {
      throw new Error(`连线 #${index + 1} 的 stance 必须是 support 或 rebut。`);
    }
    if (!finiteNumber(edge.weight) || edge.weight < 0 || edge.weight > 1) {
      throw new Error(`连线 #${index + 1} 的 weight 必须是 0 到 1 的数字。`);
    }
    const id = typeof edge.id === 'string' && edge.id.trim() ? edge.id : `e-${index + 1}-${edge.source}-${edge.target}`;
    return { id: id.trim(), source: edge.source, target: edge.target, stance, weight: edge.weight };
  });

  const edgeIds = new Set(edges.map((edge) => edge.id));
  if (edgeIds.size !== edges.length) throw new Error('连线 id 必须唯一。');

  return {
    version: 1,
    name: typeof input.name === 'string' ? input.name.slice(0, 120) : undefined,
    nodes,
    edges
  };
}

export function validateOptions(value: unknown): Required<PropagateOptions> {
  const input = (value ?? {}) as Partial<PropagateOptions>;
  const read = (candidate: unknown, fallback: number, min: number, max: number) => {
    if (candidate === undefined || candidate === null || candidate === '') return fallback;
    const number = Number(candidate);
    if (!Number.isFinite(number) || number < min || number > max) {
      throw new Error(`传播参数必须位于 ${min} 到 ${max} 之间。`);
    }
    return number;
  };
  return {
    threshold: read(input.threshold, DEFAULT_PROPAGATION_OPTIONS.threshold, 0.00001, 0.2),
    maxIterations: Math.round(read(input.maxIterations, DEFAULT_PROPAGATION_OPTIONS.maxIterations, 2, 1000)),
    lambda: read(input.lambda, DEFAULT_PROPAGATION_OPTIONS.lambda, 0, 1)
  };
}

function vectorsClose(a: number[], b: number[], tolerance: number): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i] - b[i]) > tolerance) return false;
  }
  return true;
}

function detectPeriod(history: number[][], tolerance: number): number | null {
  // 只检查最近若干轮，早期衰减瞬态不会误判为持续振荡。
  const maxPeriod = 12;
  if (history.length < Math.max(6, maxPeriod * 2)) return null;
  for (let period = 2; period <= maxPeriod; period += 1) {
    if (history.length < period * 2 + 2) continue;
    let matched = 0;
    let comparisons = 0;
    for (let i = history.length - 1; i >= history.length - period - 2; i -= 1) {
      if (i - period >= 0) {
        comparisons += 1;
        if (vectorsClose(history[i], history[i - period], tolerance)) matched += 1;
      }
    }
    if (comparisons > 0 && matched === comparisons) return period;
  }
  return null;
}

function nodeActivity(history: number[][], indexById: Map<string, number>, period: number | null): Map<string, number> {
  const windowSize = period ? Math.max(period * 2, 2) : Math.min(4, history.length - 1);
  const result = new Map<string, number>();
  for (const [id, index] of indexById) {
    let total = 0;
    let count = 0;
    for (let i = history.length - 1; i > history.length - 1 - windowSize && i > 0; i -= 1) {
      total += Math.abs(history[i][index] - history[i - 1][index]);
      count += 1;
    }
    result.set(id, count ? total / count : 0);
  }
  return result;
}

function findNegativeCycles(
  graph: GraphDocument,
  history: number[][],
  indexById: Map<string, number>,
  period: number | null,
  threshold: number
): PropagationCycle[] {
  const runtimeEdges: RuntimeEdge[] = graph.edges.map((edge) => ({
    ...edge,
    signedWeight: edge.stance === 'support' ? edge.weight : -edge.weight
  }));
  const count = graph.nodes.length;
  const adjacency: RuntimeEdge[][] = Array.from({ length: count }, () => []);
  runtimeEdges.forEach((edge) => {
    const sourceIndex = indexById.get(edge.source)!;
    const targetIndex = indexById.get(edge.target)!;
    // 固定节点不会把入边影响再传出，因此不可能位于振荡反馈环中。
    if (!graph.nodes[sourceIndex].anchored && !graph.nodes[targetIndex].anchored) {
      adjacency[sourceIndex].push(edge);
    }
  });

  const activityById = nodeActivity(history, indexById, period);
  const activityLimit = Math.max(0.03, threshold * 3);
  const activeStarts = graph.nodes
    .map((node, index) => ({
      index,
      activity: activityById.get(node.id) ?? 0
    }))
    .filter((item) => item.activity > activityLimit)
    .sort((a, b) => b.activity - a.activity)
    .map((item) => item.index);

  /**
   * 在“节点 × 反驳奇偶性”的二部状态图上做 BFS。
   * 从 (start, 偶) 到达 (start, 奇) 等价于找到一条含奇数条反驳边的闭合游走。
   */
  const findOddClosedWalk = (start: number, forbidden: Set<string>): RuntimeEdge[] | null => {
    const visited: boolean[][] = Array.from({ length: 2 }, () => Array<boolean>(count).fill(false));
    const parentEdge: (RuntimeEdge | null)[][] = Array.from({ length: 2 }, () =>
      Array<RuntimeEdge | null>(count).fill(null)
    );
    const queue: Array<{ node: number; parity: 0 | 1 }> = [{ node: start, parity: 0 }];
    visited[0][start] = true;

    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head];
      for (const edge of adjacency[current.node]) {
        if (forbidden.has(edge.id)) continue;
        const target = indexById.get(edge.target)!;
        const nextParity = ((current.parity + (edge.stance === 'rebut' ? 1 : 0)) % 2) as 0 | 1;
        if (target === start && nextParity === 1) {
          const walk: RuntimeEdge[] = [edge];
          let node = current.node;
          let parity = current.parity;
          while (node !== start || parity !== 0) {
            const parent = parentEdge[parity][node];
            if (!parent) return null;
            walk.push(parent);
            node = indexById.get(parent.source)!;
            parity = ((parity - (parent.stance === 'rebut' ? 1 : 0) + 2) % 2) as 0 | 1;
          }
          return walk.reverse();
        }
        if (!visited[nextParity][target]) {
          visited[nextParity][target] = true;
          parentEdge[nextParity][target] = edge;
          queue.push({ node: target, parity: nextParity });
        }
      }
    }
    return null;
  };

  // 闭合游走可能套着偶数边子环；删除这些偶段子游走后得到奇数简单环。
  const reduceOddWalk = (initialWalk: RuntimeEdge[]): { nodes: number[]; edges: RuntimeEdge[] } | null => {
    let edges = [...initialWalk];
    let nodes = [indexById.get(edges[0]?.source ?? '')!];
    edges.forEach((edge) => nodes.push(indexById.get(edge.target)!));
    if (nodes[0] !== nodes[nodes.length - 1] || edges.length % 2 !== 1) return null;

    let changed = true;
    while (changed) {
      changed = false;
      const lastPosition = new Map<number, number>();
      for (let t = 0; t < nodes.length - 1; t += 1) {
        const previous = lastPosition.get(nodes[t]);
        if (previous !== undefined) {
          if ((t - previous) % 2 === 0) {
            // 删除偶数边子环，保留外部奇数闭合游走。
            edges.splice(previous, t - previous);
            nodes.splice(previous + 1, t - previous);
          } else {
            // 奇数边子环本身就是更短候选，递归化简它。
            edges = edges.slice(previous, t);
            nodes = nodes.slice(previous, t + 1);
          }
          changed = true;
          break;
        }
        lastPosition.set(nodes[t], t);
      }
    }

    const unique = new Set(nodes.slice(0, -1));
    if (unique.size !== nodes.length - 1 || edges.length !== nodes.length - 1 || edges.length % 2 !== 1) {
      return null;
    }
    return { nodes, edges };
  };

  const cycles: PropagationCycle[] = [];
  const seenCycleKeys = new Set<string>();
  const forbiddenEdgeIds = new Set<string>();

  for (const start of activeStarts.length ? activeStarts : graph.nodes.map((_, index) => index)) {
    if (cycles.length >= 24) break;
    const walk = findOddClosedWalk(start, forbiddenEdgeIds);
    if (!walk) continue;
    const reduced = reduceOddWalk(walk);
    if (!reduced) continue;

    const cycleNodeIndexes = reduced.nodes.slice(0, -1);
    const rebutCount = reduced.edges.filter((edge) => edge.stance === 'rebut').length;
    if (rebutCount % 2 !== 1) continue;
    const signedGain = reduced.edges.reduce((product, edge) => product * edge.signedWeight, 1);
    if (Math.abs(signedGain) < 0.05) continue;
    const activity =
      cycleNodeIndexes.reduce((sum, nodeIndex) => sum + (activityById.get(graph.nodes[nodeIndex].id) ?? 0), 0) /
      cycleNodeIndexes.length;
    if (activity < activityLimit) continue;

    const key = reduced.edges.map((edge) => edge.id).sort().join('|');
    if (seenCycleKeys.has(key)) continue;
    seenCycleKeys.add(key);
    reduced.edges.forEach((edge) => forbiddenEdgeIds.add(edge.id));
    cycles.push({
      nodeIds: cycleNodeIndexes.map((nodeIndex) => graph.nodes[nodeIndex].id),
      edgeIds: reduced.edges.map((edge) => edge.id),
      rebutCount,
      signedGain,
      activity
    });
  }

  cycles.sort((a, b) => b.activity - a.activity || Math.abs(b.signedGain) - Math.abs(a.signedGain));
  return cycles;
}

export function propagateBeliefs(graph: GraphDocument, suppliedOptions?: PropagateOptions): PropagateResult {
  const options = validateOptions(suppliedOptions);
  const ids = graph.nodes.map((node) => node.id);
  const indexById = new Map(ids.map((id, index) => [id, index]));
  const priors = graph.nodes.map((node) => node.initialBelief);
  const anchored = graph.nodes.map((node) => node.anchored);
  const incoming = ids.map(() => [] as RuntimeEdge[]);
  graph.edges.forEach((edge) => {
    const targetIndex = indexById.get(edge.target);
    if (targetIndex !== undefined) {
      incoming[targetIndex].push({
        ...edge,
        signedWeight: edge.stance === 'support' ? edge.weight : -edge.weight
      });
    }
  });

  let beliefs = [...priors];
  const traces: Record<string, number[]> = Object.fromEntries(ids.map((id) => [id, [beliefs[indexById.get(id)!]]]));
  const history: number[][] = [[...beliefs]];
  let maxChange = 1;
  let converged = false;
  let detectedPeriod: number | null = null;
  let iterations = 0;

  for (iterations = 1; iterations <= options.maxIterations; iterations += 1) {
    const next = beliefs.map((current, index) => {
      if (anchored[index]) return priors[index];
      let supportInfluence = 0;
      let rebutInfluence = 0;
      for (const edge of incoming[index]) {
        const sourceBelief = beliefs[indexById.get(edge.source)!];
        if (edge.stance === 'support') supportInfluence += edge.weight * sourceBelief;
        else rebutInfluence += edge.weight * sourceBelief;
      }
      const raw = priors[index] + options.lambda * (supportInfluence - rebutInfluence);
      return Math.min(1, Math.max(0, raw));
    });

    maxChange = next.reduce((largest, value, index) => Math.max(largest, Math.abs(value - beliefs[index])), 0);
    beliefs = next;
    history.push([...beliefs]);
    ids.forEach((id) => traces[id].push(beliefs[indexById.get(id)!]));

    if (maxChange < options.threshold) {
      converged = true;
      break;
    }

    detectedPeriod = detectPeriod(history, Math.max(options.threshold * 2.5, 0.002));
    if (detectedPeriod !== null && iterations >= 8) break;
  }

  const hitLimit = iterations >= options.maxIterations && !converged;
  const oscillating = detectedPeriod !== null || (hitLimit && maxChange > options.threshold * 10);
  const cycles = oscillating
    ? findNegativeCycles(graph, history, indexById, detectedPeriod, options.threshold)
    : [];

  const finalBeliefs = Object.fromEntries(ids.map((id) => [id, beliefs[indexById.get(id)!]]));
  const message = converged
    ? `在第 ${iterations} 轮收敛，最大变化 ${maxChange.toFixed(5)}。`
    : oscillating
      ? detectedPeriod
        ? `第 ${iterations} 轮检测到周期约为 ${detectedPeriod} 的持续振荡，已停止并高亮负反馈环。`
        : `达到 ${options.maxIterations} 轮上限仍未稳定，已高亮可疑负反馈环。`
      : `达到迭代上限但已接近稳定（最大变化 ${maxChange.toFixed(5)}）。`;

  return {
    converged,
    oscillating,
    iterations,
    finalBeliefs,
    traces,
    maxChange,
    detectedPeriod,
    cycles,
    options,
    message
  };
}
