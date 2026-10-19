import fs from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseCanvasGraph } from "./canvas-graph.js";
import type { CanvasGraph } from "./canvas-graph.js";
import { createCanvasMcpRequests, toolError } from "./canvas-mcp-requests.js";
import type { CanvasSnapshot, ReadContextArgs, WriteCanvasNodeArgs } from "./canvas-mcp-requests.js";
import { PROTOCOL_VERSION, submitCanvasWrite as submitCanvasWriteOperation } from "./harness-transport.js";

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

interface McpState {
  directory: string;
  harnessId: string;
  bridgeToken: string;
  protocolVersion: number;
  canvasPath: string;
  harnessNodeId: string;
  canvasStatePath: string;
  outboxDirectory: string;
  writeProcessedDirectory: string;
  writeAcknowledgementsDirectory: string;
  writeErrorsDirectory: string;
  sessionPath: string;
  sessionId: string;
}

const SERVER_VERSION: string = "1.0.0";

const TOOLS: ToolSchema[] = [
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

async function main(): Promise<void> {
  const state: McpState = readEnvironment();
  const requests = createCanvasMcpRequests({
    harnessNodeId: state.harnessNodeId,
    readCanvasState: () => readCanvasState(state),
    readVaultFile,
    submitCanvasWrite: (request) =>
      submitCanvasWriteOperation(state, {
        harnessId: state.harnessId,
        bridgeToken: state.bridgeToken,
        canvasPath: state.canvasPath,
        harnessNodeId: state.harnessNodeId,
        ...request,
      }),
  });
  const server: Server = new Server(
    { name: "faust-canvas", version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: "Canvas context is provided by connected incoming nodes. Writes are restricted to explicitly connected outgoing targets."
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  // The MCP SDK's ServerResult type is stricter than our tool results; the handler return
  // is typed as any to bridge SDK version drift without changing runtime behavior.
  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<any> => {
    const name: string = request.params.name;
    const args: Record<string, unknown> = request.params.arguments || {};
    try {
      if (name === "read_context") return await requests.readContext(args as ReadContextArgs);
      if (name === "find_connected_nodes") return await requests.findConnectedNodes();
      if (name === "write_canvas_node") return await requests.writeCanvasNode(args as WriteCanvasNodeArgs);
      return toolError(`Unknown Faust Canvas tool "${name}".`);
    } catch (error) {
      return toolError((error as Error).message || String(error));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function readEnvironment(): McpState {
  const directory: string | undefined = process.env.FAUST_BRIDGE_DIR;
  const harnessId: string | undefined = process.env.FAUST_HARNESS_ID;
  const bridgeToken: string | undefined = process.env.FAUST_BRIDGE_TOKEN;
  const protocolVersion: number = Number(process.env.FAUST_PROTOCOL_VERSION);
  if (!directory || !harnessId || !bridgeToken || protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("Canvas MCP server requires a valid Faust harness session.");
  }
  const canvasPath: string = process.env.FAUST_CANVAS_PATH || "";
  const harnessNodeId: string = process.env.FAUST_HARNESS_NODE_ID || "";
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

async function readCanvasState(state: McpState): Promise<CanvasSnapshot | null> {
  let raw: { contextVersion: string; capturedAt: string; graph: CanvasGraph };
  try {
    raw = JSON.parse(await fs.readFile(state.canvasStatePath, "utf8")) as { contextVersion: string; capturedAt: string; graph: CanvasGraph };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return {
    version: raw.contextVersion,
    capturedAt: raw.capturedAt,
    graph: parseCanvasGraph(raw.graph),
  };
}

async function readVaultFile(filePath: string): Promise<string> {
  return fs.readFile(path.resolve(process.cwd(), filePath), "utf8");
}

async function initializeBridge(state: McpState): Promise<void> {
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

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath: string = `${filePath}.${process.pid}.${Date.now()}.tmp`;
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

export { readCanvasState, readEnvironment, TOOLS };
