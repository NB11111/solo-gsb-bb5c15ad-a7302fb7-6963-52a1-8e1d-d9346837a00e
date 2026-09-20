import { propagateBeliefs, validateOptions } from './propagation.js';
export const DEFAULT_SENSITIVITY_SAMPLES = 21;
export const MIN_SENSITIVITY_SAMPLES = 2;
export const MAX_SENSITIVITY_SAMPLES = 101;
const DECISION_THRESHOLD = 0.5;
/**
 * 校验扫描的边与目标节点。
 * 图严格校验由 validateGraphDocument 在调用处完成；这里只检查边与目标节点是否存在。
 */
export function validateSensitivitySelection(graph, edgeId, targetNodeId) {
    if (typeof edgeId !== 'string' || !edgeId.trim()) {
        throw new Error('缺少要扫描的连线 edgeId。');
    }
    if (typeof targetNodeId !== 'string' || !targetNodeId.trim()) {
        throw new Error('缺少目标节点 targetNodeId。');
    }
    const edge = graph.edges.find((item) => item.id === edgeId);
    if (!edge)
        throw new Error(`连线「${edgeId}」不存在，无法扫描。`);
    const targetNode = graph.nodes.find((item) => item.id === targetNodeId);
    if (!targetNode)
        throw new Error(`目标节点「${targetNodeId}」不存在，无法扫描。`);
    return { edge, targetNode };
}
export function validateSamples(value) {
    if (value === undefined || value === null || value === '')
        return DEFAULT_SENSITIVITY_SAMPLES;
    const number = Number(value);
    if (!Number.isInteger(number) || number < MIN_SENSITIVITY_SAMPLES || number > MAX_SENSITIVITY_SAMPLES) {
        throw new Error(`采样点数量必须是 ${MIN_SENSITIVITY_SAMPLES} 到 ${MAX_SENSITIVITY_SAMPLES} 之间的整数。`);
    }
    return number;
}
function describeNoTargetValue(result, maxIterations) {
    if (result.detectedPeriod !== null) {
        return `第 ${result.iterations} 轮检测到周期约为 ${result.detectedPeriod} 的持续振荡，目标节点没有稳定终值，不参与 0.5 跨越判断。`;
    }
    return `达到 ${maxIterations} 轮上限仍未收敛（末轮最大变化 ${result.maxChange.toFixed(5)}），目标节点没有可信终值，不参与 0.5 跨越判断。`;
}
/**
 * 边权敏感性扫描：把指定边权从 0 到 1 等距取 samples 个值，
 * 每个取值在内存中的图副本上沿用给定传播参数计算，不保存图。
 */
export function scanEdgeWeightSensitivity(graph, edgeId, targetNodeId, suppliedOptions, samples = DEFAULT_SENSITIVITY_SAMPLES) {
    validateSensitivitySelection(graph, edgeId, targetNodeId);
    const options = validateOptions(suppliedOptions);
    const points = [];
    const denominator = samples - 1;
    for (let index = 0; index < samples; index += 1) {
        // 用整数比例生成等距权重，避免 0.05 累加法带来的浮点漂移。
        const weight = denominator > 0 ? Math.round((index / denominator) * 1000) / 1000 : 0;
        const scannedGraph = {
            ...graph,
            edges: graph.edges.map((edge) => (edge.id === edgeId ? { ...edge, weight } : edge))
        };
        const run = propagateBeliefs(scannedGraph, options);
        const value = run.finalBeliefs[targetNodeId];
        const status = run.converged ? 'converged' : run.oscillating ? 'oscillating' : 'limit';
        points.push({
            weight,
            status,
            iterations: run.iterations,
            // 仅收敛点提供稳定终值；振荡点无目标值；上限点保留末轮值仅供参考。
            targetValue: status === 'converged' || status === 'limit' ? value : null,
            detectedPeriod: run.detectedPeriod,
            maxChange: run.maxChange,
            reason: status === 'converged' ? '' : describeNoTargetValue(run, options.maxIterations)
        });
    }
    // 首次跨越 0.5：只允许相邻的两个收敛采样点构成区间；振荡/未收敛点把连续收敛序列打断。
    let thresholdBand = null;
    for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        if (previous.status !== 'converged' || current.status !== 'converged')
            continue;
        if (previous.targetValue === null || current.targetValue === null)
            continue;
        const crosses = (previous.targetValue < DECISION_THRESHOLD && current.targetValue > DECISION_THRESHOLD) ||
            (previous.targetValue > DECISION_THRESHOLD && current.targetValue < DECISION_THRESHOLD);
        if (crosses) {
            thresholdBand = {
                fromWeight: previous.weight,
                toWeight: current.weight,
                fromValue: previous.targetValue,
                toValue: current.targetValue
            };
            break;
        }
    }
    const convergedCount = points.filter((point) => point.status === 'converged').length;
    const oscillatingCount = points.filter((point) => point.status === 'oscillating').length;
    const limitCount = samples - convergedCount - oscillatingCount;
    return {
        edgeId,
        targetNodeId,
        samples,
        points,
        thresholdBand,
        options,
        message: `共 ${samples} 个等距边权取值（0→1）：收敛 ${convergedCount} 个、振荡 ${oscillatingCount} 个、` +
            `达到上限 ${limitCount} 个。` +
            (thresholdBand
                ? `目标可信度首次在边权 ${thresholdBand.fromWeight.toFixed(2)}–${thresholdBand.toWeight.toFixed(2)} 之间跨过 0.5。`
                : '连续收敛区间内未出现跨过 0.5 的情况。')
    };
}
