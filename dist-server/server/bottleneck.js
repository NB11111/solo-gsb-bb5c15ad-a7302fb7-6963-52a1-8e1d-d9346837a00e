/**
 * 校验必经链路分析的目标节点。
 * 图的严格校验由 validateGraphDocument 在调用处完成；这里只检查选择是否合法。
 */
export function validateBottleneckSelection(graph, targetNodeId) {
    if (typeof targetNodeId !== 'string' || !targetNodeId.trim()) {
        throw new Error('缺少目标观点 targetNodeId。');
    }
    const target = graph.nodes.find((node) => node.id === targetNodeId);
    if (!target)
        throw new Error(`目标观点「${targetNodeId}」不存在，无法分析。`);
    if (target.kind !== 'claim') {
        throw new Error(`目标节点「${target.label}」必须是观点（claim）节点。`);
    }
    return target;
}
/**
 * 必经链路分析（精确，非路径枚举）：
 * 节点/连线 x 被证据 e 到目标 t 的所有有向路径共同经过 ⟺ 删除 x 后 e 无法到达 t。
 * 该等价关系对任意有向环严格成立（可达性在带环图上定义良好），因此
 * 这里对每个候选节点/连线做一次「删除后反向 BFS」，而不是枚举有限条路径来近似。
 *
 * 复杂度 O((V+E)·(V+E))：上限 500 节点 / 1500 连线时约 4×10⁶ 次边访问。
 * 证据自身与目标不计瓶颈：节点候选排除目标，覆盖集合排除证据自身；连线无此限制。
 * 全程只在内存中计算，不保存图、不写 SQLite。
 */
export function analyzeMandatoryLinks(graph, targetNodeId) {
    const target = validateBottleneckSelection(graph, targetNodeId);
    const nodeCount = graph.nodes.length;
    const indexById = new Map(graph.nodes.map((node, index) => [node.id, index]));
    const targetIndex = indexById.get(target.id);
    // 入边邻接（存边下标），供反向 BFS 使用。
    const incoming = graph.nodes.map(() => []);
    graph.edges.forEach((edge, edgeIndex) => {
        incoming[indexById.get(edge.target)].push(edgeIndex);
    });
    /**
     * 在「跳过 skipNodeIndex 号节点与 skipEdgeIndex 号连线」的图上做反向 BFS，
     * 返回每个节点是否仍能沿有向边到达目标（-1 表示不跳过）。
     */
    const reachWithout = (skipNodeIndex, skipEdgeIndex) => {
        const reached = new Array(nodeCount).fill(false);
        if (skipNodeIndex === targetIndex)
            return reached;
        reached[targetIndex] = true;
        const queue = [targetIndex];
        for (let head = 0; head < queue.length; head += 1) {
            const current = queue[head];
            for (const edgeIndex of incoming[current]) {
                if (edgeIndex === skipEdgeIndex)
                    continue;
                const sourceIndex = indexById.get(graph.edges[edgeIndex].source);
                if (sourceIndex === skipNodeIndex || reached[sourceIndex])
                    continue;
                reached[sourceIndex] = true;
                queue.push(sourceIndex);
            }
        }
        return reached;
    };
    // 基准可达集：未删除任何元素时，哪些节点能到达目标。
    const baseReach = reachWithout(-1, -1);
    // 证据按 id 升序，保证各列表顺序稳定。
    const evidenceEntries = graph.nodes
        .map((node, index) => ({ node, index }))
        .filter((entry) => entry.node.kind === 'evidence')
        .sort((a, b) => (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
    const reachableEvidence = evidenceEntries.filter((entry) => baseReach[entry.index]);
    const reachableEvidenceIds = reachableEvidence.map((entry) => entry.node.id);
    const unreachableEvidenceIds = evidenceEntries
        .filter((entry) => !baseReach[entry.index])
        .map((entry) => entry.node.id);
    const bottlenecks = [];
    // 节点瓶颈：候选 v ≠ 目标且 v 本身能到达目标（否则删除它不影响任何可达性）。
    // 覆盖 = 可达证据 e ≠ v 且在 G−v 中不再能到达目标（证据自身不计瓶颈）。
    for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
        if (nodeIndex === targetIndex || !baseReach[nodeIndex])
            continue;
        const reach = reachWithout(nodeIndex, -1);
        const coveredEvidenceIds = reachableEvidence
            .filter((entry) => entry.index !== nodeIndex && !reach[entry.index])
            .map((entry) => entry.node.id);
        if (coveredEvidenceIds.length > 0) {
            bottlenecks.push({
                kind: 'node',
                id: graph.nodes[nodeIndex].id,
                coveredEvidenceIds,
                coveredCount: coveredEvidenceIds.length
            });
        }
    }
    // 连线瓶颈：候选边的源点必须能到达目标（否则删除它不影响任何可达性）。
    // 覆盖 = 可达证据 e 在 G−edge 中不再能到达目标。
    graph.edges.forEach((edge, edgeIndex) => {
        const sourceIndex = indexById.get(edge.source);
        if (!baseReach[sourceIndex])
            return;
        const reach = reachWithout(-1, edgeIndex);
        const coveredEvidenceIds = reachableEvidence
            .filter((entry) => !reach[entry.index])
            .map((entry) => entry.node.id);
        if (coveredEvidenceIds.length > 0) {
            bottlenecks.push({
                kind: 'edge',
                id: edge.id,
                coveredEvidenceIds,
                coveredCount: coveredEvidenceIds.length
            });
        }
    });
    // 稳定排序：覆盖证据数降序 → 节点优先于连线 → id 升序。
    bottlenecks.sort((a, b) => b.coveredCount - a.coveredCount ||
        (a.kind === b.kind ? 0 : a.kind === 'node' ? -1 : 1) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const nodeBottleneckCount = bottlenecks.filter((item) => item.kind === 'node').length;
    const edgeBottleneckCount = bottlenecks.length - nodeBottleneckCount;
    let message;
    if (evidenceEntries.length === 0) {
        message = `图中没有证据节点，目标「${target.label}」无可分析的证据链路。`;
    }
    else {
        const reachText = unreachableEvidenceIds.length > 0
            ? `${reachableEvidenceIds.length} 个证据可到达目标，${unreachableEvidenceIds.length} 个无法到达（已另列）`
            : `全部 ${reachableEvidenceIds.length} 个证据均可到达目标`;
        const bottleneckText = bottlenecks.length > 0
            ? `发现 ${bottlenecks.length} 个必经瓶颈（节点 ${nodeBottleneckCount} 个、连线 ${edgeBottleneckCount} 条），按覆盖证据数降序排列`
            : reachableEvidenceIds.length > 0
                ? '没有必经瓶颈：任一中间节点或连线都可被某条可达通路绕过'
                : '没有证据能到达目标，谈不上必经瓶颈';
        message = `目标「${target.label}」：${reachText}；${bottleneckText}。`;
    }
    return {
        targetNodeId: target.id,
        reachableEvidenceIds,
        unreachableEvidenceIds,
        bottlenecks,
        message
    };
}
