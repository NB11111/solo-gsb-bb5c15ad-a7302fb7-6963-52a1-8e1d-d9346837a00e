import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GraphDocument } from '../shared/graph.js';

const EMPTY_GRAPH: GraphDocument = { version: 1, name: '我的论证图', nodes: [], edges: [] };

export interface GraphStore {
  getGraph(): GraphDocument;
  replaceGraph(graph: GraphDocument): GraphDocument;
  close(): void;
}

export function createGraphStore(databasePath: string): GraphStore {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('claim', 'evidence')),
      initial_belief REAL NOT NULL CHECK (initial_belief BETWEEN 0 AND 1),
      anchored INTEGER NOT NULL DEFAULT 0,
      position_locked INTEGER NOT NULL DEFAULT 0,
      pos_x REAL NOT NULL DEFAULT 0,
      pos_y REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      stance TEXT NOT NULL CHECK (stance IN ('support', 'rebut')),
      weight REAL NOT NULL CHECK (weight BETWEEN 0 AND 1),
      sort_order INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
  `);

  // 旧版本数据库没有 position_locked 列：幂等补列，已有节点默认未锁定。
  const nodeColumns = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
  if (!nodeColumns.some((column) => column.name === 'position_locked')) {
    db.exec('ALTER TABLE nodes ADD COLUMN position_locked INTEGER NOT NULL DEFAULT 0');
  }

  const hydrate = (): GraphDocument => {
    const meta = db.prepare('SELECT name FROM graph_meta WHERE id = 1').get() as { name: string } | undefined;
    const nodeRows = db
      .prepare(
        'SELECT id, label, kind, initial_belief, anchored, position_locked, pos_x, pos_y FROM nodes ORDER BY sort_order, rowid'
      )
      .all() as Array<{
        id: string;
        label: string;
        kind: 'claim' | 'evidence';
        initial_belief: number;
        anchored: number;
        position_locked: number;
        pos_x: number;
        pos_y: number;
      }>;
    const edgeRows = db
      .prepare('SELECT id, source_id, target_id, stance, weight FROM edges ORDER BY sort_order, rowid')
      .all() as Array<{
        id: string;
        source_id: string;
        target_id: string;
        stance: 'support' | 'rebut';
        weight: number;
      }>;

    return {
      version: 1,
      name: meta?.name ?? '我的论证图',
      nodes: nodeRows.map((row) => ({
        id: row.id,
        label: row.label,
        kind: row.kind,
        initialBelief: row.initial_belief,
        anchored: Boolean(row.anchored),
        positionLocked: Boolean(row.position_locked),
        position: { x: row.pos_x, y: row.pos_y }
      })),
      edges: edgeRows.map((row) => ({
        id: row.id,
        source: row.source_id,
        target: row.target_id,
        stance: row.stance,
        weight: row.weight
      }))
    };
  };

  const replaceGraph = db.transaction((graph: GraphDocument) => {
    db.prepare('DELETE FROM edges').run();
    db.prepare('DELETE FROM nodes').run();
    db.prepare('INSERT OR REPLACE INTO graph_meta (id, name, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)').run(
      graph.name ?? '我的论证图'
    );
    const insertNode = db.prepare(
      `INSERT INTO nodes (id, label, kind, initial_belief, anchored, position_locked, pos_x, pos_y, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    graph.nodes.forEach((node, index) => {
      insertNode.run(
        node.id,
        node.label,
        node.kind,
        node.initialBelief,
        node.anchored ? 1 : 0,
        node.positionLocked ? 1 : 0,
        node.position.x,
        node.position.y,
        index
      );
    });
    const insertEdge = db.prepare(
      `INSERT INTO edges (id, source_id, target_id, stance, weight, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    graph.edges.forEach((edge, index) => {
      insertEdge.run(edge.id, edge.source, edge.target, edge.stance, edge.weight, index);
    });
    return hydrate();
  });

  const count = db.prepare('SELECT COUNT(*) AS count FROM graph_meta').get() as { count: number };
  if (count.count === 0) replaceGraph(EMPTY_GRAPH);

  return {
    getGraph: hydrate,
    replaceGraph: (graph) => replaceGraph(graph) as GraphDocument,
    close: () => db.close()
  };
}
