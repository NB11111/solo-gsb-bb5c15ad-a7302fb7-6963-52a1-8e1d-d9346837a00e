import type { GraphDocument, GraphNode, Position } from '../../shared/graph';

/**
 * 一键整理布局（纯前端、纯函数；预览不写 SQLite，确认后由调用方沿用现有保存逻辑）。
 *
 * 算法：
 * 1. 用迭代式 Kosaraju 求出有向图的强连通分量（SCC，含环），并把分量压缩为 DAG；
 * 2. 在 DAG 上按“最长路径”分层（rank = 最长前驱链长度），边整体从左指向右；
 * 3. 每个分量内部：若分量多于 1 个节点，节点围绕分量中心排成等角圆；
 * 4. 固定执行 4 轮重心（barycenter）排序，减少跨层连线交叉：
 *    向下（以前驱分量重心排序）、向上（以后继分量重心排序）交替；
 *    锁定节点所在分量的纵向中心完全固定，作为相邻层的排序锚点；
 * 5. 4 轮排序后做纵向松弛，最后用空间网格兜底，保证未锁定节点彼此不重叠、
 *    也不与锁定节点重叠；锁定节点坐标一个像素都不会被改变。
 */

/** 节点视觉尺寸（与 styles.css 中 .argument-node 对齐，碰撞判定取保守值）。 */
export const NODE_W = 210;
export const NODE_H = 96;
/** 未锁定节点之间允许的最小净间距（中心距按 尺寸 + GAP 判定）。 */
const GAP_X = 24;
const GAP_Y = 20;
const PITCH_X = NODE_W + 150;
const PITCH_Y = NODE_H + 90;
const LAYER_LEFT = 60;
/** 重心排序固定轮数（下、上、下、上）。 */
const BARYCENTER_PASSES = 4;
/** 每轮排序后纵向松弛的迭代次数。 */
const RELAX_ITERATIONS = 28;

export interface LayoutMetrics {
  /** 最终布局里跨层（跨越分量边界）直线段的严格交叉数 */
  crossings: number;
  /** 未锁定节点的移动距离总和（欧氏距离），锁定节点不计 */
  totalDisplacement: number;
  lockedCount: number;
  movedCount: number;
}

export interface LayoutResult {
  /** 节点 id → 整理后坐标（锁定节点坐标与输入逐位相同） */
  positions: Record<string, Position>;
  before: LayoutMetrics;
  after: LayoutMetrics;
}

interface Component {
  nodes: GraphNode[];
  locked: GraphNode[];
  rank: number;
  /** 分量中心（锁定分量中心由锁定节点反推，其余节点排在圆上） */
  cx: number;
  cy: number;
  /** 圆心半径（单节点分量为 0） */
  radius: number;
  /** 排序中的纵向槽位（像素）；锁定分量固定，其余可在松弛中移动 */
  y: number;
  pinned: boolean;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** 迭代式 Kosaraju：返回 SCC 列表（源优先序，确定性）。 */
function stronglyConnectedComponents(nodes: GraphNode[], edges: GraphDocument['edges']): string[][] {
  const n = nodes.length;
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const adj: number[][] = Array.from({ length: n }, () => []);
  const radj: number[][] = Array.from({ length: n }, () => []);
  for (const edge of edges) {
    const u = indexById.get(edge.source);
    const v = indexById.get(edge.target);
    if (u === undefined || v === undefined) continue;
    if (u === v) continue; // 自环不改变 SCC 成员关系
    adj[u].push(v);
    radj[v].push(u);
  }

  // 第一遍 DFS（显式栈）求完成顺序。
  const visited = new Array<boolean>(n).fill(false);
  const order: number[] = [];
  for (let start = 0; start < n; start += 1) {
    if (visited[start]) continue;
    visited[start] = true;
    const stack: Array<{ node: number; next: number }> = [{ node: start, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.next < adj[frame.node].length) {
        const child = adj[frame.node][frame.next];
        frame.next += 1;
        if (!visited[child]) {
          visited[child] = true;
          stack.push({ node: child, next: 0 });
        }
      } else {
        order.push(frame.node);
        stack.pop();
      }
    }
  }

  // 第二遍在反图上按完成序逆序 DFS，收集 SCC。
  const assigned = new Array<boolean>(n).fill(false);
  const components: number[][] = [];
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const start = order[i];
    if (assigned[start]) continue;
    assigned[start] = true;
    const group: number[] = [];
    const stack = [start];
    while (stack.length) {
      const node = stack.pop()!;
      group.push(node);
      for (const child of radj[node]) {
        if (!assigned[child]) {
          assigned[child] = true;
          stack.push(child);
        }
      }
    }
    components.push(group);
  }
  // 保持分量顺序稳定：按分量内最小节点下标排序。
  components.sort((a, b) => Math.min(...a) - Math.min(...b));
  return components.map((group) => group.map((index) => nodes[index].id));
}

