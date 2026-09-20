import type { GraphDocument } from '../../shared/graph';

export const stableSample: GraphDocument = {
  version: 1,
  name: '稳定论证示例',
  nodes: [
    {
      id: 'e1',
      label: '实验显示疗效显著',
      kind: 'evidence',
      initialBelief: 0.86,
      anchored: false,
      position: { x: 60, y: 70 }
    },
    {
      id: 'e2',
      label: '独立队列复现成功',
      kind: 'evidence',
      initialBelief: 0.72,
      anchored: false,
      position: { x: 60, y: 250 }
    },
    {
      id: 'e3',
      label: '样本流失率偏高',
      kind: 'evidence',
      initialBelief: 0.42,
      anchored: false,
      position: { x: 60, y: 420 }
    },
    {
      id: 'c1',
      label: '该治疗方案总体可信',
      kind: 'claim',
      initialBelief: 0.5,
      anchored: false,
      position: { x: 420, y: 230 }
    }
  ],
  edges: [
    { id: 'edge-e1-c1', source: 'e1', target: 'c1', stance: 'support', weight: 0.7 },
    { id: 'edge-e2-c1', source: 'e2', target: 'c1', stance: 'support', weight: 0.55 },
    { id: 'edge-e3-c1', source: 'e3', target: 'c1', stance: 'rebut', weight: 0.5 }
  ]
};

// 三条全强度反驳构成奇数负反馈环。配合 λ=1 会出现精确的周期振荡。
export const oscillatingSample: GraphDocument = {
  version: 1,
  name: '三角相互反驳振荡示例',
  nodes: [
    {
      id: 'a',
      label: '观点 A',
      kind: 'claim',
      initialBelief: 0.52,
      anchored: false,
      position: { x: 330, y: 50 }
    },
    {
      id: 'b',
      label: '观点 B',
      kind: 'claim',
      initialBelief: 0.48,
      anchored: false,
      position: { x: 80, y: 300 }
    },
    {
      id: 'c',
      label: '观点 C',
      kind: 'claim',
      initialBelief: 0.5,
      anchored: false,
      position: { x: 580, y: 300 }
    }
  ],
  edges: [
    { id: 'edge-a-b', source: 'a', target: 'b', stance: 'rebut', weight: 1 },
    { id: 'edge-b-c', source: 'b', target: 'c', stance: 'rebut', weight: 1 },
    { id: 'edge-c-a', source: 'c', target: 'a', stance: 'rebut', weight: 1 }
  ]
};
