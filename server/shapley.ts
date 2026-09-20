import { propagateBeliefs, validateOptions } from './propagation.js';
import type {
  GraphDocument,
  PropagateOptions,
  ShapleyContributionItem,
  ShapleyResult
} from '../shared/graph.js';

export const MAX_SHAPLEY_EVIDENCE = 8;
export const MIN_SHAPLEY_EVIDENCE = 1;
/** 和式校验的数值容差：精确 Shapley 公式在浮点误差内必然满足 Σφ = v(N) − v(∅) */
const SUM_CHECK_TOLERANCE = 1e-9;

/**
 * 校验分摊选择：目标必须是观点（claim），证据 1–8 个且均为 evidence。
 * 图本身的严格校验由 validateGraphDocument 在调用处完成。
 */
export function validateShapleySelection(
  graph: GraphDocument,
  claimNodeId: unknown,
  evidenceNodeIds: unknown
) {
  if (typeof claimNodeId !== 'string' || !claimNodeId.trim()) {
    throw new Error('缺少目标观点 claimNodeId。');
  }
  const claim = graph.nodes.find((node) => node.id === claimNodeId);
  if (!claim) throw new Error(`目标观点「${claimNodeId}」不存在，无法分摊。`);
  if (claim.kind !== 'claim') {
    throw new Error(`目标节点「${claim.label}」必须是观点（claim）节点。`);
  }
  if (!Array.isArray(evidenceNodeIds) || evidenceNodeIds.length < MIN_SHAPLEY_EVIDENCE) {
    throw new Error(`至少选择 ${MIN_SHAPLEY_EVIDENCE} 个证据节点参与分摊。`);
  }
  if (evidenceNodeIds.length > MAX_SHAPLEY_EVIDENCE) {
    throw new Error(`证据节点最多选择 ${MAX_SHAPLEY_EVIDENCE} 个（联盟数为 2^n）。`);
  }
  const seen = new Set<string>();
  const evidence = evidenceNodeIds.map((raw) => {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('证据节点 id 无效。');
    const id = raw;
    if (seen.has(id)) throw new Error(`证据节点「${id}」被重复选择。`);
    seen.add(id);
    const node = graph.nodes.find((item) => item.id === id);
    if (!node) throw new Error(`证据节点「${id}」不存在，无法分摊。`);
    if (node.kind !== 'evidence') {
      throw new Error(`节点「${node.label}」不是证据（evidence）节点，不能参与分摊。`);
    }
    return node;
  });
  return { claim, evidence };
}

/** 联盟掩码中包含的证据数量（population count）。 */
function coalitionSize(mask: number): number {
  let count = 0;
  let rest = mask;
  while (rest > 0) {
    rest &= rest - 1;
    count += 1;
  }
  return count;
}

/**
 * 证据贡献分摊（精确 Shapley）：
 * 对所选 n 个证据的全部 2^n 个联盟，在内存中的图副本上移除未加入联盟的所选证据，
 * 沿用当前传播参数重算目标观点的收敛值 v(S)；以空联盟为基准，
 * 按精确 Shapley 公式 φᵢ = Σ_{S⊆N∖{i}} |S|!(n−|S|−1)!/n! · [v(S∪{i}) − v(S)]
 * 分摊 v(N) − v(∅)。任一联盟未收敛（振荡或达到上限）则整体不可计算，
 * 返回按掩码升序评估到的首个失败联盟，绝不混用其末轮值。
 * 全程只在内存中计算，不保存图、不写 SQLite。
 */
