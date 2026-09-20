import { analyzeBottlenecks } from '../server/bottleneck.js';
import type { GraphDocument, GraphEdge, GraphNode } from '../shared/graph.js';

// 暴力参考实现：枚举全部简单路径（小图），直接统计每条路径共同经过的节点/边。
function bruteForce(g: GraphDocument, target: string) {
  const ids = g.nodes.map((n) => n.id);
  const out = new Map<string, GraphEdge[]>();
  ids.forEach((id) => out.set(id, []));
  g.edges.forEach((e) => out.get(e.source)!.push(e));
  const evidences = ids.filter((id) => g.nodes.find((n) => n.id === id)!.kind === 'evidence');

  const perEvidence = new Map<string, { nodes: Set<string>; edges: Set<string> }>();
  const unreachable: string[] = [];

  for (const s of evidences) {
    if (s === target) continue;
    let anyPath = false;
    let commonNodes = new Set<string>();
    let commonEdges = new Set<string>();
    let first = true;
    const dfs = (u: string, pathNodes: Set<string>, pathEdges: GraphEdge[]) => {
      if (u === target) {
        anyPath = true;
        const nodeSet = new Set(pathNodes);
        const edgeSet = new Set(pathEdges.map((e) => e.id));
        if (first) {
          commonNodes = new Set(nodeSet);
          commonEdges = new Set(edgeSet);
          first = false;
        } else {
          commonNodes = new Set([...commonNodes].filter((x) => nodeSet.has(x)));
          commonEdges = new Set([...commonEdges].filter((x) => edgeSet.has(x)));
        }
        return;
      }
      for (const e of out.get(u) ?? []) {
        if (pathNodes.has(e.target)) continue;
        pathNodes.add(e.target);
        pathEdges.push(e);
        dfs(e.target, pathNodes, pathEdges);
        pathEdges.pop();
        pathNodes.delete(e.target);
      }
    };
    dfs(s, new Set([s]), []);
    if (!anyPath) unreachable.push(s);
    else {
      commonNodes.delete(s);
      commonNodes.delete(target);
      perEvidence.set(s, { nodes: commonNodes, edges: commonEdges });
    }
  }

  // 汇总：节点/边 → 覆盖证据集合
  const cover = new Map<string, Set<string>>();
  perEvidence.forEach((sets, ev) => {
    [...sets.nodes].forEach((n) => {
      if (!cover.has(`node:${n}`)) cover.set(`node:${n}`, new Set());
      cover.get(`node:${n}`)!.add(ev);
    });
    [...sets.edges].forEach((e) => {
      if (!cover.has(`edge:${e}`)) cover.set(`edge:${e}`, new Set());
      cover.get(`edge:${e}`)!.add(ev);
    });
  });
  return { cover, unreachable: unreachable.sort() };
}

function randomGraph(seed: number): { g: GraphDocument; target: string } {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const n = 4 + Math.floor(rand() * 7);
  const nodes: GraphNode[] = [];
  for (let i = 0; i < n; i += 1) {
    const kind = i < 2 + Math.floor(rand() * 2) ? 'evidence' : 'claim';
    nodes.push({
      id: `n${i}`,
      label: `n${i}`,
      kind,
      initialBelief: 0.5,
      anchored: false,
      position: { x: i * 50, y: 0 }
    });
  }
  const claims = nodes.filter((x) => x.kind === 'claim');
  const target = claims[claims.length - 1]?.id ?? nodes[nodes.length - 1].id;
  const edges: GraphEdge[] = [];
  let edgeNo = 0;
  const seenPairs = new Set<string>();
  for (const a of nodes) {
    for (const b of nodes) {
      if (rand() < 0.22) {
        // 允许自环；允许平行边（同对节点两条）。
        edges.push({
          id: `e${edgeNo++}`,
          source: a.id,
          target: b.id,
          stance: 'support',
          weight: 0.6
        });
        seenPairs.add(`${a.id}>${b.id}`);
        if (rand() < 0.15) {
          edges.push({ id: `e${edgeNo++}`, source: a.id, target: b.id, stance: 'rebut', weight: 0.4 });
        }
      }
    }
  }
  return { g: { version: 1, nodes, edges }, target };
}

let failures = 0;
for (let seed = 1; seed <= 4000; seed += 1) {
  const { g, target } = randomGraph(seed);
  let result;
  try {
    result = analyzeBottlenecks(g, target);
  } catch (error) {
    // 无证据节点时服务端抛错是允许的。
    if (g.nodes.some((n) => n.kind === 'evidence')) {
      failures += 1;
      console.error(`seed ${seed}: 意外异常`, error);
    }
    continue;
  }
  const brute = bruteForce(g, target);
  const mine = new Map<string, Set<string>>();
  for (const item of result.items) {
    mine.set(`${item.kind}:${item.nodeId ?? item.edgeId}`, new Set(item.coveredEvidenceIds));
  }
  const allKeys = new Set([...brute.cover.keys(), ...mine.keys()]);
  let mismatch = false;
  for (const key of allKeys) {
    const a = [...(brute.cover.get(key) ?? new Set())].sort();
    const b = [...(mine.get(key) ?? new Set())].sort();
    if (a.length === 0 && b.length === 0) continue;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      mismatch = true;
      console.error(`seed ${seed} key ${key}: brute=${JSON.stringify(a)} mine=${JSON.stringify(b)}`);
    }
  }
  if (JSON.stringify(result.unreachableEvidenceIds) !== JSON.stringify(brute.unreachable)) {
    mismatch = true;
    console.error(
      `seed ${seed} unreachable: brute=${JSON.stringify(brute.unreachable)} mine=${JSON.stringify(
        result.unreachableEvidenceIds
      )}`
    );
  }
  if (mismatch) {
    failures += 1;
    console.error('graph:', JSON.stringify({ n: g.nodes.map((x) => [x.id, x.kind[0]]), e: g.edges.map((x) => `${x.source}>${x.target}(${x.id})`) }));
    if (failures > 10) break;
  }
}
if (failures > 0) {
  console.error(`\n${failures} 个随机图不一致`);
  process.exit(1);
}
console.log('4000 个随机图全部与暴力枚举一致（含自环 / 平行边 / 环 / 不可归约 SCC）');