/** 把节点均匀放在等角圆上，并选择使角度偏差总和最小的旋转量（含锁定角度约束）。 */
function placeOnCircle(
  component: Component,
  originalCentroid: Position,
  externalAngle: Map<string, number>,
  lockedOffset: Map<string, Position>
): Map<string, Position> {
  const members = component.nodes;
  const k = members.length;
  const result = new Map<string, Position>();
  if (k === 1) {
    result.set(members[0].id, { x: component.cx, y: component.cy });
    return result;
  }

  // 期望角度：优先使用跨分量邻居方向，否则用相对原始质心的角度。
  const desired = members.map((node) => {
    const ext = externalAngle.get(node.id);
    if (ext !== undefined) return ext;
    const dx = node.position.x - originalCentroid.x;
    const dy = node.position.y - originalCentroid.y;
    if (dx === 0 && dy === 0) return 0;
    return Math.atan2(dy, dx);
  });

  // 先按期望角度排序，决定成员在圆上的次序（确定性）。
  const ordered = members
    .map((node, index) => ({ node, angle: desired[index], orderIndex: index }))
    .sort((a, b) => a.angle - b.angle || a.orderIndex - b.orderIndex)
    .map((item) => item.node);

  // 选择整体旋转量 theta0：等角圆上第 p 个（按期望角度排序后的）成员角度为
  // theta0 + 2πp/k。经典最优旋转候选取 theta0 = a_p − 2πp/k；再叠加锁定成员
  // 被锁定位置所确定角度的高权重约束。
  let bestTheta = 0;
  let bestScore = Infinity;
  for (let p = 0; p < k; p += 1) {
    const candidateNode = ordered[p];
    const candidateMemberIndex = members.indexOf(candidateNode);
    const theta0 = desired[candidateMemberIndex] - (2 * Math.PI * p) / k;
    let score = 0;
    ordered.forEach((node, index) => {
      const memberIndex = members.indexOf(node);
      const lockedOffsetPosition = lockedOffset.get(node.id);
      if (lockedOffsetPosition) {
        const lockedAngle = Math.atan2(lockedOffsetPosition.y, lockedOffsetPosition.x);
        score += 1e6 * angleDistance(lockedAngle, theta0 + (2 * Math.PI * index) / k);
      } else {
        score += angleDistance(desired[memberIndex], theta0 + (2 * Math.PI * index) / k);
      }
    });
    if (score < bestScore) {
      bestScore = score;
      bestTheta = theta0;
    }
  }

  const r = component.radius;
  ordered.forEach((node, index) => {
    const offset = lockedOffset.get(node.id);
    if (offset) {
      result.set(node.id, { x: component.cx + offset.x, y: component.cy + offset.y });
    } else {
      const angle = bestTheta + (2 * Math.PI * index) / k;
      result.set(node.id, { x: component.cx + r * Math.cos(angle), y: component.cy + r * Math.sin(angle) });
    }
  });
  return result;
}

