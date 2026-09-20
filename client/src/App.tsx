import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  useEdgesState,
  useNodesState,
  MarkerType,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler
} from 'reactflow';
import 'reactflow/dist/style.css';
import { api } from './api';
import { ArgumentNode, nodeTypes, type ArgumentNodeData } from './components/ArgumentNode';
import {
  SidePanel,
  graphToDocument,
  type BottleneckSelection,
  type SensitivitySelection,
  type ShapleySelection,
  type TraceSelection
} from './components/SidePanel';
import { ReplayBar } from './components/ReplayBar';
import { buildRoundDecomposition } from './replay';
import { planGraphLayout, formatDisplacement, type LayoutResult } from './layout';
import type {
  BottleneckItem,
  BottleneckResult,
  GraphDocument,
  GraphNode,
  GraphEdge,
  InfluencePath,
  PropagateOptions,
  PropagateResult,
  SensitivityResult,
  ShapleyResult,
  Stance,
  TraceResult
} from '../../shared/graph';
import { stableSample, oscillatingSample } from './samples';

const DEFAULT_OPTIONS: PropagateOptions = { threshold: 0.001, maxIterations: 200, lambda: 0.8 };
const DEFAULT_TRACE_SELECTION: TraceSelection = { startNodeId: '', targetNodeId: '', maxHops: 8 };
const DEFAULT_SHAPLEY_SELECTION: ShapleySelection = { claimNodeId: '', evidenceNodeIds: [] };
const DEFAULT_BOTTLENECK_SELECTION: BottleneckSelection = { targetNodeId: '' };

type EdgeDecorMode = 'plain' | 'cycle' | 'trace-active' | 'bottleneck-active';

const documentToFlow = (graph: GraphDocument): { nodes: Node<ArgumentNodeData>[]; edges: Edge[] } => ({
  nodes: graph.nodes.map((node) => ({
    id: node.id,
    type: 'argument',
    position: node.position,
    data: {
      label: node.label,
      kind: node.kind,
      initialBelief: node.initialBelief,
      anchored: node.anchored,
      positionLocked: Boolean(node.positionLocked)
    }
  })),
  edges: graph.edges.map((edge) => makeEdge(edge))
});

/** 一键整理布局预览：仅存于前端状态，确认前不触碰画布数据与 SQLite。 */
interface LayoutPreview {
  /** 整理结果（含整理前后交叉数 / 总位移） */
  plan: LayoutResult;
}

function makeEdge(edge: GraphEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: `${edge.stance === 'support' ? '支持' : '反驳'} ${Math.round(edge.weight * 100)}%`,
    animated: false,
    data: { stance: edge.stance, weight: edge.weight },
    className: `stance-${edge.stance}`,
    markerEnd: { type: MarkerType.ArrowClosed }
  };
}

/** 按当前分析视图重绘连线：必经瓶颈优先于追踪，追踪优先于负反馈环；选中路径/瓶颈加粗动画。 */
function decorateEdge(
  edge: Edge,
  mode: EdgeDecorMode,
  activeRunningScore?: number
): Edge {
  const stance = (edge.data?.stance as Stance) ?? 'support';
  const weight = Number(edge.data?.weight ?? 0.6);
  const baseLabel = `${stance === 'support' ? '支持' : '反驳'} ${Math.round(weight * 100)}%`;
  const className = [
    `stance-${stance}`,
    mode === 'cycle' ? 'cycle-edge' : '',
    mode === 'trace-active' ? 'trace-path-edge trace-active-edge' : '',
    mode === 'bottleneck-active' ? 'bottleneck-edge' : ''
  ]
    .filter(Boolean)
    .join(' ');
  return {
    ...edge,
    label:
      mode === 'trace-active' && activeRunningScore !== undefined
        ? `${baseLabel} · 累计 ${activeRunningScore >= 0 ? '+' : ''}${activeRunningScore.toFixed(2)}`
        : baseLabel,
    className,
    animated: mode !== 'plain',
    style: mode === 'plain' ? undefined : { strokeWidth: mode === 'cycle' ? 3.4 : 4.5 },
    markerEnd: { type: MarkerType.ArrowClosed }
  };
}

