import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  InfluencePath,
  PathSign,
  TraceResult,
  TraceStep
} from '../shared/graph.js';

export const DEFAULT_TRACE_MAX_HOPS = 8;
export const MIN_TRACE_MAX_HOPS = 1;
export const MAX_TRACE_MAX_HOPS = 8;
export const TRACE_RESULT_LIMIT = 3;
/**
 * 深度优先枚举的访问次数上限。8 跳简单路径在稠密图上组合爆炸，
 * 超出预算后截断：已枚举到目标的路径仍然有效，结果标记 truncated。
 */
const TRACE_VISIT_BUDGET = 200_000;

/**
 * 校验影响路径追踪的起点与目标节点。
 * 图的严格校验由 validateGraphDocument 在调用处完成；这里只检查选择是否合法。
 */
export function validateTraceSelection(
  graph: GraphDocument,
  startNodeId: unknown,
  targetNodeId: unknown
): { startNode: GraphNode; targetNode: GraphNode } {
  if (typeof startNodeId !== 'string' || !startNodeId.trim()) {
    throw new Error('缺少起始证据节点 startNodeId。');
  }
  if (typeof targetNodeId !== 'string' || !targetNodeId.trim()) {
    throw new Error('缺少目标节点 targetNodeId。');
  }
  const startNode = graph.nodes.find((node) => node.id === startNodeId);
  if (!startNode) throw new Error(`起始节点「${startNodeId}」不存在，无法追踪。`);
  if (startNode.kind !== 'evidence') {
    throw new Error('起始节点必须是证据（evidence）节点。');
  }
  const targetNode = graph.nodes.find((node) => node.id === targetNodeId);
  if (!targetNode) throw new Error(`目标节点「${targetNodeId}」不存在，无法追踪。`);
  if (startNode.id === targetNode.id) {
    throw new Error('起始证据与目标节点不能是同一个节点。');
  }
  return { startNode, targetNode };
}

export function validateMaxHops(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_TRACE_MAX_HOPS;
  const number = Number(value);
  if (!Number.isInteger(number) || number < MIN_TRACE_MAX_HOPS || number > MAX_TRACE_MAX_HOPS) {
    throw new Error(`最大跳数必须是 ${MIN_TRACE_MAX_HOPS} 到 ${MAX_TRACE_MAX_HOPS} 之间的整数。`);
  }
  return number;
}

interface RuntimeEdge extends GraphEdge {
  signedWeight: number;
}

/** 维持按 |score| 降序的前 3 名候选；同分时跳数短、节点序列字典序小者优先，保证结果确定。 */
class TopPaths {
  private items: InfluencePath[] = [];

  constructor(readonly limit: number) {}

  get size(): number {
    return this.items.length;
  }

  /** 当前门槛的 |score|；不足 limit 条时返回 -1（任何路径都可入选）。 */
  get threshold(): number {
    return this.items.length < this.limit ? -1 : this.items[this.items.length - 1].absoluteScore;
  }

  consider(candidate: InfluencePath): void {
    let insertAt = this.items.length;
    for (let index = 0; index < this.items.length; index += 1) {
      const current = this.items[index];
      if (this.ranksAbove(candidate, current)) {
        insertAt = index;
        break;
      }
    }
    if (insertAt < this.limit) {
      this.items.splice(insertAt, 0, candidate);
      if (this.items.length > this.limit) this.items.pop();
    }
  }

  toArray(): InfluencePath[] {
    return [...this.items];
  }

  private ranksAbove(candidate: InfluencePath, current: InfluencePath): boolean {
    if (candidate.absoluteScore !== current.absoluteScore) {
      return candidate.absoluteScore > current.absoluteScore;
    }
    if (candidate.hops !== current.hops) return candidate.hops < current.hops;
    return candidate.nodeIds.join('') < current.nodeIds.join('');
  }
}

const normalizeZero = (value: number) => (Object.is(value, -0) ? 0 : value);

/**
 * 影响路径追踪：从起始证据出发枚举至多 maxHops 跳的有向简单路径，
 * 路径影响分数 = Π 有符号边权（支持 +weight、反驳 -weight）；
 * 一旦下一跳会走到当前路径上已出现的节点立即截断，避免任何有向环。
 */
