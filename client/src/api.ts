import type {
  BottleneckResult,
  GraphDocument,
  PropagateOptions,
  PropagateResult,
  SensitivityResult,
  ShapleyResult,
  TraceResult
} from '../../shared/graph';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `请求失败：${response.status}`);
  return payload as T;
}

export const api = {
  getGraph: () => request<{ graph: GraphDocument }>('/api/graph'),
  saveGraph: (graph: GraphDocument) => request<{ graph: GraphDocument }>('/api/graph', {
    method: 'PUT',
    body: JSON.stringify(graph)
  }),
  propagate: (options: PropagateOptions) =>
    request<{ result: PropagateResult }>('/api/propagate', {
      method: 'POST',
      body: JSON.stringify({ options })
    }),
  /** 边权敏感性扫描：提交当前画布图，仅在服务端内存中计算，不会保存图。 */
  scanEdgeWeight: (payload: {
    graph: GraphDocument;
    edgeId: string;
    targetNodeId: string;
    options: PropagateOptions;
    samples?: number;
  }) =>
    request<{ scan: SensitivityResult }>('/api/sensitivity/edge-weight', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  /** 影响路径追踪：提交当前画布图，枚举至多 8 跳有向简单路径，仅在服务端内存中计算，不会保存图。 */
  traceInfluence: (payload: {
    graph: GraphDocument;
    startNodeId: string;
    targetNodeId: string;
    maxHops?: number;
  }) =>
    request<{ trace: TraceResult }>('/api/trace/influence-paths', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  /** 证据贡献分摊：提交当前画布图，对全部证据联盟重算传播并做精确 Shapley 分摊，仅在服务端内存中计算，不会保存图。 */
  shapleyContributions: (payload: {
    graph: GraphDocument;
    claimNodeId: string;
    evidenceNodeIds: string[];
    options: PropagateOptions;
  }) =>
    request<{ shapley: ShapleyResult }>('/api/shapley/evidence-contribution', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  /** 必经链路分析：提交当前画布图，按「删除后不可达」精确计算瓶颈及其覆盖证据，仅在服务端内存中计算，不会保存图。 */
  bottleneckAnalysis: (payload: { graph: GraphDocument; targetNodeId: string }) =>
    request<{ analysis: BottleneckResult }>('/api/bottleneck/mandatory-links', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
};