function angleDistance(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/** 方向叉积 z 分量。 */
function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/** 两条线段是否严格相交（端点相接 / 共线重叠不计交叉）。 */
function segmentsCross(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denominator = cross(d1x, d1y, d2x, d2y);
  if (denominator === 0) return false; // 平行 / 共线不算交叉
  const t = cross(p3.x - p1.x, p3.y - p1.y, d2x, d2y) / denominator;
  const u = cross(p3.x - p1.x, p3.y - p1.y, d1x, d1y) / denominator;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

/** 统计直线边（节点中心到中心）的两两严格交叉数。 */
export function countCrossings(nodes: GraphNode[], edges: GraphDocument['edges']): number {
  const positionById = new Map(nodes.map((node) => [node.id, node.position]));
  const segments = edges
    .map((edge) => {
      if (edge.source === edge.target) return null;
      const a = positionById.get(edge.source);
      const b = positionById.get(edge.target);
      if (!a || !b) return null;
      return { a, b, key: `${edge.source}|${edge.target}` };
    })
    .filter((item): item is { a: Position; b: Position; key: string } => item !== null);

  let crossings = 0;
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const s1 = segments[i];
      const s2 = segments[j];
      // 共享端点的两条边不可能产生内部交叉。
      if (
        s1.key.split('|')[0] === s2.key.split('|')[0] ||
        s1.key.split('|')[0] === s2.key.split('|')[1] ||
        s1.key.split('|')[1] === s2.key.split('|')[0] ||
        s1.key.split('|')[1] === s2.key.split('|')[1]
      ) {
        continue;
      }
      if (segmentsCross(s1.a, s1.b, s2.a, s2.b)) crossings += 1;
    }
  }
  return crossings;
}

/** 整理前 / 整理后的统一指标。 */
function measure(nodes: GraphNode[], edges: GraphDocument['edges'], origin: Map<string, Position>): LayoutMetrics {
  let totalDisplacement = 0;
  let movedCount = 0;
  let lockedCount = 0;
  for (const node of nodes) {
    if (node.positionLocked) {
      lockedCount += 1;
      continue;
    }
    const from = origin.get(node.id);
    if (from) {
      const distance = Math.hypot(node.position.x - from.x, node.position.y - from.y);
      totalDisplacement += distance;
      if (distance > 0.5) movedCount += 1;
    }
  }
  return {
    crossings: countCrossings(nodes, edges),
    totalDisplacement,
    lockedCount,
    movedCount
  };
}

/**
 * 计算一键整理布局结果。
 * 输入图不会被修改；返回每个节点的新坐标与整理前后指标。
 */