let localCounter = 0;
const createId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(localCounter += 1)}`;

/** 用第 round 轮的轨迹值刷新节点显示（纯视图更新，不保存、不重新计算）。 */
function decorateNodesForRound(
  current: Node<ArgumentNodeData>[],
  result: PropagateResult,
  round: number,
  cycleNodeIds: Set<string>
): Node<ArgumentNodeData>[] {
  return current.map((node) => {
    const trace = result.traces[node.id];
    if (!trace || trace.length === 0) {
      return { ...node, data: { ...node.data, displayBelief: undefined, roundDelta: undefined, inCycle: false } };
    }
    const clamped = Math.max(0, Math.min(round, trace.length - 1));
    const value = trace[clamped];
    return {
      ...node,
      data: {
        ...node.data,
        displayBelief: value,
        roundDelta: clamped > 0 ? value - trace[clamped - 1] : undefined,
        inCycle: cycleNodeIds.has(node.id)
      }
    };
  });
}

export default function App() {
  const [documentName, setDocumentName] = useState('我的论证图');
  const [nodes, setNodes, onNodesChange] = useNodesState<ArgumentNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [options, setOptions] = useState<PropagateOptions>(DEFAULT_OPTIONS);
  const [result, setResult] = useState<PropagateResult | null>(null);
  const [replayRound, setReplayRound] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [status, setStatus] = useState('正在加载…');
  const [busy, setBusy] = useState(false);
  const [sensitivitySelection, setSensitivitySelection] = useState<SensitivitySelection>({
    edgeId: '',
    targetNodeId: ''
  });
  const [sensitivityResult, setSensitivityResult] = useState<SensitivityResult | null>(null);
  const [sensitivityScanning, setSensitivityScanning] = useState(false);
  const [sensitivityStatus, setSensitivityStatus] = useState('');
  const [traceSelection, setTraceSelection] = useState<TraceSelection>(DEFAULT_TRACE_SELECTION);
  const [traceResult, setTraceResult] = useState<TraceResult | null>(null);
  const [traceTracing, setTraceTracing] = useState(false);
  const [traceStatus, setTraceStatus] = useState('');
  const [traceActiveIndex, setTraceActiveIndex] = useState(0);
  const [shapleySelection, setShapleySelection] = useState<ShapleySelection>(DEFAULT_SHAPLEY_SELECTION);
  const [shapleyResult, setShapleyResult] = useState<ShapleyResult | null>(null);
  const [shapleyRunning, setShapleyRunning] = useState(false);
  const [shapleyStatus, setShapleyStatus] = useState('');
  const [shapleyActiveId, setShapleyActiveId] = useState<string | null>(null);
  const [bottleneckSelection, setBottleneckSelection] = useState<BottleneckSelection>(DEFAULT_BOTTLENECK_SELECTION);
  const [bottleneckResult, setBottleneckResult] = useState<BottleneckResult | null>(null);
  const [bottleneckRunning, setBottleneckRunning] = useState(false);
  const [bottleneckStatus, setBottleneckStatus] = useState('');
  const [bottleneckActiveKey, setBottleneckActiveKey] = useState<string | null>(null);
  const [layoutPreview, setLayoutPreview] = useState<LayoutPreview | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  // 供窗口事件监听器读取最新画布，避免监听器闭包过期。
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const previewRef = useRef(layoutPreview);
  previewRef.current = layoutPreview;
  // 保存进入预览时的原始坐标，供取消 / 失效时还原。
  const previewOriginRef = useRef<Record<string, { x: number; y: number }> | null>(null);

  const scheduleSave = useCallback(
    (nextNodes = nodes, nextEdges = edges, immediate = false) => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      const run = () => {
        setStatus('正在保存…');
        api
          .saveGraph(graphToDocument(documentName, nextNodes, nextEdges))
          .then(() => setStatus('已自动保存到 SQLite'))
          .catch((error: Error) => setStatus(`保存失败：${error.message}`));
      };
      if (immediate) run();
      else saveTimerRef.current = window.setTimeout(run, 700);
    },
    [documentName, edges, nodes]
  );
  const scheduleSaveRef = useRef(scheduleSave);
  scheduleSaveRef.current = scheduleSave;

  useEffect(() => {
    api
      .getGraph()
      .then(({ graph }) => {
        const flow = documentToFlow(graph);
        setNodes(flow.nodes);
        setEdges(flow.edges);
        setDocumentName(graph.name ?? '我的论证图');
        setStatus('已从 SQLite 载入');
      })
      .catch((error: Error) => setStatus(`加载失败：${error.message}`));
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
    // 仅在启动时加载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 图的任何增删改动都会使上一次扫描结果失效（扫描图与当前画布不再一致）。
  const invalidateSensitivity = useCallback(() => {
    setSensitivityResult(null);
    setSensitivityStatus('');
  }, []);

  // 图编辑或传播参数编辑都会使追踪路径失效（路径集合与带符号乘积都可能变化）。
  const invalidateTrace = useCallback(() => {
    setTraceResult(null);
    setTraceStatus('');
    setTraceActiveIndex(0);
  }, []);

  // 图、分摊选择或传播参数变化都会使分摊结果失效（联盟值与 Shapley 分摊都可能变化）。
  const invalidateShapley = useCallback(() => {
    setShapleyResult(null);
    setShapleyStatus('');
    setShapleyActiveId(null);
  }, []);

  // 图编辑或目标变化都会使必经链路分析失效（瓶颈集合与覆盖关系都可能变化）。
  const invalidateBottleneck = useCallback(() => {
    setBottleneckResult(null);
    setBottleneckStatus('');
    setBottleneckActiveKey(null);
  }, []);

  // 还原画布到进入预览前的坐标，并清掉预览标记（纯视图回退，不保存、不写 SQLite）。
  const restoreOriginalLayout = useCallback(() => {
    const originalPositions = previewOriginRef.current;
    if (!originalPositions) return;
    setNodes((prevNodes) =>
      prevNodes.map((node) => ({
        ...node,
        position: originalPositions[node.id] ?? node.position,
        data: { ...node.data, layoutPreview: false }
      }))
    );
    previewOriginRef.current = null;
  }, [setNodes]);

  // 取消预览：画布恢复原样，绝不改写画布数据或 SQLite。
  const cancelLayoutPreview = useCallback(() => {
    if (!previewRef.current) return;
    restoreOriginalLayout();
    setLayoutPreview(null);
  }, [restoreOriginalLayout]);

  // 一键整理布局：纯前端计算并进入预览，不保存、不写 SQLite。
  const startLayoutPreview = useCallback(() => {
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    if (currentNodes.length === 0) return;
    const plan = planGraphLayout(graphToDocument(documentName, currentNodes, currentEdges));
    previewOriginRef.current = Object.fromEntries(
      currentNodes.map((node) => [node.id, { ...node.position }])
    );
    setNodes(
      currentNodes.map((node) => ({
        ...node,
        position: plan.positions[node.id] ?? node.position,
        data: { ...node.data, layoutPreview: true }
      }))
    );
    setLayoutPreview({ plan });
  }, [documentName, setNodes]);

  // 确认整理：一次性应用并沿用现有（防抖）保存逻辑。
  const applyLayoutPreview = useCallback(() => {
    if (!previewRef.current) return;
    previewOriginRef.current = null;
    const applied = nodesRef.current.map((node) => ({
      ...node,
      data: { ...node.data, layoutPreview: false }
    }));
    setNodes(applied);
    // 位置整理不改变图结构：保留分析结果，仅持久化新坐标（与手动拖拽同一保存路径）。
    scheduleSaveRef.current(applied, edgesRef.current);
    setLayoutPreview(null);
  }, [setNodes]);

  // 锁定 / 解锁节点位置（走既有节点更新与保存逻辑）；预览期间禁用。
  const togglePositionLock = useCallback(
    (nodeId: string, locked: boolean) => {
      if (previewRef.current) return;
      const nextNodes = nodesRef.current.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, positionLocked: locked } } : node
      );
      setNodes(nextNodes);
      scheduleSaveRef.current(nextNodes, edgesRef.current);
    },
    [setNodes]
  );

  useEffect(() => {
    const onToggle = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId?: string; locked?: boolean }>).detail;
      if (typeof detail?.nodeId === 'string' && typeof detail.locked === 'boolean') {
        togglePositionLock(detail.nodeId, detail.locked);
      }
    };
    window.addEventListener('argument:toggle-position-lock', onToggle);
    return () => window.removeEventListener('argument:toggle-position-lock', onToggle);
  }, [togglePositionLock]);

  const clearAnalysis = useCallback(
    (nextNodes = nodes, nextEdges = edges) => {
      setResult(null);
      setReplayRound(0);
      setPlaying(false);
      invalidateSensitivity();
      invalidateTrace();
      invalidateShapley();
      invalidateBottleneck();
      setNodes(
        nextNodes.map((node) => ({
          ...node,
          data: {
            ...node.data,
            displayBelief: undefined,
            roundDelta: undefined,
            inCycle: false,
            inTrace: false,
            traceStart: false,
            traceTarget: false,
            shapleyFocus: false,
            bottleneckFocus: false,
            bottleneckTarget: false,
            bottleneckCovered: false
          }
        }))
      );
      setEdges(nextEdges.map((edge) => decorateEdge({ ...edge, animated: false, style: undefined }, 'plain')));
    },
    [edges, nodes, setEdges, setNodes, invalidateSensitivity, invalidateTrace, invalidateShapley, invalidateBottleneck]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (previewRef.current) return;
      if (!connection.source || !connection.target) return;
      const edge = makeEdge({
        id: createId('edge'),
        source: connection.source,
        target: connection.target,
        stance: 'support',
        weight: 0.6
      });
      const nextEdges = [...edges, edge];
      clearAnalysis(nodes, nextEdges);
      scheduleSave(nodes, nextEdges, true);
    },
    [clearAnalysis, edges, nodes, scheduleSave, setEdges]
  );

  const onNodeDragStop: NodeMouseHandler = useCallback(
    (_event, node) => {
      // 预览中节点不可拖拽；位置变化不清除计算结果，但需要持久化布局。
      if (previewRef.current) return;
      const nextNodes = nodes.map((item) => (item.id === node.id ? node : item));
      scheduleSave(nextNodes, edges);
    },
    [edges, nodes, scheduleSave]
  );

  const addNode = (kind: 'claim' | 'evidence') => {
    if (layoutPreview) return;
    const id = createId(kind);
    const node: Node<ArgumentNodeData> = {
      id,
      type: 'argument',
      position: { x: 120 + Math.random() * 220, y: 90 + Math.random() * 260 },
      data: {
        label: kind === 'evidence' ? `证据 ${nodes.length + 1}` : `观点 ${nodes.length + 1}`,
        kind,
        initialBelief: kind === 'evidence' ? 0.8 : 0.5,
        anchored: false,
        positionLocked: false
      }
    };
    const nextNodes = [...nodes, node];
    clearAnalysis(nextNodes, edges);
    scheduleSave(nextNodes, edges, true);
  };

  const updateNode = (id: string, patch: Partial<ArgumentNodeData>) => {
    if (layoutPreview) return;
    const nextNodes = nodes.map((node) =>
      node.id === id ? { ...node, data: { ...node.data, ...patch } } : node
    );
    clearAnalysis(nextNodes, edges);
    scheduleSave(nextNodes, edges);
  };

  // 仅更新“布局位置锁定”标记：属于布局属性（类似拖拽），不清空传播分析结果。
  const updateNodeLayoutLock = (id: string, locked: boolean) => {
    if (layoutPreview) return;
    togglePositionLock(id, locked);
  };

  const updateEdge = (id: string, patch: { weight?: number; stance?: Stance }) => {
    if (layoutPreview) return;
    const nextEdges = edges.map((edge) =>
      edge.id === id ? decorateEdge({ ...edge, data: { ...edge.data, ...patch } }, 'plain') : edge
    );
    clearAnalysis(nodes, nextEdges);
    scheduleSave(nodes, nextEdges);
  };

  const deleteSelection = useCallback(() => {
    if (previewRef.current) return;
    let nextNodes = nodes;
    let nextEdges = edges;
    if (selectedNodeId) {
      nextNodes = nodes.filter((node) => node.id !== selectedNodeId);
      nextEdges = edges.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId);
      setSelectedNodeId(null);
    } else if (selectedEdgeId) {
      nextEdges = edges.filter((edge) => edge.id !== selectedEdgeId);
      setSelectedEdgeId(null);
    } else {
      return;
    }
    clearAnalysis(nextNodes, nextEdges);
    scheduleSave(nextNodes, nextEdges, true);
  }, [
    clearAnalysis,
    edges,
    nodes,
    scheduleSave,
    selectedEdgeId,
    selectedNodeId,
    setEdges,
    setNodes
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === 'Delete' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        deleteSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteSelection]);

  const runPropagation = async () => {
    setBusy(true);
    setStatus('正在迭代传播…');
    try {
      // 先保存，确保后端计算的是当前画布。
      await api.saveGraph(graphToDocument(documentName, nodes, edges));
      const { result: nextResult } = await api.propagate(options);
      const cycleNodeIds = new Set(nextResult.cycles.flatMap((cycle) => cycle.nodeIds));
      // 重新计算后，旧的路径追踪高亮不再代表“最近一次分析”，先清空，由统一装饰 effect 回落到环高亮。
      invalidateTrace();
      setResult(nextResult);
      setPlaying(false);
      setReplayRound(nextResult.iterations);
      setNodes((current) => decorateNodesForRound(current, nextResult, nextResult.iterations, cycleNodeIds));
      setStatus(nextResult.message);
    } catch (error) {
      setStatus(`计算失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  // 回放只切换展示的轮次：不修改图、不保存、不重新计算。
  const goToRound = useCallback(
    (round: number) => {
      if (!result) return;
      const clamped = Math.max(0, Math.min(result.iterations, Math.round(round)));
      setReplayRound(clamped);
      const cycleNodeIds = new Set(result.cycles.flatMap((cycle) => cycle.nodeIds));
      setNodes((current) => decorateNodesForRound(current, result, clamped, cycleNodeIds));
    },
    [result, setNodes]
  );

  // 播放：收敛结果播到停止轮即停；振荡结果在最后一个周期内循环。
  useEffect(() => {
    if (!playing || !result) return;
    const loopable = Boolean(result.oscillating && result.detectedPeriod);
    if (replayRound >= result.iterations && !loopable) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      if (replayRound >= result.iterations && loopable) {
        goToRound(Math.max(0, result.iterations - (result.detectedPeriod ?? 1) + 1));
      } else {
        goToRound(replayRound + 1);
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [playing, replayRound, result, goToRound]);

  const togglePlay = () => {
    if (!result) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    // 收敛结果停在末轮时再按播放，从第 0 轮重新播放。
    const loopable = Boolean(result.oscillating && result.detectedPeriod);
    if (replayRound >= result.iterations && !loopable) goToRound(0);
    setPlaying(true);
  };

  const loadDocument = (graph: GraphDocument, immediateSave = true, nextOptions?: PropagateOptions) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    const flow = documentToFlow(graph);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setDocumentName(graph.name ?? '导入的论证图');
    setResult(null);
    setReplayRound(0);
    setPlaying(false);
    setLayoutPreview(null);
    invalidateSensitivity();
    setSensitivitySelection({ edgeId: '', targetNodeId: '' });
    invalidateTrace();
    setTraceSelection(DEFAULT_TRACE_SELECTION);
    invalidateShapley();
    setShapleySelection(DEFAULT_SHAPLEY_SELECTION);
    invalidateBottleneck();
    setBottleneckSelection(DEFAULT_BOTTLENECK_SELECTION);
    if (nextOptions) setOptions(nextOptions);
    if (immediateSave) {
      setStatus('正在导入…');
      api
        .saveGraph(graph)
        .then(() => setStatus('JSON 已导入并保存'))
        .catch((error: Error) => setStatus(`导入失败：${error.message}`));
    }
  };

  const exportJson = () => {
    const graphDocument = graphToDocument(documentName, nodes, edges);
    const blob = new Blob([JSON.stringify(graphDocument, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${documentName || 'argument-graph'}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importJsonFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as GraphDocument | { graph: GraphDocument };
      const graph = 'graph' in parsed ? parsed.graph : parsed;
      // 后端执行严格校验并返回规范化文档。
      const saved = await api.saveGraph(graph);
      loadDocument(saved.graph, false);
      setStatus('JSON 已导入并保存');
    } catch (error) {
      setStatus(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId),
    [nodes, selectedNodeId]
  );
  const selectedEdge = useMemo(
    () => edges.find((edge) => edge.id === selectedEdgeId),
    [edges, selectedEdgeId]
  );

  // 被扫描的边或目标节点删除后，清掉失效选择；不自动重选，避免跑出用户意料之外的扫描。
  useEffect(() => {
    setSensitivitySelection((current) => {
      const edgeExists = !current.edgeId || edges.some((edge) => edge.id === current.edgeId);
      const nodeExists = !current.targetNodeId || nodes.some((node) => node.id === current.targetNodeId);
      if (edgeExists && nodeExists) return current;
      return {
        edgeId: edgeExists ? current.edgeId : '',
        targetNodeId: nodeExists ? current.targetNodeId : ''
      };
    });
  }, [edges, nodes]);

  // 选中一条连线后，默认把扫描目标填为该连线的目标节点，减少一次手动选择。
  useEffect(() => {
    if (!selectedEdge) return;
    setSensitivitySelection((current) => ({
      edgeId: selectedEdge.id,
      targetNodeId: current.targetNodeId || selectedEdge.target
    }));
  }, [selectedEdge]);

  const runSensitivityScan = useCallback(async () => {
    if (!sensitivitySelection.edgeId || !sensitivitySelection.targetNodeId) return;
    setSensitivityScanning(true);
    setSensitivityStatus('正在服务端内存中逐点计算（不保存图）…');
    try {
      // 直接提交当前画布：扫描只在服务端内存中进行，不触发任何持久化。
      const { scan } = await api.scanEdgeWeight({
        graph: graphToDocument(documentName, nodes, edges),
        edgeId: sensitivitySelection.edgeId,
        targetNodeId: sensitivitySelection.targetNodeId,
        options
      });
      setSensitivityResult(scan);
      setSensitivityStatus(scan.message);
    } catch (error) {
      setSensitivityResult(null);
      setSensitivityStatus(`扫描失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSensitivityScanning(false);
    }
  }, [documentName, edges, nodes, options, sensitivitySelection.edgeId, sensitivitySelection.targetNodeId]);

  const sensitivityEdgeLabel = useMemo(() => {
    const edge = edges.find((item) => item.id === sensitivitySelection.edgeId);
    if (!edge) return '所选连线';
    const labelById = new Map(nodes.map((node) => [node.id, node.data.label] as const));
    return `${labelById.get(edge.source) ?? edge.source} → ${labelById.get(edge.target) ?? edge.target}`;
  }, [edges, nodes, sensitivitySelection.edgeId]);

  const sensitivityTargetLabel = useMemo(
    () => nodes.find((node) => node.id === sensitivitySelection.targetNodeId)?.data.label ?? '目标节点',
    [nodes, sensitivitySelection.targetNodeId]
  );

  // 选中节点时，本地重算「当前轮 → 下一轮」的可核对分解。
  const decomposition = useMemo(() => {
    if (!result || !selectedNode) return null;
    return buildRoundDecomposition(selectedNode, nodes, edges, result, replayRound);
  }, [result, selectedNode, nodes, edges, replayRound]);

  const handleOptionsChange = useCallback(
    (nextOptions: PropagateOptions) => {
      setOptions(nextOptions);
      // 扫描沿用当前传播参数：参数一变，旧曲线对应的参数就过期了。
      invalidateSensitivity();
      // 路径分数虽不直接使用传播参数，但追踪与传播视图共用参数语境，参数编辑后一并失效。
      invalidateTrace();
      // 分摊直接沿用当前传播参数重算每个联盟：参数一变，旧分摊立即失效。
      invalidateShapley();
    },
    [invalidateSensitivity, invalidateTrace, invalidateShapley]
  );

  const runTrace = useCallback(async () => {
    if (!traceSelection.startNodeId || !traceSelection.targetNodeId) return;
    setTraceTracing(true);
    setTraceStatus('正在服务端枚举有向简单路径（不保存图）…');
    try {
      // 直接提交当前画布：追踪只在服务端内存中枚举，不触发任何持久化。
      const { trace } = await api.traceInfluence({
        graph: graphToDocument(documentName, nodes, edges),
        startNodeId: traceSelection.startNodeId,
        targetNodeId: traceSelection.targetNodeId,
        maxHops: traceSelection.maxHops
      });
      setTraceResult(trace);
      setTraceActiveIndex(0);
      setTraceStatus(trace.message);
    } catch (error) {
      setTraceResult(null);
      setTraceStatus(`追踪失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTraceTracing(false);
    }
  }, [
    documentName,
    edges,
    nodes,
    traceSelection.maxHops,
    traceSelection.startNodeId,
    traceSelection.targetNodeId
  ]);

  // 当前要在画布上高亮的路径（追踪结果中的第 activeIndex 条）。
  const activeTracePath: InfluencePath | null = useMemo(() => {
    if (!traceResult || traceResult.paths.length === 0) return null;
    const index = Math.max(0, Math.min(traceActiveIndex, traceResult.paths.length - 1));
    return traceResult.paths[index] ?? null;
  }, [traceResult, traceActiveIndex]);

  // 起点或目标节点被删除后，清掉失效追踪选择。
  useEffect(() => {
    setTraceSelection((current) => {
      const startExists =
        !current.startNodeId || nodes.some((node) => node.id === current.startNodeId && node.data.kind === 'evidence');
      const targetExists = !current.targetNodeId || nodes.some((node) => node.id === current.targetNodeId);
      if (startExists && targetExists) return current;
      return {
        startNodeId: startExists ? current.startNodeId : '',
        targetNodeId: targetExists ? current.targetNodeId : '',
        maxHops: current.maxHops
      };
    });
  }, [nodes]);

  const runShapley = useCallback(async () => {
    if (!shapleySelection.claimNodeId || shapleySelection.evidenceNodeIds.length === 0) return;
    setShapleyRunning(true);
    setShapleyStatus('正在服务端内存中重算全部证据联盟（不保存图）…');
    try {
      // 直接提交当前画布：分摊只在服务端内存中进行，不触发任何持久化。
      const { shapley } = await api.shapleyContributions({
        graph: graphToDocument(documentName, nodes, edges),
        claimNodeId: shapleySelection.claimNodeId,
        evidenceNodeIds: shapleySelection.evidenceNodeIds,
        options
      });
      setShapleyResult(shapley);
      setShapleyActiveId(null);
      setShapleyStatus(shapley.message);
    } catch (error) {
      setShapleyResult(null);
      setShapleyStatus(`分摊失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setShapleyRunning(false);
    }
  }, [documentName, edges, nodes, options, shapleySelection.claimNodeId, shapleySelection.evidenceNodeIds]);

  // 分摊选择变化即清空已展示的结果（图 / 参数变化由 clearAnalysis 与 handleOptionsChange 负责）。
  const handleShapleySelectionChange = useCallback(
    (patch: Partial<ShapleySelection>) => {
      setShapleySelection((current) => ({ ...current, ...patch }));
      invalidateShapley();
    },
    [invalidateShapley]
  );

  // 观点 / 证据节点被删除或改类型后，清掉失效的分摊选择。
  useEffect(() => {
    setShapleySelection((current) => {
      const claimExists =
        !current.claimNodeId ||
        nodes.some((node) => node.id === current.claimNodeId && node.data.kind === 'claim');
      const evidence = current.evidenceNodeIds.filter((id) =>
        nodes.some((node) => node.id === id && node.data.kind === 'evidence')
      );
      if (claimExists && evidence.length === current.evidenceNodeIds.length) return current;
      return {
        claimNodeId: claimExists ? current.claimNodeId : '',
        evidenceNodeIds: evidence
      };
    });
  }, [nodes]);

  const runBottleneck = useCallback(async () => {
    if (!bottleneckSelection.targetNodeId) return;
    setBottleneckRunning(true);
    setBottleneckStatus('正在服务端内存中分析必经链路（不保存图）…');
    try {
      // 直接提交当前画布：分析只在服务端内存中进行，不触发任何持久化。
      const { analysis } = await api.bottleneckAnalysis({
        graph: graphToDocument(documentName, nodes, edges),
        targetNodeId: bottleneckSelection.targetNodeId
      });
      setBottleneckResult(analysis);
      setBottleneckActiveKey(null);
      setBottleneckStatus(analysis.message);
    } catch (error) {
      setBottleneckResult(null);
      setBottleneckStatus(`分析失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBottleneckRunning(false);
    }
  }, [documentName, edges, nodes, bottleneckSelection.targetNodeId]);

  // 目标变化即清空已展示的分析结果与高亮（图编辑由 clearAnalysis 负责）。
  const handleBottleneckSelectionChange = useCallback(
    (patch: Partial<BottleneckSelection>) => {
      setBottleneckSelection((current) => ({ ...current, ...patch }));
      invalidateBottleneck();
    },
    [invalidateBottleneck]
  );

  // 目标观点被删除或改类型后，清掉失效的分析选择。
  useEffect(() => {
    setBottleneckSelection((current) => {
      const targetExists =
        !current.targetNodeId ||
        nodes.some((node) => node.id === current.targetNodeId && node.data.kind === 'claim');
      if (targetExists) return current;
      return { targetNodeId: '' };
    });
  }, [nodes]);

  // 当前要在画布上高亮的瓶颈（分析结果中 activeKey 对应的一项）。
  const activeBottleneck: BottleneckItem | null = useMemo(() => {
    if (!bottleneckResult || !bottleneckActiveKey) return null;
    return (
      bottleneckResult.bottlenecks.find((item) => `${item.kind}:${item.id}` === bottleneckActiveKey) ?? null
    );
  }, [bottleneckResult, bottleneckActiveKey]);

  // 点击瓶颈条目 → 在画布上高亮瓶颈、目标与覆盖证据（纯视图标记，不影响图数据与回放着色）。
  useEffect(() => {
    setNodes((current) => {
      const covered = new Set(activeBottleneck?.coveredEvidenceIds ?? []);
      const focusId = activeBottleneck?.kind === 'node' ? activeBottleneck.id : null;
      const targetId = activeBottleneck ? (bottleneckResult?.targetNodeId ?? null) : null;
      const marks = (nodeId: string) => ({
        bottleneckFocus: nodeId === focusId,
        bottleneckTarget: nodeId === targetId,
        bottleneckCovered: covered.has(nodeId)
      });
      if (
        current.every((node) => {
          const next = marks(node.id);
          return (
            Boolean(node.data.bottleneckFocus) === next.bottleneckFocus &&
            Boolean(node.data.bottleneckTarget) === next.bottleneckTarget &&
            Boolean(node.data.bottleneckCovered) === next.bottleneckCovered
          );
        })
      ) {
        return current;
      }
      return current.map((node) => ({ ...node, data: { ...node.data, ...marks(node.id) } }));
    });
  }, [activeBottleneck, bottleneckResult, setNodes]);

  // 点击瀑布条 → 在画布上高亮对应证据节点（纯视图标记，不影响图数据与回放着色）。
  useEffect(() => {
    setNodes((current) => {
      if (current.every((node) => Boolean(node.data.shapleyFocus) === (node.id === shapleyActiveId))) {
        return current;
      }
      return current.map((node) => ({
        ...node,
        data: { ...node.data, shapleyFocus: node.id === shapleyActiveId }
      }));
    });
  }, [shapleyActiveId, setNodes]);

  // 瓶颈连线高亮（优先）/ 追踪高亮 / 负反馈环高亮 / 无高亮：由最近一次分析结果统一驱动，保证连线样式幂等。
  const cycleEdgeIds = useMemo(
    () => new Set((result?.cycles ?? []).flatMap((cycle) => cycle.edgeIds)),
    [result]
  );
  useEffect(() => {
    const activeBottleneckEdgeId = activeBottleneck?.kind === 'edge' ? activeBottleneck.id : null;
    setEdges((current) =>
      current.map((edge) => {
        if (activeBottleneckEdgeId && edge.id === activeBottleneckEdgeId) {
          return decorateEdge(edge, 'bottleneck-active');
        }
        if (activeTracePath) {
          const stepIndex = activeTracePath.edgeIds.indexOf(edge.id);
          if (stepIndex >= 0) {
            return decorateEdge(edge, 'trace-active', activeTracePath.steps[stepIndex]?.runningScore);
          }
          return decorateEdge(edge, 'plain');
        }
        if (result) return decorateEdge(edge, cycleEdgeIds.has(edge.id) ? 'cycle' : 'plain');
        return decorateEdge(edge, 'plain');
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBottleneck, activeTracePath, result, cycleEdgeIds]);

  // 节点上的追踪标记（起点/目标/途经）；不动可信度着色，回放与追踪可以同时可见。
  useEffect(() => {
    if (!activeTracePath) {
      setNodes((current) => {
        if (current.every((node) => !node.data.inTrace && !node.data.traceStart && !node.data.traceTarget)) {
          return current;
        }
        return current.map((node) => ({
          ...node,
          data: { ...node.data, inTrace: false, traceStart: false, traceTarget: false }
        }));
      });
      return;
    }
    const traceNodeIds = new Set(activeTracePath.nodeIds);
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        data: {
          ...node.data,
          inTrace: traceNodeIds.has(node.id),
          traceStart: node.id === activeTracePath.nodeIds[0],
          traceTarget: node.id === activeTracePath.nodeIds[activeTracePath.nodeIds.length - 1]
        }
      }))
    );
  }, [activeTracePath, setNodes]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>论证稳定性沙盘</h1>
          <input
            className="document-name"
            value={documentName}
            onChange={(event) => setDocumentName(event.target.value)}
            onBlur={() => {
              if (!previewRef.current) scheduleSave(nodes, edges, true);
            }}
          />
        </div>
        <div className="toolbar">
          <button onClick={() => addNode('claim')} disabled={Boolean(layoutPreview)}>
            ＋ 观点
          </button>
          <button onClick={() => addNode('evidence')} disabled={Boolean(layoutPreview)}>
            ＋ 证据
          </button>
          <button className="primary" disabled={busy || nodes.length === 0} onClick={runPropagation}>
            {busy ? '计算中…' : '运行稳定性分析'}
          </button>
          <button
            disabled={nodes.length === 0 || Boolean(layoutPreview)}
            onClick={startLayoutPreview}
            title="把强连通分量压缩为 DAG 分层并执行 4 轮重心排序；锁定节点位置不变"
          >
            🧭 一键整理布局
          </button>
          <button onClick={() => loadDocument(stableSample, true, DEFAULT_OPTIONS)} disabled={Boolean(layoutPreview)}>
            载入稳定示例
          </button>
          <button
            onClick={() => loadDocument(oscillatingSample, true, { ...DEFAULT_OPTIONS, lambda: 1 })}
            disabled={Boolean(layoutPreview)}
          >
            载入振荡示例
          </button>
          <button onClick={exportJson} disabled={nodes.length === 0}>
            导出 JSON
          </button>
          <button onClick={() => fileInputRef.current?.click()} disabled={Boolean(layoutPreview)}>
            导入 JSON
          </button>
          <input
            ref={fileInputRef}
            hidden
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) importJsonFile(file);
              event.target.value = '';
            }}
          />
        </div>
      </header>

      <main className="workspace">
        <div className="canvas-wrap">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            nodesDraggable={!layoutPreview}
            nodesConnectable={!layoutPreview}
            onNodeClick={(_event, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
              // 点击证据自动设为追踪起点，点击观点自动设为追踪目标，减少手动选择。
              if (node.data.kind === 'evidence') {
                setTraceSelection((current) => ({
                  ...current,
                  startNodeId: node.id,
                  targetNodeId: current.targetNodeId === node.id ? '' : current.targetNodeId
                }));
              } else {
                setTraceSelection((current) => ({
                  ...current,
                  targetNodeId: node.id,
                  startNodeId: current.startNodeId === node.id ? '' : current.startNodeId
                }));
              }
            }}
            onEdgeClick={(_event, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            onNodesDelete={(deleted) => {
              if (deleted.some((node) => node.id === selectedNodeId)) setSelectedNodeId(null);
            }}
            onEdgesDelete={(deleted) => {
              if (deleted.some((edge) => edge.id === selectedEdgeId)) setSelectedEdgeId(null);
            }}
            fitView
            deleteKeyCode={null}
            connectionLineStyle={{ stroke: '#2563eb' }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#c7d2fe" />
            <Controls />
          </ReactFlow>
          {layoutPreview && (
            <div className="layout-preview-bar" role="region" aria-label="一键整理布局预览">
              <div className="layout-preview-metrics">
                <span className="layout-preview-title">🧭 布局整理预览</span>
                <span className="layout-metric">
                  交叉数
                  <strong className={layoutPreview.plan.after.crossings < layoutPreview.plan.before.crossings ? 'better' : ''}>
                    {layoutPreview.plan.before.crossings} → {layoutPreview.plan.after.crossings}
                  </strong>
                </span>
                <span className="layout-metric">
                  总位移
                  <strong>{formatDisplacement(layoutPreview.plan.after.totalDisplacement)}px</strong>
                </span>
                <span className="layout-metric">
                  移动节点
                  <strong>
                    {layoutPreview.plan.after.movedCount}
                  </strong>
                </span>
                <span className="layout-metric">
                  锁定节点
                  <strong>{layoutPreview.plan.after.lockedCount}</strong>
                </span>
              </div>
              <div className="layout-preview-actions">
                <button type="button" className="primary" onClick={applyLayoutPreview}>
                  ✓ 确认应用
                </button>
                <button type="button" onClick={cancelLayoutPreview}>
                  ✕ 取消
                </button>
              </div>
              <p className="layout-preview-note">预览仅在前端：确认后一次性应用并保存；取消不会改写画布或 SQLite，任何图编辑都会使预览失效。</p>
            </div>
          )}
          <div className="canvas-footer">
            {result ? (
              <ReplayBar
                result={result}
                round={replayRound}
                playing={playing}
                onSeek={goToRound}
                onTogglePlay={togglePlay}
              />
            ) : (
              <span className="canvas-footer-spacer" />
            )}
            <div className={`status-pill ${result?.oscillating ? 'bad' : result?.converged ? 'good' : ''}`}>
              {status}
            </div>
          </div>
        </div>

        <SidePanel
          options={options}
          onOptionsChange={handleOptionsChange}
          result={result}
          selection={{ node: selectedNode, edge: selectedEdge }}
          decomposition={decomposition}
          onUpdateNode={updateNode}
          onUpdateNodeLayoutLock={updateNodeLayoutLock}
          onUpdateEdge={updateEdge}
          onDeleteSelection={deleteSelection}
          graphEditingDisabled={Boolean(layoutPreview)}
          nodes={nodes}
          edges={edges}
          sensitivity={{
            selection: sensitivitySelection,
            onSelectionChange: (patch) =>
              setSensitivitySelection((current) => ({ ...current, ...patch })),
            scan: sensitivityResult,
            scanning: sensitivityScanning,
            status: sensitivityStatus,
            onRun: runSensitivityScan,
            onClose: () => setSensitivityResult(null),
            edgeLabel: sensitivityEdgeLabel,
            targetLabel: sensitivityTargetLabel
          }}
          trace={{
            selection: traceSelection,
            onSelectionChange: (patch) => setTraceSelection((current) => ({ ...current, ...patch })),
            result: traceResult,
            tracing: traceTracing,
            status: traceStatus,
            activeIndex: activeTracePath
              ? Math.max(0, Math.min(traceActiveIndex, traceResult?.paths.length ?? 1))
              : 0,
            onActiveIndexChange: setTraceActiveIndex,
            onRun: runTrace,
            onClose: invalidateTrace
          }}
          shapley={{
            selection: shapleySelection,
            onSelectionChange: handleShapleySelectionChange,
            result: shapleyResult,
            running: shapleyRunning,
            status: shapleyStatus,
            activeNodeId: shapleyActiveId,
            onToggleNode: (nodeId) =>
              setShapleyActiveId((current) => (current === nodeId ? null : nodeId)),
            onRun: runShapley,
            onClose: invalidateShapley
          }}
          bottleneck={{
            selection: bottleneckSelection,
            onSelectionChange: handleBottleneckSelectionChange,
            result: bottleneckResult,
            running: bottleneckRunning,
            status: bottleneckStatus,
            activeKey: bottleneckActiveKey,
            onToggle: (key) => setBottleneckActiveKey((current) => (current === key ? null : key)),
            onRun: runBottleneck,
            onClose: invalidateBottleneck
          }}
        />
      </main>
    </div>
  );
}
