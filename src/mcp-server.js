"use strict";

const fs = require("fs/promises");
const path = require("path");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const {
  buildCanvasContextContent,
  buildConnections,
  parseCanvasGraph,
  resolveIncomingSourceNodes,
} = require("./canvas-graph");
const {
  PROTOCOL_VERSION,
  createCanvasWriteOperation,
  waitForWriteAcknowledgement,
  writeCanvasWriteOperation,
} = require("./harness-transport");

const SERVER_VERSION = "1.0.0";
const LIVE_CANVAS_MIRROR_INTERVAL_MS = 250;

const TOOLS = [
  {
    name: "read_context",
    description: "Read the full content of every Canvas node connected TO this harness, following incoming edges only. The full text is returned in fullText and the source metadata in sources. Call this before reasoning about any request in this session. File nodes are read from the vault; text nodes come from the live Canvas document.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Read only this incoming Canvas node. Omit to read every connected node." },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        fullText: { type: "string" },
        contextVersion: { anyOf: [{ type: "string" }, { type: "null" }] },
        capturedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: { type: "string", enum: ["text", "file"] },
              title: { type: "string" },
              contentHash: { type: "string" },
            },
            required: ["id", "type", "title", "contentHash"],
            additionalProperties: false,
          },
        },
      },
      required: ["fullText", "contextVersion", "capturedAt", "sources"],
      additionalProperties: false,
    },
  },
  {
    name: "find_connected_nodes",
    description: "Inspect the current Canvas graph and list every node directly connected to this harness, including whether the connection is incoming or outgoing. Use this before write_canvas_node when the target ID is unknown.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { nodes: { type: "array", items: { type: "object" } } },
      required: ["nodes"],
      additionalProperties: false,
    },
  },
  {
    name: "write_canvas_node",
    description: "Write explicit content to one direct outgoing Canvas text or file target. Call find_connected_nodes first when the target ID is unknown. Never guess, fan out, or use this tool for unrelated files. Replace is the default mode; append adds a newline boundary when needed.",
    inputSchema: {
      type: "object",
      properties: {
        targetNodeId: { type: "string", description: "ID of a direct outgoing Canvas target node returned by find_connected_nodes." },
        content: { type: "string", description: "Complete content to replace or append." },
        mode: { type: "string", enum: ["replace", "append"] },
      },
      required: ["targetNodeId", "content"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        version: { type: "integer" },
        operationId: { type: "string" },
        harnessId: { type: "string" },
        receivedAt: { type: "string" },
        status: { type: "string", enum: ["accepted", "rejected", "failed"] },
        targetNodeId: { type: "string" },
        targetType: { type: "string", enum: ["text", "file"] },
        file: { type: "string" },
        mode: { type: "string", enum: ["replace", "append"] },
        error: { type: "string" },
      },
      required: ["version", "operationId", "harnessId", "receivedAt", "status"],
      additionalProperties: true,
    },
  },
];

