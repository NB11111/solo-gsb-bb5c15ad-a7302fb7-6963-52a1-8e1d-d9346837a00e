import { analyzeBottlenecks } from '../server/bottleneck.js';
import type { GraphDocument, GraphEdge, GraphNode } from '../shared/graph.js';

let failures = 0;

function makeGraph(nodes: Array<[string, 'claim' | 'evidence']>, edges: Array<[string, string, string?]>): GraphDocument {
  const nodeList: GraphNode[] = nodes.map(([id, kind], index) => ({
    id,
    label: id,
    kind,
    initialBelief: 0.5,
    anchored: false,
    positionLocked: false,
    position: { x: index * 100, y: 0 }
  }));
  const edgeList: GraphEdge[] = edges.map(([source, target, id], index) => ({
    id: id ?? `x${index}`,
    source,
    target,
    stance: 'support',
    weight: 0.6
  }));
  return { version: 1, nodes: nodeList, edges: edgeList };
}

const bottleneckIds = (result: ReturnType<typeof analyzeBottlenecks>) =>
  result.items.map((item) => `${item.kind}:${item.nodeId ?? item.edgeId}=[${item.coveredEvidenceIds.join(',')}]`);

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  }
}

// 1. 菱形：两条可选支路，无节点/连线瓶颈。
{
  const g = makeGraph(
    [
      ['e1', 'evidence'],
      ['a', 'claim'],
      ['b', 'claim'],
      ['t', 'claim']
    ],
    [
      ['e1', 'a'],
      ['e1', 'b'],
      ['a', 't'],
      ['b', 't']
    ]
  );
  const r = analyzeBottlenecks(g, 't');
  check('diamond has no bottlenecks', bottleneckIds(r), []);
  check('diamond reachable', r.reachableEvidenceCount, 1);
}

// 2. 漏斗：两个证据汇入必经节点 b 与必经边 b→t。
{
  const g = makeGraph(
    [
      ['e1', 'evidence'],
      ['e2', 'evidence'],
      ['a', 'claim'],
      ['c', 'claim'],
      ['b', 'claim'],
      ['t', 'claim']
    ],
    [
      ['e1', 'a', 'ea'],
      ['a', 'b', 'ab'],
      ['e2', 'c', 'ec'],
      ['c', 'b', 'cb'],
      ['b', 't', 'bt']
    ]
  );
  const r = analyzeBottlenecks(g, 't');
  check(
    'funnel bottlenecks',
    bottleneckIds(r),
    [
      'node:b=[e1,e2]',
      'edge:bt=[e1,e2]',
      'node:a=[e1]',
      'node:c=[e2]',
      'edge:ab=[e1]',
      'edge:cb=[e2]',
      'edge:ea=[e1]',
      'edge:ec=[e2]'
    ]
  );
}

// 3. 有向环 a↔b：环可绕任意圈，a、b 与 a→b、b→t、e→a 仍必经；环边 b→a 不必然经过。
{
  const g = makeGraph(
    [
      ['e', 'evidence'],
      ['a', 'claim'],
      ['b', 'claim'],
      ['t', 'claim']
    ],
    [
      ['e', 'a', 'ea'],
      ['a', 'b', 'ab'],
      ['b', 'a', 'ba'],
      ['b', 't', 'bt']
    ]
  );
  const r = analyzeBottlenecks(g, 't');
  check(
    'cycle a<->b',
    bottleneckIds(r),
    ['node:a=[e]', 'node:b=[e]', 'edge:ab=[e]', 'edge:bt=[e]', 'edge:ea=[e]']
  );
}

// 4. 不可归约 SCC：a、b 互通且都可直达 t；a 仍必经（所有路径先到 a），b 不必经。
{
  const g = makeGraph(
    [
      ['e', 'evidence'],
      ['a', 'claim'],
      ['b', 'claim'],
      ['t', 'claim']
    ],
    [
      ['e', 'a', 'ea'],
      ['a', 'b', 'ab'],
      ['b', 'a', 'ba'],
      ['a', 't', 'at'],
      ['b', 't', 'bt']
    ]
  );
  const r = analyzeBottlenecks(g, 't');
  check('irreducible SCC: a mandatory, b not', bottleneckIds(r), ['node:a=[e]', 'edge:ea=[e]']);
}

// 5. 平行边：e→v 有两条平行边时各自不必然；节点 v 与边 v→t 仍必经。
{
  const g = makeGraph(
    [
      ['e', 'evidence'],
      ['v', 'claim'],
      ['t', 'claim']
    ],
    [
      ['e', 'v', 'p1'],
      ['e', 'v', 'p2'],
      ['v', 't', 'vt']
    ]
  );
  const r = analyzeBottlenecks(g, 't');
  check('parallel edges not mandatory', bottleneckIds(r), ['node:v=[e]', 'edge:vt=[e]']);
}

