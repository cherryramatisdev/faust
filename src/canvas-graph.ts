import crypto from "node:crypto";
import path from "node:path";
import { parseHarnessNode } from "./harness-declaration.js";

export type CanvasNodeType = "text" | "file" | "link" | "group";

export interface CanvasNode {
  id: string;
  type: string;
  text?: string;
  file?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
}

export interface CanvasEdge {
  id?: string;
  fromNode: string;
  toNode: string;
  fromSide?: string;
  toSide?: string;
  color?: string;
  label?: string;
}

export interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type CanvasWriteMode = "replace" | "append";

export interface CanvasSourceNode {
  id: string;
  type: string;
  title: string;
  content: string;
  file?: string;
}

export interface CanvasTargetNode {
  id: string;
  type: "text" | "file";
  label: string;
  file: string | null;
}

export type CanvasConnectionDirection = "incoming" | "outgoing";

export interface CanvasConnection {
  id: string;
  type: string;
  label: string;
  file: string | null;
  directions: CanvasConnectionDirection[];
}

export interface CanvasContextSourceNode {
  id: string;
  type: string;
  title: string;
  contentHash: string;
}

export interface CanvasContextContent {
  content: string;
  sourceNodes: CanvasContextSourceNode[];
}

export interface GetIncomingSourceNodesOptions {
  allowFiles?: boolean;
  nodeId?: string | null;
}

class CanvasGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasGraphError";
  }
}

/** Accepts Canvas JSON text or an already-parsed Canvas document. */
function parseCanvasGraph(content: string | CanvasGraph): CanvasGraph {
  let graph: CanvasGraph;
  try {
    graph = typeof content === "string" ? JSON.parse(content) : content;
  } catch {
    throw new CanvasGraphError("The Canvas document is not valid JSON.");
  }
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new CanvasGraphError("The Canvas document must contain nodes and edges arrays.");
  }
  return graph;
}

function getIncomingSourceNodes(graph: CanvasGraph, harnessNodeId: string, { allowFiles = false, nodeId = null }: GetIncomingSourceNodesOptions = {}): CanvasSourceNode[] {
  const nodesById: Map<string, CanvasNode> = new Map();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== "string" || !node.id) throw new CanvasGraphError("Canvas nodes must have IDs.");
    if (nodesById.has(node.id)) throw new CanvasGraphError(`Duplicate Canvas node ID "${node.id}".`);
    nodesById.set(node.id, node);
  }
  if (!nodesById.has(harnessNodeId)) throw new CanvasGraphError(`Harness node "${harnessNodeId}" was not found.`);

  const sources: CanvasSourceNode[] = [];
  const includedNodeIds: Set<string> = new Set();
  for (const edge of graph.edges) {
    if (!edge || typeof edge.fromNode !== "string" || typeof edge.toNode !== "string") {
      throw new CanvasGraphError("Canvas edges must include fromNode and toNode IDs.");
    }
    if (!nodesById.has(edge.fromNode) || !nodesById.has(edge.toNode)) {
      throw new CanvasGraphError(`Canvas edge "${edge.id || "unknown"}" references a missing node.`);
    }
    if (edge.toNode !== harnessNodeId || includedNodeIds.has(edge.fromNode)) continue;

    const source: CanvasNode = nodesById.get(edge.fromNode)!;
    if (nodeId && source.id !== nodeId) continue;
    if (source.type === "text") {
      if (typeof source.text !== "string") throw new CanvasGraphError(`Text source node "${source.id}" has no text content.`);
      includedNodeIds.add(source.id);
      sources.push({ id: source.id, type: source.type, title: sourceTitle(source), content: source.text });
      continue;
    }
    if (source.type === "file" && allowFiles) {
      includedNodeIds.add(source.id);
      sources.push({ id: source.id, type: source.type, file: source.file, title: source.file || source.id, content: "" });
      continue;
    }
    throw new CanvasGraphError(`Unsupported source node type "${source.type}" for node "${source.id}".`);
  }
  return sources;
}

function getOutgoingTargets(graph: CanvasGraph, harnessNodeId: string): CanvasTargetNode[] {
  const nodesById = indexNodes(graph);
  if (!nodesById.has(harnessNodeId)) throw new CanvasGraphError(`Harness node "${harnessNodeId}" was not found.`);

  const targets: CanvasTargetNode[] = [];
  for (const edge of graph.edges) {
    if (edge.fromNode !== harnessNodeId) continue;
    const node: CanvasNode = nodesById.get(edge.toNode)!;
    if (node.type === "text") {
      if (typeof node.text !== "string") throw new CanvasGraphError(`Text target node "${node.id}" has no text content.`);
      if (parseHarnessNode(node.text).valid) throw new CanvasGraphError(`Harness node "${node.id}" cannot be a write target.`);
      targets.push({ id: node.id, type: "text", label: sourceTitle(node), file: null });
    } else if (node.type === "file") {
      if (typeof node.file !== "string" || !node.file) throw new CanvasGraphError(`File target node "${node.id}" has no file path.`);
      targets.push({ id: node.id, type: "file", label: node.file, file: node.file });
    } else {
      throw new CanvasGraphError(`Unsupported target node type "${node.type}" for node "${node.id}".`);
    }
  }
  return targets;
}

