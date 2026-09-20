/**
 * 校验必经链路分析的目标节点：必须是观点（claim）。
 * 图本身的严格校验由 validateGraphDocument 在调用处完成。
 */
export function validateBottleneckSelection(graph, targetNodeId) {
    if (typeof targetNodeId !== 'string' || !targetNodeId.trim()) {
        throw new Error('缺少目标观点节点 targetNodeId。');
    }
    const target = graph.nodes.find((node) => node.id === targetNodeId);
    if (!target)
        throw new Error(`目标节点「${targetNodeId}」不存在，无法分析。`);
    if (target.kind !== 'claim') {
        throw new Error(`目标节点「${target.label}」必须是观点（claim）节点。`);
    }
    const evidence = graph.nodes.filter((node) => node.kind === 'evidence');
    if (evidence.length === 0)
        throw new Error('图中还没有证据（evidence）节点，无法计算必经链路。');
    return { target, evidence };
}
const compareIdAsc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/**
 * 必经链路分析：
 * 对每个能沿有向边到达目标 t 的证据 s，找出 s 到 t 的**所有**有向路径
 * 共同经过的节点与连线（证据自身与目标节点不计）。
 *
 * 含环图上 s→t 的路径可能有无穷多条，绝不能靠枚举有限条路径近似。
 * 关键等价刻画：在以 t 为根的**反向图**上，
 *   节点 v 出现在 s 到 t 的每一条路径上 ⟺ v 支配（dominates）s。
 * 支配关系用 Cooper–Harvey–Watkinson 迭代不动点算法一次性求出，
 * 对可归约 / 不可归约 / 含自环与任意强连通分量的有向图都精确成立；
 * 连线 e 是否为某证据的必经边，等价于“在反向图中删掉该边后根无法再到达该证据”，
 * 用逐边删除后的可达性测试判定（平行边、自环、环均自然正确处理，且按边 id 精确删除）。
 * 全程只在内存中计算，不保存图、不写 SQLite。
 */