// 6. 自环：v→v 不是必经边，v 节点仍必经。
{
  const g = makeGraph(
    [
      ['e', 'evidence'],
      ['v', 'claim'],
      ['t', 'claim']
    ],
    [
      ['e', 'v', 'ev'],
      ['v', 'v', 'loop'],
      ['v', 't', 'vt']
    ]
  );
  const r = analyzeBottlenecks(g, 't');
  check('self loop excluded', bottleneckIds(r), ['node:v=[e]', 'edge:ev=[e]', 'edge:vt=[e]']);
}

// 7. 不可达证据另列；孤立观点分支不影响。
{
  const g = makeGraph(
    [
      ['e1', 'evidence'],
      ['e2', 'evidence'],
      ['e3', 'evidence'],
      ['v', 'claim'],
      ['w', 'claim'],
      ['t', 'claim']
    ],
    [
      ['e1', 'v', 'e1v'],
      ['v', 't', 'vt'],
      ['e2', 'w', 'e2w']
    ]
  );
  const r = analyzeBottlenecks(g, 't');
  check('unreachable evidences', r.unreachableEvidenceIds, ['e2', 'e3']);
  check('reachable count', r.reachableEvidenceCount, 1);
  check('reachable bottlenecks', bottleneckIds(r), ['node:v=[e1]', 'edge:e1v=[e1]', 'edge:vt=[e1]']);
}

// 8. 证据作为中间节点：e2 在 e1 的必经路径上；边 e2→t 覆盖两个证据。
{
  const g = makeGraph(
    [
      ['e1', 'evidence'],
      ['e2', 'evidence'],
      ['t', 'claim']
    ],
    [
      ['e1', 'e2', 'e1e2'],
      ['e2', 't', 'e2t']
    ]
  );
  const r = analyzeBottlenecks(g, 't');
  check(
    'evidence as intermediate node',
    bottleneckIds(r),
    ['edge:e2t=[e1,e2]', 'node:e2=[e1]', 'edge:e1e2=[e1]']
  );
}

// 9. 环上的“回路边后”节点不必然：e→a→t 与 e→a→b→a 绕行，b 不必经，a→t 不必经（可绕行后再走）。
//    仔细看：所有路径仍必须经过 a（起点后第一站），但边 a→t 不是所有路径的必经边（e-a-b-a-t 走了 a→t；
//    而“所有路径都含边 a→t”——每条终止于 t 的路径最后一跳必为 a→t 或 b... 这里只有 a→t 入 t，故 a→t 必经）。
{
  const g = makeGraph(
    [
      ['e', 'evidence'],
      ['a', 'claim'],
      ['b', 'claim'],
      ['t', 'claim']
    ],
    [
      ['e', 'a', 'ea'],
      ['a', 't', 'at'],
      ['a', 'b', 'ab'],
      ['b', 'a', 'ba']
    ]
  );
  const r = analyzeBottlenecks(g, 't');
  check('detour loop: b not mandatory', bottleneckIds(r), ['node:a=[e]', 'edge:at=[e]', 'edge:ea=[e]']);
}

// 10. 目标自身与证据自身不计瓶颈。
{
  const g = makeGraph(
    [
      ['e', 'evidence'],
      ['t', 'claim']
    ],
    [['e', 't', 'et']]
  );
  const r = analyzeBottlenecks(g, 't');
  check('direct edge only: edge mandatory', bottleneckIds(r), ['edge:et=[e]']);
}

// 11. 大环 + 多证据的支配覆盖正确性。
{
  const g = makeGraph(
    [
      ['e1', 'evidence'],
      ['e2', 'evidence'],
      ['a', 'claim'],
      ['b', 'claim'],
      ['c', 'claim'],
      ['t', 'claim']
    ],
    [
      ['e1', 'a', '1'],
      ['e2', 'b', '2'],
      ['a', 'c', '3'],
      ['b', 'c', '4'],
      ['c', 'a', '5'], // c→a 回边，与 a→c 成环
      ['c', 't', '6']
    ]
  );
  const r = analyzeBottlenecks(g, 't');
  // e1 的路径：e1-a-c-t, e1-a-c-b-c-t, e1-a-c-a-c-t… 必经 a、c；边 e1→a、a→c？
  // a→c 是否必经：从 a 到 t 必须走 a→c（a 只有出边 a→c），是。
  // e2 的路径：e2-b-c-t, e2-b-c-a-c-t… 必经 b、c；边 e2→b、b→c 必经（b 唯一出边）。
  // c→t 两证据都必经；c 节点两证据都必经。
  check(
    'big loop coverage',
    bottleneckIds(r),
    [
      'node:c=[e1,e2]',
      'edge:6=[e1,e2]',
      'node:a=[e1]',
      'node:b=[e2]',
      'edge:1=[e1]',
      'edge:2=[e2]',
      'edge:3=[e1]',
      'edge:4=[e2]'
    ]
  );
}

if (failures > 0) {
  console.error(`\n${failures} 个测试失败`);
  process.exit(1);
}
console.log('\n全部算法测试通过');