export function computeEvidenceShapley(
  graph: GraphDocument,
  claimNodeId: string,
  evidenceNodeIds: string[],
  suppliedOptions?: PropagateOptions
): ShapleyResult {
  const options = validateOptions(suppliedOptions);
  const count = evidenceNodeIds.length;
  const coalitionCount = 2 ** count;
  // values[mask] = 该联盟下目标观点的收敛可信度；掩码第 i 位为 1 表示保留 evidenceNodeIds[i]。
  const values = new Array<number>(coalitionCount);

  for (let mask = 0; mask < coalitionCount; mask += 1) {
    const removed = new Set(evidenceNodeIds.filter((_, index) => (mask & (1 << index)) === 0));
    const coalitionGraph: GraphDocument = {
      version: 1,
      name: graph.name,
      nodes: graph.nodes.filter((node) => !removed.has(node.id)),
      edges: graph.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target))
    };
    const run = propagateBeliefs(coalitionGraph, options);
    if (!run.converged) {
      const members = evidenceNodeIds.filter((_, index) => (mask & (1 << index)) !== 0);
      const status = run.oscillating ? 'oscillating' : 'limit';
      const statusText = status === 'oscillating' ? '持续振荡' : '达到迭代上限仍未收敛';
      const labelOf = (id: string) => graph.nodes.find((node) => node.id === id)?.label ?? id;
      const coalitionText =
        members.length > 0 ? `联盟 {${members.map(labelOf).join('、')}}` : '空联盟（未保留任何所选证据）';
      return {
        claimNodeId,
        evidenceNodeIds: [...evidenceNodeIds],
        coalitionCount,
        computable: false,
        baselineValue: null,
        fullValue: null,
        totalDifference: null,
        contributions: null,
        sumCheck: null,
        failure: {
          evidenceIds: members,
          status,
          iterations: run.iterations,
          reason: run.message
        },
        options,
        message:
          `${coalitionText} ${statusText}（第 ${run.iterations} 轮停止），证据贡献分摊整体不可计算；` +
          `未使用任何联盟的末轮值。`
      };
    }
    values[mask] = run.finalBeliefs[claimNodeId];
  }

  // 精确 Shapley：φᵢ = Σ_{S⊆N∖{i}} |S|!(n−|S|−1)!/n! · [v(S∪{i}) − v(S)]
  const factorial: number[] = [1];
  for (let index = 1; index <= count; index += 1) factorial.push(factorial[index - 1] * index);

  const contributions: ShapleyContributionItem[] = evidenceNodeIds.map((nodeId, player) => {
    const bit = 1 << player;
    let contribution = 0;
    for (let mask = 0; mask < coalitionCount; mask += 1) {
      if (mask & bit) continue;
      const size = coalitionSize(mask);
      const weight = (factorial[size] * factorial[count - size - 1]) / factorial[count];
      contribution += weight * (values[mask | bit] - values[mask]);
    }
    return {
      nodeId,
      contribution,
      absoluteContribution: Math.abs(contribution),
      share: null
    };
  });

  const baselineValue = values[0];
  const fullValue = values[coalitionCount - 1];
  const totalDifference = fullValue - baselineValue;
  contributions.forEach((item) => {
    // 总差为 0 时占比无定义（各贡献之和也为 0），返回 null 由前端显示 “—”。
    item.share = totalDifference !== 0 ? item.contribution / totalDifference : null;
  });

  const sum = contributions.reduce((total, item) => total + item.contribution, 0);
  const difference = sum - totalDifference;
  const sumCheck = {
    sum,
    expected: totalDifference,
    difference,
    matches: Math.abs(difference) <= SUM_CHECK_TOLERANCE
  };

  // 按绝对贡献降序；并列时按节点 id 升序，保证结果稳定。
  contributions.sort(
    (a, b) =>
      b.absoluteContribution - a.absoluteContribution ||
      (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)
  );

  return {
    claimNodeId,
    evidenceNodeIds: [...evidenceNodeIds],
    coalitionCount,
    computable: true,
    baselineValue,
    fullValue,
    totalDifference,
    contributions,
    sumCheck,
    failure: null,
    options,
    message:
      `全部 ${coalitionCount} 个证据联盟均收敛：空联盟基准 ${baselineValue.toFixed(4)}，` +
      `全联盟 ${fullValue.toFixed(4)}，差值 ${totalDifference >= 0 ? '+' : ''}${totalDifference.toFixed(4)}，` +
      `已按精确 Shapley 公式分摊（Σ 校验${sumCheck.matches ? '一致' : '不一致'}）。`
  };
}