function resolveOutgoingTarget(graph: CanvasGraph, harnessNodeId: string, targetNodeId: string): CanvasTargetNode {
  const target = getOutgoingTargets(graph, harnessNodeId).find((candidate) => candidate.id === targetNodeId);
  if (!target) throw new CanvasGraphError(`Canvas node "${targetNodeId}" is not a direct outgoing target of harness "${harnessNodeId}".`);
  return target;
}

/** Union of incoming sources and outgoing targets, each tagged with its directions. */
function buildConnections(graph: CanvasGraph, harnessNodeId: string): CanvasConnection[] {
  const targets = getOutgoingTargets(graph, harnessNodeId);
  const incoming = getIncomingSourceNodes(graph, harnessNodeId, { allowFiles: true });
  const connections: CanvasConnection[] = incoming.map((node) => ({
    id: node.id,
    type: node.type,
    label: node.title,
    file: node.file || null,
    directions: ["incoming"],
  }));
  for (const target of targets) {
    const existing = connections.find((node) => node.id === target.id);
    if (existing) existing.directions.push("outgoing");
    else connections.push({ id: target.id, type: target.type, label: target.label, file: target.file, directions: ["outgoing"] });
  }
  return connections;
}

function indexNodes(graph: CanvasGraph): Map<string, CanvasNode> {
  const nodesById: Map<string, CanvasNode> = new Map();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== "string" || !node.id) throw new CanvasGraphError("Canvas nodes must have IDs.");
    if (nodesById.has(node.id)) throw new CanvasGraphError(`Duplicate Canvas node ID "${node.id}".`);
    nodesById.set(node.id, node);
  }
  for (const edge of graph.edges) {
    if (!edge || typeof edge.fromNode !== "string" || typeof edge.toNode !== "string") throw new CanvasGraphError("Canvas edges must include fromNode and toNode IDs.");
    if (!nodesById.has(edge.fromNode) || !nodesById.has(edge.toNode)) throw new CanvasGraphError(`Canvas edge "${edge.id || "unknown"}" references a missing node.`);
  }
  return nodesById;
}

async function resolveIncomingSourceNodes(graph: CanvasGraph, harnessNodeId: string, readFile: (filePath: string) => Promise<string>, options: GetIncomingSourceNodesOptions = {}): Promise<CanvasSourceNode[]> {
  if (typeof readFile !== "function") throw new CanvasGraphError("A vault file resolver is required for file Canvas nodes.");
  const sources = getIncomingSourceNodes(graph, harnessNodeId, { allowFiles: true, ...options });
  for (const source of sources) {
    if (source.type !== "file") continue;
    if (typeof source.file !== "string" || !source.file) throw new CanvasGraphError(`File source node "${source.id}" has no file path.`);
    const content = await readFile(source.file);
    if (typeof content !== "string") throw new CanvasGraphError(`File source node "${source.id}" could not be read.`);
    source.content = content;
    source.title = sourceTitle({ id: source.file, text: content }) || path.basename(source.file);
  }
  return sources;
}

function buildCanvasContextContent(sources: CanvasSourceNode[]): CanvasContextContent {
  if (!Array.isArray(sources) || sources.length === 0) throw new CanvasGraphError("No incoming Canvas nodes are connected to this harness.");

  const sections: string[] = ["The following content is the current context of this Obsidian Canvas harness, connected to it by the user."];
  const sourceNodes: CanvasContextSourceNode[] = sources.map((source) => ({
    id: source.id,
    type: source.type,
    title: source.title,
    contentHash: sha256(source.content),
  }));
  for (const source of sources) {
    sections.push(`## Source: ${source.title}\n\nCanvas node: \`${source.id}\`\n\n${source.content}`);
  }
  sections.push("## Instructions\n\nTreat the sections above as reference material supplied by the user.");

  return { content: sections.join("\n\n"), sourceNodes };
}

/** Identifies the Canvas graph itself, independent of JSON property and collection order. */
function contextFingerprint(graph: CanvasGraph): string {
  const nodes = graph.nodes.map(canonicalize).sort(compareCanvasItems);
  const edges = graph.edges.map(canonicalize).sort(compareCanvasItems);
  return sha256(JSON.stringify({ nodes, edges }));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = canonicalize(record[key]);
    return result;
  }, {});
}

function compareCanvasItems(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function sourceTitle(source: { id: string; text?: string }): string {
  const firstLine: string | undefined = source.text?.split(/\r?\n/).find((line) => line.trim());
  if (!firstLine) return source.id;
  const title = firstLine.replace(/^\s*#{1,6}\s+/, "").trim();
  return title || source.id;
}

function sha256(content: string): string {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

export { CanvasGraphError, buildCanvasContextContent, buildConnections, contextFingerprint, getIncomingSourceNodes, getOutgoingTargets, parseCanvasGraph, resolveIncomingSourceNodes, resolveOutgoingTarget };