export function analyzeBottlenecks(graph, targetNodeId) {
    const { target } = validateBottleneckSelection(graph, targetNodeId);
    const nodeCount = graph.nodes.length;
    const indexById = new Map(graph.nodes.map((node, index) => [node.id, index]));
    const targetIndex = indexById.get(target.id);
    // 反向邻接表：原图边 s→t 在反向图中为 t→s。
    const revOut = graph.nodes.map(() => []);
    // 原图正向邻接表：CHW 在反向图 Gr 上求支配，Gr 中 v 的“前驱”恰为原图中 v 的出边目标。
    const outG = graph.nodes.map(() => []);
    graph.edges.forEach((edge) => {
        const source = indexById.get(edge.source);
        const targetNode = indexById.get(edge.target);
        revOut[targetNode].push({ to: source, edgeId: edge.id }); // 反向弧 target→source
        outG[source].push(targetNode);
    });
    // 邻接顺序确定化（支配结果本身唯一，确定顺序让遍历与运行表现稳定）。
    revOut.forEach((list) => list.sort((a, b) => a.to - b.to || compareIdAsc(a.edgeId, b.edgeId)));
    outG.forEach((list) => list.sort((a, b) => a - b));
    // 在反向图上从目标 t 出发迭代 DFS，得到可达集合与逆后序（RPO，根在前）。
    const reachable = new Uint8Array(nodeCount);
    const postOrder = [];
    {
        const visited = new Uint8Array(nodeCount);
        visited[targetIndex] = 1;
        reachable[targetIndex] = 1;
        const stack = [[targetIndex, 0]];
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const neighbors = revOut[frame[0]];
            if (frame[1] < neighbors.length) {
                const next = neighbors[frame[1]].to;
                frame[1] += 1;
                if (!visited[next]) {
                    visited[next] = 1;
                    reachable[next] = 1;
                    stack.push([next, 0]);
                }
            }
            else {
                postOrder.push(frame[0]);
                stack.pop();
            }
        }
    }
    const rpo = postOrder.reverse();
    const rpoIndex = new Int32Array(nodeCount).fill(-1);
    rpo.forEach((node, index) => {
        rpoIndex[node] = index;
    });
    // Cooper–Harvey–Watkinson：idom[v] 为 v 在支配树中的直接支配者；不动点迭代到稳定。
    const idom = new Int32Array(nodeCount).fill(-1);
    idom[targetIndex] = targetIndex;
    const intersect = (aInput, bInput) => {
        let fingerA = aInput;
        let fingerB = bInput;
        while (fingerA !== fingerB) {
            while (rpoIndex[fingerA] > rpoIndex[fingerB])
                fingerA = idom[fingerA];
            while (rpoIndex[fingerB] > rpoIndex[fingerA])
                fingerB = idom[fingerB];
        }
        return fingerA;
    };
    let changed = true;
    while (changed) {
        changed = false;
        for (let order = 1; order < rpo.length; order += 1) {
            const node = rpo[order];
            let newIdom = -1;
            // Gr 中 node 的前驱 = 原图中 node 的出边目标（outG[node]）。
            for (const predecessor of outG[node]) {
                // 反向 DFS 可达范围之外的前驱（原图中到不了目标的“下游”分支）不参与支配计算。
                if (!reachable[predecessor] || idom[predecessor] === -1)
                    continue;
                newIdom = newIdom === -1 ? predecessor : intersect(predecessor, newIdom);
            }
            if (newIdom !== -1 && idom[node] !== newIdom) {
                idom[node] = newIdom;
                changed = true;
            }
        }
    }
    const evidenceIndexSet = new Set();
    graph.nodes.forEach((node, index) => {
        if (node.kind === 'evidence')
            evidenceIndexSet.add(index);
    });
    const reachableEvidenceIndices = rpo.filter((node) => evidenceIndexSet.has(node) && node !== targetIndex);
    const reachableEvidenceSet = new Set(reachableEvidenceIndices);
    // 支配树子树覆盖集合：cover[v] 初始只含证据自身，再沿支配树向上合并。
    // 合并完成后，证据 s ∈ cover[v]（s≠v）当且仅当 v 支配 s，即 v 是 s→t 的必经节点。
    const cover = graph.nodes.map(() => new Set());
    reachableEvidenceIndices.forEach((node) => cover[node].add(node));
    for (let order = rpo.length - 1; order >= 1; order -= 1) {
        const node = rpo[order];
        const parent = idom[node];
        cover[node].forEach((member) => cover[parent].add(member));
    }
    const items = [];
    // 节点瓶颈：目标根节点不计；对证据节点自身不计（从其 cover 中去掉自己）。
    for (const node of rpo) {
        if (node === targetIndex)
            continue;
        const covered = [...cover[node]]
            .filter((evidenceIndex) => evidenceIndex !== node)
            .map((evidenceIndex) => graph.nodes[evidenceIndex].id)
            .sort(compareIdAsc);
        if (covered.length === 0)
            continue;
        items.push({
            kind: 'node',
            nodeId: graph.nodes[node].id,
            edgeId: null,
            sourceId: null,
            edgeTargetId: null,
            stance: null,
            weight: null,
            coveredEvidenceIds: covered,
            coveredCount: covered.length
        });
    }
    // 连线瓶颈：在反向图中删除该边后再从目标做 BFS，仍然可达的证据不受该边“卡脖子”，
    // 到不了的证据，其到目标的每条路径（在原图中）都必须经过该边。
    // 删除单条边的可达性是精确判定：平行边时各自都不唯一、环可绕行时也不唯一；按边 id 精确跳过。
    for (const edge of graph.edges) {
        const from = indexById.get(edge.target);
        const to = indexById.get(edge.source);
        if (!reachable[from] || !reachable[to])
            continue;
        const visited = new Uint8Array(nodeCount);
        visited[targetIndex] = 1;
        const queue = [targetIndex];
        let head = 0;
        let reached = 0;
        while (head < queue.length) {
            const node = queue[head];
            head += 1;
            if (node !== targetIndex && reachableEvidenceSet.has(node)) {
                reached += 1;
                if (reached === reachableEvidenceIndices.length)
                    break;
            }
            for (const arc of revOut[node]) {
                if (node === from && arc.to === to && arc.edgeId === edge.id)
                    continue;
                if (!visited[arc.to]) {
                    visited[arc.to] = 1;
                    queue.push(arc.to);
                }
            }
        }
        const covered = reachableEvidenceIndices
            .filter((evidenceIndex) => !visited[evidenceIndex])
            .map((evidenceIndex) => graph.nodes[evidenceIndex].id)
            .sort(compareIdAsc);
        if (covered.length === 0)
            continue;
        items.push({
            kind: 'edge',
            nodeId: null,
            edgeId: edge.id,
            sourceId: edge.source,
            edgeTargetId: edge.target,
            stance: edge.stance,
            weight: edge.weight,
            coveredEvidenceIds: covered,
            coveredCount: covered.length
        });
    }
    // 按覆盖证据数降序、节点优先于连线、id 升序稳定返回。
    items.sort((a, b) => {
        if (b.coveredCount !== a.coveredCount)
            return b.coveredCount - a.coveredCount;
        if (a.kind !== b.kind)
            return a.kind === 'node' ? -1 : 1;
        return compareIdAsc((a.nodeId ?? a.edgeId), (b.nodeId ?? b.edgeId));
    });
    const allEvidenceIds = graph.nodes
        .filter((node) => node.kind === 'evidence')
        .map((node) => node.id)
        .sort(compareIdAsc);
    const unreachableEvidenceIds = allEvidenceIds.filter((id) => !reachable[indexById.get(id)]);
    const targetLabel = target.label;
    const message = reachableEvidenceIndices.length === 0
        ? `当前画布中没有任何证据能沿有向边到达观点「${targetLabel}」，不存在必经链路；${unreachableEvidenceIds.length} 个证据已另列。`
        : `以观点「${targetLabel}」为目标：${reachableEvidenceIndices.length}/${allEvidenceIds.length} 个证据可达，` +
            `基于支配关系在含环子图上精确计算（不枚举路径），共找到 ${items.length} 个必经瓶颈；` +
            (unreachableEvidenceIds.length > 0
                ? `另有 ${unreachableEvidenceIds.length} 个不可达证据已另列。`
                : '全部证据均可到达目标。');
    return {
        targetNodeId: target.id,
        evidenceCount: allEvidenceIds.length,
        reachableEvidenceCount: reachableEvidenceIndices.length,
        items,
        unreachableEvidenceIds,
        message
    };
}
