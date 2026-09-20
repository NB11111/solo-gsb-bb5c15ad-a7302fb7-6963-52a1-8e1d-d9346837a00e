import express from 'express';
import cors from 'cors';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createGraphStore } from './db.js';
import { propagateBeliefs, validateGraphDocument, validateOptions } from './propagation.js';
import {
  scanEdgeWeightSensitivity,
  validateSamples,
  validateSensitivitySelection
} from './sensitivity.js';
import { traceInfluencePaths, validateMaxHops, validateTraceSelection } from './trace.js';
import { computeEvidenceShapley, validateShapleySelection } from './shapley.js';
import { analyzeMandatoryLinks, validateBottleneckSelection } from './bottleneck.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, '../..');
const port = Number(process.env.PORT ?? 8080);
const databasePath = resolve(projectRoot, process.env.DATABASE_PATH ?? './data/argument.db');
const staticDirectory = resolve(projectRoot, 'dist');

const store = createGraphStore(databasePath);
const app = express();

app.use(cors());
app.use(express.json({ limit: '8mb' }));

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, database: databasePath });
});

app.get('/api/graph', (_request, response) => {
  response.json({ graph: store.getGraph() });
});

app.put('/api/graph', (request, response) => {
  try {
    // 同时接受完整 GraphDocument 与 { graph: GraphDocument }。
    const candidate = request.body?.graph ?? request.body;
    const graph = validateGraphDocument(candidate);
    const saved = store.replaceGraph(graph);
    response.json({ graph: saved });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : '无效图数据。' });
  }
});

app.post('/api/propagate', (request, response) => {
  try {
    const options = validateOptions(request.body?.options ?? request.body);
    const result = propagateBeliefs(store.getGraph(), options);
    response.json({ result });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : '传播参数无效。' });
  }
});

// 边权敏感性扫描：使用请求体携带的当前画布图，在内存中逐点计算，绝不保存或修改持久化图。
app.post('/api/sensitivity/edge-weight', (request, response) => {
  try {
    const candidate = request.body?.graph;
    if (candidate === undefined || candidate === null) {
      throw new Error('请求体必须携带当前图 graph（扫描不会保存该图）。');
    }
    const graph = validateGraphDocument(candidate);
    validateSensitivitySelection(graph, request.body?.edgeId, request.body?.targetNodeId);
    const options = validateOptions(request.body?.options);
    const samples = validateSamples(request.body?.samples);
    const scan = scanEdgeWeightSensitivity(
      graph,
      request.body.edgeId,
      request.body.targetNodeId,
      options,
      samples
    );
    response.json({ scan });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : '敏感性扫描请求无效。' });
  }
});

// 影响路径追踪：使用请求体携带的当前画布图，在内存中枚举至多 8 跳简单路径，绝不保存或修改持久化图。
app.post('/api/trace/influence-paths', (request, response) => {
  try {
    const candidate = request.body?.graph;
    if (candidate === undefined || candidate === null) {
      throw new Error('请求体必须携带当前图 graph（追踪不会保存该图）。');
    }
    const graph = validateGraphDocument(candidate);
    validateTraceSelection(graph, request.body?.startNodeId, request.body?.targetNodeId);
    const maxHops = validateMaxHops(request.body?.maxHops);
    const trace = traceInfluencePaths(graph, request.body.startNodeId, request.body.targetNodeId, maxHops);
    response.json({ trace });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : '影响路径追踪请求无效。' });
  }
});

// 证据贡献分摊：使用请求体携带的当前画布图，在内存中对全部 2^n 个证据联盟重算传播并做精确 Shapley 分摊，绝不保存或修改持久化图。
app.post('/api/shapley/evidence-contribution', (request, response) => {
  try {
    const candidate = request.body?.graph;
    if (candidate === undefined || candidate === null) {
      throw new Error('请求体必须携带当前图 graph（分摊不会保存该图）。');
    }
    const graph = validateGraphDocument(candidate);
    validateShapleySelection(graph, request.body?.claimNodeId, request.body?.evidenceNodeIds);
    const options = validateOptions(request.body?.options);
    const shapley = computeEvidenceShapley(
      graph,
      request.body.claimNodeId,
      request.body.evidenceNodeIds,
      options
    );
    response.json({ shapley });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : '证据贡献分摊请求无效。' });
  }
});

// 必经链路分析：使用请求体携带的当前画布图，在内存中按「删除后不可达」精确计算瓶颈（天然处理环），绝不保存或修改持久化图。
app.post('/api/bottleneck/mandatory-links', (request, response) => {
  try {
    const candidate = request.body?.graph;
    if (candidate === undefined || candidate === null) {
      throw new Error('请求体必须携带当前图 graph（分析不会保存该图）。');
    }
    const graph = validateGraphDocument(candidate);
    validateBottleneckSelection(graph, request.body?.targetNodeId);
    const analysis = analyzeMandatoryLinks(graph, request.body.targetNodeId);
    response.json({ analysis });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : '必经链路分析请求无效。' });
  }
});

if (existsSync(staticDirectory)) {
  app.use(express.static(staticDirectory));
  app.get('*', (_request, response) => response.sendFile(resolve(staticDirectory, 'index.html')));
}

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`论证稳定性沙盘已启动: http://localhost:${port}`);
  console.log(`SQLite 数据库: ${databasePath}`);
});

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
