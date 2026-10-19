import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  type CanvasSnapshot,
  createCanvasMcpRequests,
  type ReadContextArgs,
} from "../src/canvas-mcp-requests.js";
import { parseCanvasGraph } from "../src/canvas-graph.js";
import type { CanvasGraph } from "../src/canvas-graph.js";

const harnessId: string = "harness-1";
const harnessNodeId: string = "agent-card";

const graph = {
  nodes: [
    {
      id: "text-context",
      type: "text",
      text: "# Requirements\nUse the connected brief.",
    },
    { id: "file-context", type: "file", file: "notes/context.md" },
    {
      id: harnessNodeId,
      type: "text",
      text: "```agent-harness\nid: harness-1\nprovider: pi\n```",
    },
    { id: "answer", type: "text", text: "Draft" },
  ],
  edges: [
    { id: "text-in", fromNode: "text-context", toNode: harnessNodeId },
    { id: "file-in", fromNode: "file-context", toNode: harnessNodeId },
    { id: "answer-out", fromNode: harnessNodeId, toNode: "answer" },
  ],
};

async function temporaryRoot(t: TestContext): Promise<string> {
  const root: string = await fs.mkdtemp(
    path.join(os.tmpdir(), "faust-mcp-requests-test-"),
  );
  t.after(fs.rm.bind(fs, root, { recursive: true, force: true }));
  return root;
}

async function setup(
  t: TestContext,
  acknowledgementStatus: "accepted" | "rejected" = "accepted",
) {
  const root: string = await temporaryRoot(t);
  const vaultRoot: string = path.join(root, "vault");
  const canvasStatePath: string = path.join(root, "canvas-state.json");
  const contextFile: string = path.join(vaultRoot, "notes", "context.md");
  await fs.mkdir(path.dirname(contextFile), { recursive: true });
  await fs.writeFile(
    contextFile,
    "# File brief\nKeep the decision local.",
    "utf8",
  );
  const snapshot: CanvasSnapshot = {
    version: "snapshot-v1",
    capturedAt: "2026-10-18T12:00:00.000Z",
    graph: parseCanvasGraph(graph),
  };
  await fs.writeFile(
    canvasStatePath,
    JSON.stringify({
      contextVersion: snapshot.version,
      capturedAt: snapshot.capturedAt,
      graph: snapshot.graph,
    }),
    "utf8",
  );

  const acknowledgement = {
    version: 1,
    operationId: "write-test",
    harnessId,
    status: acknowledgementStatus,
    receivedAt: "2026-10-18T12:00:01.000Z",
    targetNodeId: "host-resolved-answer",
    targetType: "text",
    mode: "replace",
    ...(acknowledgementStatus === "rejected"
      ? { error: "The target is no longer available." }
      : {}),
  } as const;
  const requests = createCanvasMcpRequests({
    harnessNodeId,
    async readCanvasState(): Promise<CanvasSnapshot | null> {
      try {
        const stored = JSON.parse(
          await fs.readFile(canvasStatePath, "utf8"),
        ) as { contextVersion: string; capturedAt: string; graph: unknown };
        return {
          version: stored.contextVersion,
          capturedAt: stored.capturedAt,
          graph: parseCanvasGraph(stored.graph as CanvasGraph),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async readVaultFile(filePath: string): Promise<string> {
      return fs.readFile(path.join(vaultRoot, filePath), "utf8");
    },
    async submitCanvasWrite() {
      return acknowledgement;
    },
  });

  return { requests, canvasStatePath };
}

test("read_context resolves a selected incoming file from temporary vault state", async (t: TestContext) => {
  const { requests } = await setup(t);

  const result = await requests.readContext({ nodeId: "file-context" });

  assert.match(result.content[0].text, /Keep the decision local\./);
  assert.equal(result.structuredContent.contextVersion, "snapshot-v1");
  const sources = result.structuredContent.sources as Array<
    { id: string; type: string; title: string; contentHash: string }
  >;
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "file-context");
  assert.equal(sources[0].type, "file");
  assert.equal(sources[0].title, "File brief");
  assert.match(sources[0].contentHash, /^sha256:/);
});

test("read_context reports absent Canvas state without fabricating sources", async (t: TestContext) => {
  const { requests, canvasStatePath } = await setup(t);
  await fs.rm(canvasStatePath);

  const result = await requests.readContext();

  assert.equal(result.structuredContent.contextVersion, null);
  assert.deepEqual(result.structuredContent.sources, []);
  assert.match(result.content[0].text, /no Canvas state yet/);
});

test("read_context rejects a non-string nodeId", async (t: TestContext) => {
  const { requests } = await setup(t);

  await assert.rejects(
    requests.readContext({ nodeId: 42 } as unknown as ReadContextArgs),
    /nodeId must be a string/,
  );
});

test("find_connected_nodes returns direct incoming and outgoing Canvas nodes", async (t: TestContext) => {
  const { requests } = await setup(t);

  const result = await requests.findConnectedNodes();

  const nodes = result.structuredContent.nodes;
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].id, "text-context");
  assert.deepEqual(nodes[0].directions, ["incoming"]);
  assert.equal(nodes[1].id, "file-context");
  assert.deepEqual(nodes[1].directions, ["incoming"]);
  assert.equal(nodes[2].id, "answer");
  assert.deepEqual(nodes[2].directions, ["outgoing"]);
  assert.deepEqual(JSON.parse(result.content[0].text), nodes);
});

test("write_canvas_node maps an accepted host acknowledgement", async (t: TestContext) => {
  const { requests } = await setup(t);

  const result = await requests.writeCanvasNode({
    targetNodeId: "answer",
    content: "Next",
  });

  assert.equal(result.structuredContent.status, "accepted");
  assert.equal(result.structuredContent.targetNodeId, "host-resolved-answer");
  assert.equal(result.structuredContent.mode, "replace");
  assert.equal(
    result.content[0].text,
    "Canvas target host-resolved-answer updated with replace.",
  );
});

test("write_canvas_node maps a rejected host acknowledgement", async (t: TestContext) => {
  const { requests } = await setup(t, "rejected");

  const result = await requests.writeCanvasNode({
    targetNodeId: "answer",
    content: "Next",
  });

  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "Canvas target host-resolved-answer was rejected: The target is no longer available.",
  );
  assert.equal(result.structuredContent.status, "rejected");
});