export function planGraphLayout(doc: GraphDocument): LayoutResult {
  // 防御性拷贝 / 规范化：任何非有限坐标都按 0 处理。
  const nodes: GraphNode[] = doc.nodes.map((node) => ({
    ...node,
    position: {
      x: finite(node.position?.x, 0),
      y: finite(node.position?.y, 0)
    },
    positionLocked: Boolean(node.positionLocked)
  }));
  const origin = new Map(nodes.map((node) => [node.id, { ...node.position }]));
  const before = measure(nodes, doc.edges, origin);

  if (nodes.length === 0) {
    return { positions: {}, before, after: before };
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  // 1) SCC 压缩。
  const sccIds = stronglyConnectedComponents(nodes, doc.edges);
  const componentOf = new Map<string, number>();
  sccIds.forEach((memberIds, componentIndex) => {
    memberIds.forEach((id) => componentOf.set(id, componentIndex));
  });

  // 分量之间的有向边（去重、去自环）。
  const condEdges: Array<{ from: number; to: number }> = [];
  const condEdgeKeys = new Set<string>();
  for (const edge of doc.edges) {
    const from = componentOf.get(edge.source);
    const to = componentOf.get(edge.target);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}->${to}`;
    if (!condEdgeKeys.has(key)) {
      condEdgeKeys.add(key);
      condEdges.push({ from, to });
    }
  }
  const successors = sccIds.map(() => new Set<number>());
  const predecessors = sccIds.map(() => new Set<number>());
  condEdges.forEach(({ from, to }) => {
    successors[from].add(to);
    predecessors[to].add(from);
  });

  // 2) DAG 最长路径分层。边从证据 / 原因指向结论，因此起点（无入边）应在最左
  // （rank 0）：rank = 该分量到任意汇点的最长路径长度（用反图上的拓扑松弛）。
  const outdegree = successors.map((set) => set.size);
  const sinkQueue: number[] = [];
  outdegree.forEach((degree, index) => {
    if (degree === 0) sinkQueue.push(index);
  });
  const rank = sccIds.map(() => 0);
  const outDegreeWork = [...outdegree];
  const topoOrder: number[] = [];
  while (sinkQueue.length) {
    const current = sinkQueue.shift()!;
    topoOrder.push(current);
    for (const previous of predecessors[current]) {
      rank[previous] = Math.max(rank[previous], rank[current] + 1);
      outDegreeWork[previous] -= 1;
      if (outDegreeWork[previous] === 0) sinkQueue.push(previous);
    }
  }
  // 理论上压缩图必为 DAG；防御：未排到的分量放到第 0 层。
  sccIds.forEach((_, index) => {
    if (!topoOrder.includes(index)) rank[index] = 0;
  });
  const maxRank = Math.max(0, ...rank);
  const ranks: number[][] = Array.from({ length: maxRank + 1 }, () => []);
  sccIds.forEach((_, componentIndex) => ranks[rank[componentIndex]].push(componentIndex));

  // 3) 构造分量对象与中心初值。
  const components: Component[] = sccIds.map((memberIds, componentIndex) => {
    const members = memberIds.map((id) => nodeById.get(id)!);
    const locked = members.filter((node) => node.positionLocked);
    const pinned = locked.length > 0;
    const mean = (selector: (node: GraphNode) => number) =>
      members.reduce((sum, node) => sum + selector(node), 0) / members.length;
    // 等角圆半径：相邻节点在圆上的弦长（中心距）必须 >= 节点外接矩形对角 + 净距，
    // 保证不同角度摆放的矩形节点（含宽 > 高）在圆上严格不重叠，无需兜底排斥。
    const k = members.length;
    const centerGap = Math.hypot(NODE_W + GAP_X, NODE_H + GAP_Y);
    const radius = k > 1 ? centerGap / (2 * Math.sin(Math.PI / k)) : 0;

    let cx: number;
    let cy: number;
    if (pinned) {
      // 锁定分量中心：单锁定节点时由该节点反推；多锁定节点时取锁定位置均值，
      // 非锁定成员围绕该中心排圆（锁定成员自身保持原位）。
      cx = locked.reduce((sum, node) => sum + node.position.x, 0) / locked.length;
      cy = locked.reduce((sum, node) => sum + node.position.y, 0) / locked.length;
    } else {
      cx = LAYER_LEFT + rank[componentIndex] * PITCH_X;
      cy = mean((node) => node.position.y);
    }
    return {
      nodes: members,
      locked,
      rank: rank[componentIndex],
      cx,
      cy,
      radius,
      y: cy,
      pinned
    };
  });

  // 非锁定层的横向中心线：在最近的两个锁定层之间线性插值。
  const pinnedRankX = new Map<number, number[]>();
  components.forEach((component) => {
    if (component.pinned) {
      const list = pinnedRankX.get(component.rank) ?? [];
      list.push(component.cx);
      pinnedRankX.set(component.rank, list);
    }
  });
  const pinnedRanks = [...pinnedRankX.keys()].sort((a, b) => a - b);
  const pinnedMeanX = (layer: number) => {
    const xs = pinnedRankX.get(layer)!;
    return xs.reduce((sum, value) => sum + value, 0) / xs.length;
  };
  const rankX = ranks.map((_, layerIndex) => {
    if (pinnedRankX.has(layerIndex)) return pinnedMeanX(layerIndex);
    const left = [...pinnedRanks].reverse().find((layer) => layer < layerIndex);
    const right = pinnedRanks.find((layer) => layer > layerIndex);
    if (left !== undefined && right !== undefined) {
      return pinnedMeanX(left) + ((pinnedMeanX(right) - pinnedMeanX(left)) * (layerIndex - left)) / (right - left);
    }
    if (left !== undefined) return Math.max(LAYER_LEFT, pinnedMeanX(left) + (layerIndex - left) * PITCH_X);
    if (right !== undefined) return pinnedMeanX(right) - (right - layerIndex) * PITCH_X;
    return LAYER_LEFT + layerIndex * PITCH_X;
  });

  // 无锁定层整体不允许越过左边界（锁定层本身保持锁定位置，不受此约束）。
  ranks.forEach((_, layerIndex) => {
    if (!pinnedRankX.has(layerIndex)) rankX[layerIndex] = Math.max(LAYER_LEFT, rankX[layerIndex]);
  });

  // 同层含多个分量时，给每个分量一个相对层中心线的横向序号，避免彼此完全重合；
  // 展开幅度取较小系数，整体仍以层中心线为轴。锁定分量严格保持其锁定中心，不挪动。
  const layerSlotIndex = new Map<number, number>();
  ranks.forEach((layer) => {
    const movableOrder = layer.filter((index) => !components[index].pinned);
    movableOrder.forEach((componentIndex, slot) => {
      const offsetCount = movableOrder.length - 1;
      layerSlotIndex.set(componentIndex, slot - offsetCount / 2);
    });
  });
  components.forEach((component, componentIndex) => {
    if (component.pinned) {
      // 锁定分量：中心完全由锁定位置决定，保证锁定节点一个像素都不动。
      component.cx = component.locked.reduce((sum, node) => sum + node.position.x, 0) / component.locked.length;
    } else {
      const slot = layerSlotIndex.get(componentIndex) ?? 0;
      // 同层分量横向错开半步，避免重叠又不至于拉得太散。
      const spread = rankX[component.rank] + slot * PITCH_X * 0.5;
      // 多元分量（圆）按最左成员留出边距，避免圆形整体伸出左边界。
      component.cx = Math.max(LAYER_LEFT + component.radius, spread);
    }
  });

  // 4) 4 轮重心排序。锁定分量作为不动锚点，其余分量以相邻层邻居重心排序。
  const barycenter = (componentIndex: number, downward: boolean): number | undefined => {
    const component = components[componentIndex];
    const neighbors = downward ? predecessors[componentIndex] : successors[componentIndex];
    let sum = 0;
    let count = 0;
    neighbors.forEach((neighborIndex) => {
      if (rank[neighborIndex] === component.rank - (downward ? 1 : -1)) {
        sum += components[neighborIndex].y;
        count += 1;
      }
    });
    // 没有相邻层（参考方向）邻居时不强行给重心，保留其初始纵向位置。
    return count > 0 ? sum / count : undefined;
  };

  const orderRank = (layerIndex: number, downward: boolean): {
    ordered: number[];
    /** 分量 index → 相邻层重心；无相邻层邻居的分量不在此 Map 中（保留初始纵向位置）。 */
    baryById: Map<number, number>;
  } => {
    const layer = ranks[layerIndex];
    const pinnedComponents = layer
      .filter((index) => components[index].pinned)
      .sort((a, b) => components[a].y - components[b].y);
    // 排序键：有相邻层重心用重心，否则用当前纵向位置。
    const movable = layer
      .filter((index) => !components[index].pinned)
      .map((index) => {
        const bary = barycenter(index, downward);
        return { index, bary: bary ?? components[index].y, hasBary: bary !== undefined };
      })
      .sort((a, b) => a.bary - b.bary || a.index - b.index);
    const baryById = new Map<number, number>();
    movable.forEach((item) => {
      if (item.hasBary) baryById.set(item.index, item.bary);
    });

    // 以锁定分量为锚点，把可移动分量按重心插入锚点之间。
    const ordered: number[] = [];
    let cursor = 0;
    const emitAbove = (anchorY: number) => {
      while (cursor < movable.length && movable[cursor].bary <= anchorY) {
        ordered.push(movable[cursor].index);
        cursor += 1;
      }
    };
    for (const pinnedIndex of pinnedComponents) {
      emitAbove(components[pinnedIndex].y);
      ordered.push(pinnedIndex);
    }
    while (cursor < movable.length) {
      ordered.push(movable[cursor].index);
      cursor += 1;
    }
    return { ordered, baryById };
  };

  const minGap = (componentIndex: number, otherIndex: number): number => {
    // 分量纵向占位半径（圆心到最远节点），相邻分量中心距不得小于占位和 + 间距。
    const halfSpan = (component: Component) =>
      component.nodes.length > 1 ? component.radius + NODE_H / 2 : NODE_H / 2;
    return halfSpan(components[componentIndex]) + halfSpan(components[otherIndex]) + GAP_Y;
  };

  for (let pass = 0; pass < BARYCENTER_PASSES; pass += 1) {
    const downward = pass % 2 === 0;
    for (let layer = 0; layer < ranks.length; layer += 1) {
      const layerIndex = downward ? layer : ranks.length - 1 - layer;
      const { ordered, baryById } = orderRank(layerIndex, downward);
      // 赋予纵向槽位：锁定分量保持原位（锚点）；可移动分量直接取相邻层重心，
      // 使其尽量贴合锚点位置。同层碰撞交给随后的松弛与最终排斥处理。
      ordered.forEach((componentIndex) => {
        const component = components[componentIndex];
        if (component.pinned) {
          component.y = component.cy;
        } else {
          const bary = baryById.get(componentIndex);
          // 有相邻层重心则贴重心；否则保持初始纵向位置（原始坐标均值）。
          component.y = bary !== undefined && Number.isFinite(bary) ? bary : component.cy;
        }
      });
      ranks[layerIndex] = ordered;
    }

    // 纵向松弛：沿 DAG 边把相邻层分量往彼此方向轻推（只移动未锁定分量）。
    for (let iteration = 0; iteration < RELAX_ITERATIONS; iteration += 1) {
      for (const { from, to } of condEdges) {
        const a = components[from];
        const b = components[to];
        if (a.pinned && b.pinned) continue;
        const gap = minGap(from, to);
        const delta = b.y - a.y;
        const want = gap * 0.6;
        if (Math.abs(delta) >= want) continue;
        const push = (want - Math.abs(delta)) * (delta >= 0 ? 1 : -1) * 0.35;
        if (!a.pinned && !b.pinned) {
          a.y -= push / 2;
          b.y += push / 2;
        } else if (a.pinned) {
          b.y += push;
        } else {
          a.y -= push;
        }
      }
      // 同层去重叠（保持当前顺序）。
      ranks.forEach((layer) => {
        for (let i = 1; i < layer.length; i += 1) {
          const previous = layer[i - 1];
          const current = layer[i];
          const gap = minGap(previous, current);
          if (components[current].y - components[previous].y < gap) {
            if (components[current].pinned && !components[previous].pinned) {
              components[previous].y = components[current].y - gap;
            } else if (!components[current].pinned) {
              components[current].y = components[previous].y + gap;
            }
          }
        }
      });
    }
  }

  // 5) 分量中心定稿；分量内节点排圆；锁定节点保持原坐标。
  const finalPositions = new Map<string, Position>();
  components.forEach((component, componentIndex) => {
    const lockedOffset = new Map<string, Position>();
    component.locked.forEach((node) => {
      lockedOffset.set(node.id, { x: node.position.x - component.cx, y: node.position.y - component.cy });
    });

    // 跨分量邻居的合成方向（用邻居分量当前中心），用于圆上成员角度排序。
    const externalAngle = new Map<string, number>();
    component.nodes.forEach((node) => {
      let sx = 0;
      let sy = 0;
      let count = 0;
      doc.edges.forEach((edge) => {
        let neighborId: string | null = null;
        if (edge.source === node.id) neighborId = edge.target;
        else if (edge.target === node.id) neighborId = edge.source;
        if (!neighborId) return;
        const neighborComponent = componentOf.get(neighborId);
        if (neighborComponent === undefined || neighborComponent === componentIndex) return;
        sx += components[neighborComponent].cx;
        sy += components[neighborComponent].y;
        count += 1;
      });
      if (count > 0) {
        externalAngle.set(node.id, Math.atan2(sy / count - component.cy, sx / count - component.cx));
      }
    });

    const originalCentroid = {
      x: component.nodes.reduce((sum, node) => sum + node.position.x, 0) / component.nodes.length,
      y: component.nodes.reduce((sum, node) => sum + node.position.y, 0) / component.nodes.length
    };

    const placed = placeOnCircle(component, originalCentroid, externalAngle, lockedOffset);
    component.nodes.forEach((node) => {
      if (node.positionLocked) {
        finalPositions.set(node.id, { x: node.position.x, y: node.position.y });
        return;
      }
      const position = placed.get(node.id)!;
      finalPositions.set(node.id, { x: finite(position.x, component.cx), y: finite(position.y, component.cy) });
    });
  });

  // 6) 兜底去重叠：先做成对排斥（只推未锁定节点），尽量保住分层 / 圆形几何；
  // 若仍有残留（例如巨大 SCC 的跨层碰撞），再把个别节点落到空闲网格单元。
  const movablePosition = (id: string) => finalPositions.get(id)!;
  const boxesOverlap = (a: Position, b: Position) =>
    a.x < b.x + NODE_W + GAP_X &&
    a.x + NODE_W + GAP_X > b.x &&
    a.y < b.y + NODE_H + GAP_Y &&
    a.y + NODE_H + GAP_Y > b.y;

  const movableIds = nodes.filter((node) => !node.positionLocked).map((node) => node.id);
  const lockedIds = new Set(nodes.filter((node) => node.positionLocked).map((node) => node.id));

  // 把未锁定多元 SCC 视为刚体：成员之间已按等角圆严格排布，对外部碰撞的排斥
  // 以“整组平移”实现，圆不变形。单节点分量与（含锁定成员的）固定分量按节点处理。
  const rigidGroupOf = new Map<string, number | null>();
  const rigidGroups: Array<{ memberIds: string[]; fx: number; fy: number }> = [];
  movableIds.forEach((id) => {
    const componentIndex = componentOf.get(id)!;
    const component = components[componentIndex];
    if (!component.pinned && component.nodes.length > 1) {
      rigidGroupOf.set(id, rigidGroups.length);
      rigidGroups.push({ memberIds: component.nodes.filter((node) => !node.positionLocked).map((node) => node.id), fx: 0, fy: 0 });
    } else {
      rigidGroupOf.set(id, null);
    }
  });

  const rectanglePush = (a: Position, b: Position): { x: number; y: number } => {
    const overlapX = NODE_W + GAP_X - Math.abs(a.x - b.x);
    const overlapY = NODE_H + GAP_Y - Math.abs(a.y - b.y);
    if (overlapX <= 0 || overlapY <= 0) return { x: 0, y: 0 };
    // 沿较松的那条轴分开，扰动更小。
    return overlapX < overlapY
      ? { x: (a.x < b.x ? -1 : 1) * overlapX, y: 0 }
      : { x: 0, y: (a.y < b.y ? -1 : 1) * overlapY };
  };

  for (let iteration = 0; iteration < 60; iteration += 1) {
    rigidGroups.forEach((group) => {
      group.fx = 0;
      group.fy = 0;
    });
    const singletonForce = new Map<string, { x: number; y: number }>();
    const addForce = (id: string, push: { x: number; y: number }) => {
      const groupIndex = rigidGroupOf.get(id);
      if (groupIndex !== null && groupIndex !== undefined) {
        rigidGroups[groupIndex].fx += push.x;
        rigidGroups[groupIndex].fy += push.y;
      } else {
        const current = singletonForce.get(id) ?? { x: 0, y: 0 };
        current.x += push.x;
        current.y += push.y;
        singletonForce.set(id, current);
      }
    };

    for (let i = 0; i < movableIds.length; i += 1) {
      const id = movableIds[i];
      const a = movablePosition(id);
      // 与锁定节点碰撞：承担全部位移（锁定节点绝不动）。
      lockedIds.forEach((lockedId) => {
        addForce(id, rectanglePush(a, movablePosition(lockedId)));
      });
      for (let j = 0; j < movableIds.length; j += 1) {
        if (i === j) continue;
        const otherId = movableIds[j];
        // 同一刚体内不互相推。
        if (componentOf.get(id) === componentOf.get(otherId)) continue;
        addForce(id, rectanglePush(a, movablePosition(otherId)));
      }
    }

    let movedAny = false;
    singletonForce.forEach((force, id) => {
      if (force.x === 0 && force.y === 0) return;
      const position = movablePosition(id);
      position.x += force.x * 0.5;
      position.y += force.y * 0.5;
      movedAny = true;
    });
    rigidGroups.forEach((group) => {
      if (group.fx === 0 && group.fy === 0) return;
      group.memberIds.forEach((id) => {
        const position = movablePosition(id);
        position.x += group.fx * 0.5;
        position.y += group.fy * 0.5;
      });
      movedAny = true;
    });
    if (!movedAny) break;
  }

  // 极少数残留碰撞：在排斥后的位置附近做网格步长螺旋搜索，整体平移发生碰撞的组
  // （多元 SCC 作为刚体整体平移，单节点分量则只移动自身）。
  const CELL_W = NODE_W + GAP_X;
  const CELL_H = NODE_H + GAP_Y;
  const lockedRects = nodes
    .filter((node) => node.positionLocked)
    .map((node) => ({
      minX: node.position.x,
      maxX: node.position.x + NODE_W + GAP_X,
      minY: node.position.y,
      maxY: node.position.y + NODE_H + GAP_Y
    }));
  const overlapsLocked = (x: number, y: number) =>
    lockedRects.some((rect) => x < rect.maxX && x + NODE_W + GAP_X > rect.minX && y < rect.maxY && y + NODE_H + GAP_Y > rect.minY);

  // 判断某节点（给定候选位置）是否与锁定节点或其它“视为固定”的未锁定节点碰撞。
  const collidesWith = (candidate: Position, selfId: string, fixedIds: Set<string>) => {
    if (overlapsLocked(candidate.x, candidate.y)) return true;
    for (const otherId of fixedIds) {
      if (otherId === selfId) continue;
      if (boxesOverlap(candidate, movablePosition(otherId))) return true;
    }
    return false;
  };

  // 逐组落位：单节点分量作为单点；多元未锁定 SCC 作为刚体整体平移（保持圆形）。
  const settledGroups: string[][] = [];
  const settledIds = new Set<string>();

  // 刚体组（含全部可移动成员），按分量中心顺序确定性处理。
  const groupUnits = rigidGroups
    .map((group) => ({ ids: group.memberIds, componentIndex: componentOf.get(group.memberIds[0])! }))
    .sort(
      (a, b) =>
        rank[a.componentIndex] - rank[b.componentIndex] ||
        components[a.componentIndex].y - components[b.componentIndex].y
    );
  // 非刚体的单节点（未锁定单节点分量）。
  const singletonIds = movableIds.filter((id) => rigidGroupOf.get(id) === null);

  const placeUnit = (ids: string[]) => {
    // 当前（排斥后）若整组都不与已固定节点碰撞，则原样保留。
    const allClear = ids.every((id) => !collidesWith(movablePosition(id), id, settledIds));
    if (allClear) {
      ids.forEach((id) => settledIds.add(id));
      settledGroups.push(ids);
      return;
    }
    // 以组内首节点为锚，螺旋搜索一个整组平移量，使所有成员都不与已固定节点碰撞。
    const anchor = movablePosition(ids[0]);
    const offsets = ids.map((id) => {
      const p = movablePosition(id);
      return { id, dx: p.x - anchor.x, dy: p.y - anchor.y };
    });
    const tryAnchor = (x: number, y: number): boolean => {
      for (const offset of offsets) {
        if (collidesWith({ x: x + offset.dx, y: y + offset.dy }, offset.id, settledIds)) return false;
      }
      offsets.forEach((offset) => {
        finalPositions.set(offset.id, { x: x + offset.dx, y: y + offset.dy });
      });
      return true;
    };

    const STEP_X = CELL_W;
    const STEP_Y = CELL_H;
    let done = false;
    for (let radius2 = 1; radius2 <= 600 && !done; radius2 += 1) {
      for (let dx = -radius2; dx <= radius2 && !done; dx += 1) {
        for (let dy = -radius2; dy <= radius2 && !done; dy += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius2) continue;
          done = tryAnchor(anchor.x + dx * STEP_X, anchor.y + dy * STEP_Y);
        }
      }
    }
    if (!done) {
      // 理论不可达兜底：向下方新行持续搜索（坐标保持有限）。
      let gy = Math.round(anchor.y / STEP_Y) + 601;
      while (!done) {
        done = tryAnchor(Math.round(anchor.x / STEP_X) * STEP_X, gy * STEP_Y);
        gy += 1;
        if (gy > 1e6) {
          // 极端兜底：直接放到极远独立位置。
          offsets.forEach((offset, index) =>
            finalPositions.set(offset.id, { x: index * STEP_X, y: gy * STEP_Y })
          );
          done = true;
        }
      }
    }
    ids.forEach((id) => settledIds.add(id));
    settledGroups.push(ids);
  };

  // 先处理刚体组，再处理单节点；保证圆形成员作为一个整体被保留。
  groupUnits.forEach((unit) => placeUnit(unit.ids));
  singletonIds.forEach((id) => placeUnit([id]));

  // 最终不变量校验：坐标有限；锁定节点坐标逐位不变。
  finalPositions.forEach((position, id) => {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      const fallback = origin.get(id) ?? { x: 0, y: 0 };
      finalPositions.set(id, { x: finite(fallback.x, 0), y: finite(fallback.y, 0) });
    }
  });
  nodes.forEach((node) => {
    if (node.positionLocked) {
      finalPositions.set(node.id, { x: node.position.x, y: node.position.y });
    }
  });

  const afterNodes = nodes.map((node) => ({
    ...node,
    position: finalPositions.get(node.id)!
  }));
  const after = measure(afterNodes, doc.edges, origin);

  return {
    positions: Object.fromEntries(finalPositions.entries()),
    before,
    after
  };
}

export function formatDisplacement(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return Math.round(value).toString();
}