async function main() {
  const state = readEnvironment();
  const server = new Server(
    { name: "faust-canvas", version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: "Canvas context is provided by connected incoming nodes. Writes are restricted to explicitly connected outgoing targets.",
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments || {};
    try {
      if (name === "read_context") return await readContext(state, await readCanvasState(state), args);
      if (name === "find_connected_nodes") {
        // The Obsidian host mirrors unsaved Canvas edits on a 250 ms interval. Wait for
        // that cycle before reading so a just-created edge is not hidden by the prior snapshot.
        await delay(LIVE_CANVAS_MIRROR_INTERVAL_MS + 50);
        return await findConnectedNodes(state, await readCanvasState(state));
      }
      if (name === "write_canvas_node") return await writeCanvasNode(state, args);
      return toolError(`Unknown Faust Canvas tool "${name}".`);
    } catch (error) {
      return toolError(error.message || String(error));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function readEnvironment() {
  const directory = process.env.FAUST_BRIDGE_DIR;
  const harnessId = process.env.FAUST_HARNESS_ID;
  const bridgeToken = process.env.FAUST_BRIDGE_TOKEN;
  const protocolVersion = Number(process.env.FAUST_PROTOCOL_VERSION);
  if (!directory || !harnessId || !bridgeToken || protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("Canvas MCP server requires a valid Faust harness session.");
  }
  const canvasPath = process.env.FAUST_CANVAS_PATH || "";
  const harnessNodeId = process.env.FAUST_HARNESS_NODE_ID || "";
  if (!canvasPath || !harnessNodeId) throw new Error("Canvas path and harness node ID are required for this session.");
  return {
    directory,
    harnessId,
    bridgeToken,
    protocolVersion,
    canvasPath,
    harnessNodeId,
    canvasStatePath: process.env.FAUST_CANVAS_STATE_PATH || path.join(directory, "canvas-state.json"),
    outboxDirectory: path.join(directory, "outbox"),
    writeProcessedDirectory: path.join(directory, "write-processed"),
    writeAcknowledgementsDirectory: path.join(directory, "write-acks"),
    writeErrorsDirectory: path.join(directory, "write-errors"),
    sessionPath: path.join(directory, "session.json"),
    sessionId: path.basename(directory),
  };
}

async function readCanvasState(state) {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(state.canvasStatePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return {
    version: raw.contextVersion,
    capturedAt: raw.capturedAt,
    graph: parseCanvasGraph(raw.graph),
  };
}

async function readContext(state, snapshot, { nodeId } = {}) {
  if (nodeId !== undefined && typeof nodeId !== "string") throw new Error("nodeId must be a string when provided.");
  if (!snapshot) return structuredTextResult(
    "This harness has no Canvas state yet. Ask the user to reopen the Canvas.",
    { contextVersion: null, capturedAt: null, sources: [] }
  );
  const sources = await resolveIncomingSourceNodes(
    snapshot.graph,
    state.harnessNodeId,
    readVaultFile,
    nodeId ? { nodeId } : {}
  );
  if (sources.length === 0) {
    const message = nodeId
      ? `Canvas node "${nodeId}" is not connected to this harness by an incoming edge.`
      : "No Canvas node is connected to this harness yet. Ask the user to connect the nodes that hold the context.";
    return structuredTextResult(message, {
      contextVersion: snapshot.version,
      capturedAt: snapshot.capturedAt,
      sources: [],
    });
  }
  const assembled = buildCanvasContextContent(sources);
  return structuredTextResult(assembled.content, {
    contextVersion: snapshot.version,
    capturedAt: snapshot.capturedAt,
    sources: assembled.sourceNodes,
  });
}

async function findConnectedNodes(state, snapshot) {
  const nodes = snapshot ? buildConnections(snapshot.graph, state.harnessNodeId) : [];
  return { ...textResult(JSON.stringify(nodes, null, 2)), structuredContent: { nodes } };
}

async function writeCanvasNode(state, { targetNodeId, content, mode = "replace" } = {}) {
  if (typeof targetNodeId !== "string" || !targetNodeId) throw new Error("targetNodeId is required.");
  if (typeof content !== "string") throw new Error("content must be a string.");
  if (!new Set(["replace", "append"]).has(mode)) throw new Error('mode must be "replace" or "append".');
  const operation = createCanvasWriteOperation({
    harnessId: state.harnessId,
    bridgeToken: state.bridgeToken,
    canvasPath: state.canvasPath,
    harnessNodeId: state.harnessNodeId,
    targetNodeId,
    content,
    mode,
  });
  await writeCanvasWriteOperation(state, operation);
  const acknowledgement = await waitForWriteAcknowledgement(state, operation.operationId);
  const target = acknowledgement.targetNodeId || operation.targetNodeId;
  if (acknowledgement.status !== "accepted") {
    return { ...toolError(`Canvas target ${target} was rejected: ${acknowledgement.error || "write failed"}`), structuredContent: acknowledgement };
  }
  return { ...textResult(`Canvas target ${target} updated with ${operation.mode}.`), structuredContent: acknowledgement };
}

async function readVaultFile(filePath) {
  return fs.readFile(path.resolve(process.cwd(), filePath), "utf8");
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function structuredTextResult(text, structuredContent) {
  return { ...textResult(text), structuredContent: { ...structuredContent, fullText: text } };
}

function toolError(text) {
  return { ...textResult(text), isError: true };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function initializeBridge(state) {
  await Promise.all([
    fs.mkdir(state.outboxDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(state.writeProcessedDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(state.writeAcknowledgementsDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(state.writeErrorsDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await writeJsonAtomically(state.sessionPath, {
    protocolVersion: state.protocolVersion,
    harnessId: state.harnessId,
    canvasPath: state.canvasPath,
    harnessNodeId: state.harnessNodeId,
    pid: process.pid,
    sessionId: state.sessionId,
    startedAt: new Date().toISOString(),
  });
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

if (require.main === module) {
  Promise.resolve()
    .then(() => initializeBridge(readEnvironment()))
    .then(main)
    .catch((error) => {
      process.stderr.write(`Faust Canvas MCP server: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { TOOLS, findConnectedNodes, readContext, readEnvironment, readCanvasState, writeCanvasNode };