export function traceInfluencePaths(
  graph: GraphDocument,
  startNodeId: string,
  targetNodeId: string,
  suppliedMaxHops: number = DEFAULT_TRACE_MAX_HOPS
): TraceResult {
  validateTraceSelection(graph, startNodeId, targetNodeId);
  const maxHops = validateMaxHops(suppliedMaxHops);

  const indexById = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const outgoing: RuntimeEdge[][] = graph.nodes.map(() => []);
  graph.edges.forEach((edge) => {
    const sourceIndex = indexById.get(edge.source);
    if (sourceIndex !== undefined) {
      outgoing[sourceIndex].push({
        ...edge,
        signedWeight: edge.stance === 'support' ? edge.weight : -edge.weight
      });
    }
  });
  // 邻接表按边 id 排序，使同分路径的枚举顺序确定。
  outgoing.forEach((list) => list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

  const top = new TopPaths(TRACE_RESULT_LIMIT);
  let enumeratedPaths = 0;
  let visits = 0;
  let budgetExhausted = false;

  interface Frame {
    nodeIndex: number;
    edgeIndex: number;
  }

  const startIndex = indexById.get(startNodeId)!;
  const targetIndex = indexById.get(targetNodeId)!;
  const visited = new Set<number>([startIndex]);
  const pathNodes: number[] = [startIndex];
  const pathEdges: RuntimeEdge[] = [];
  // 走到每个节点时的累计带符号乘积；pathScores[0] = 1。
  const pathScores: number[] = [1];
  const stack: Frame[] = [{ nodeIndex: startIndex, edgeIndex: 0 }];
  let depth = 0;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const candidates = outgoing[frame.nodeIndex];

    if (frame.edgeIndex >= candidates.length) {
      // 回溯：弹出当前节点（根帧除外，根帧没有入边）。
      stack.pop();
      if (stack.length > 0) {
        pathEdges.pop();
        pathNodes.pop();
        pathScores.pop();
        visited.delete(frame.nodeIndex);
        depth -= 1;
      }
      continue;
    }

    const edge = candidates[frame.edgeIndex];
    frame.edgeIndex += 1;
    const nextIndex = indexById.get(edge.target)!;

    // 遇到重复节点立即截断：不进入、不入栈，天然杜绝环。
    if (visited.has(nextIndex)) continue;
    // 已达最大跳数，不能再延伸。
    if (depth + 1 > maxHops) continue;

    visits += 1;
    if (visits > TRACE_VISIT_BUDGET) {
      budgetExhausted = true;
      break;
    }

    const nextScore = pathScores[pathScores.length - 1] * edge.signedWeight;
    pathNodes.push(nextIndex);
    pathEdges.push(edge);
    pathScores.push(nextScore);
    visited.add(nextIndex);
    depth += 1;

    if (nextIndex === targetIndex) {
      enumeratedPaths += 1;
      const score = normalizeZero(nextScore);
      const rebutCount = pathEdges.reduce((count, item) => count + (item.stance === 'rebut' ? 1 : 0), 0);
      const steps: TraceStep[] = [];
      let running = 1;
      for (const item of pathEdges) {
        running = normalizeZero(running * item.signedWeight);
        steps.push({
          edgeId: item.id,
          sourceId: item.source,
          targetId: item.target,
          stance: item.stance,
          weight: item.weight,
          runningScore: running
        });
      }
      const sign: PathSign = rebutCount % 2 === 0 ? 'support' : 'rebut';
      top.consider({
        nodeIds: pathNodes.map((index) => graph.nodes[index].id),
        edgeIds: pathEdges.map((item) => item.id),
        hops: pathEdges.length,
        steps,
        score,
        absoluteScore: Math.abs(score),
        sign,
        rebutCount
      });
      // 抵达目标即结束本分支：目标不再作为路径中间节点继续延伸。
      pathNodes.pop();
      pathEdges.pop();
      pathScores.pop();
      visited.delete(nextIndex);
      depth -= 1;
      continue;
    }

    // 边权绝对值 ≤ 1，延伸只会让 |乘积| 更小；已凑齐 3 条且当前累计已不超过门槛时剪枝。
    if (top.size >= top.limit && Math.abs(nextScore) <= top.threshold) {
      pathNodes.pop();
      pathEdges.pop();
      pathScores.pop();
      visited.delete(nextIndex);
      depth -= 1;
      continue;
    }

    stack.push({ nodeIndex: nextIndex, edgeIndex: 0 });
  }

  const paths = top.toArray();
  const startLabel = graph.nodes[startIndex].label;
  const targetLabel = graph.nodes[targetIndex].label;
  const message =
    enumeratedPaths === 0
      ? `从「${startLabel}」出发在 ${maxHops} 跳内没有任何有向路径抵达「${targetLabel}」（重复节点已截断）。`
      : `枚举到 ${enumeratedPaths} 条${budgetExhausted ? '（达到遍历上限后截断）' : ''}抵达「${targetLabel}」的简单路径，` +
        `已返回绝对影响最大的前 ${paths.length} 条。`;

  return {
    startNodeId,
    targetNodeId,
    maxHops,
    paths,
    enumeratedPaths,
    truncated: budgetExhausted,
    message
  };
}
