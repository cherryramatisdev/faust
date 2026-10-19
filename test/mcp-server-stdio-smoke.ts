import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createBridgeSession,
  PROTOCOL_VERSION,
} from "../src/harness-transport.js";
import type { BridgeSession } from "../src/harness-transport.js";

const harnessId: string = "stdio-harness";
const harnessNodeId: string = "agent-card";
const canvasPath: string = "workflow.canvas";

test("built MCP stdio server lists tools and reads connected Canvas context", async (t: TestContext) => {
  const root: string = await fs.mkdtemp(
    path.join(os.tmpdir(), "faust-mcp-stdio-test-"),
  );
  t.after(fs.rm.bind(fs, root, { recursive: true, force: true }));
  const vaultPath: string = path.join(root, "vault");
  const briefPath: string = path.join(vaultPath, "notes", "brief.md");
  await fs.mkdir(path.dirname(briefPath), { recursive: true });
  await fs.writeFile(
    briefPath,
    "# Brief\nUse the connected Canvas context.",
    "utf8",
  );

  const bridge: BridgeSession = await createBridgeSession({
    temporaryRoot: root,
  });
  bridge.harnessId = harnessId;
  await fs.writeFile(
    bridge.canvasStatePath,
    JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      harnessId,
      canvasPath,
      harnessNodeId,
      contextVersion: "stdio-snapshot-v1",
      capturedAt: "2026-10-18T12:00:00.000Z",
      graph: {
        nodes: [
          { id: "brief", type: "file", file: "notes/brief.md" },
          {
            id: harnessNodeId,
            type: "text",
            text: "```agent-harness\nid: stdio-harness\nprovider: pi\n```",
          },
        ],
        edges: [{ id: "brief-in", fromNode: "brief", toNode: harnessNodeId }],
      },
    }),
    "utf8",
  );

  const transport = new StdioClientTransport({
    command: "node",
    args: [path.resolve("mcp-server.js")],
    cwd: vaultPath,
    env: {
      PATH: process.env.PATH || "",
      FAUST_BRIDGE_DIR: bridge.directory,
      FAUST_HARNESS_ID: harnessId,
      FAUST_BRIDGE_TOKEN: bridge.bridgeToken,
      FAUST_PROTOCOL_VERSION: String(PROTOCOL_VERSION),
      FAUST_CANVAS_PATH: canvasPath,
      FAUST_HARNESS_NODE_ID: harnessNodeId,
      FAUST_CANVAS_STATE_PATH: bridge.canvasStatePath,
    },
  });
  const client: Client = new Client({
    name: "faust-stdio-smoke",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const toolNames: string[] = [];
    for (const tool of tools) toolNames.push(tool.name);
    assert.deepEqual(toolNames, [
      "read_context",
      "find_connected_nodes",
      "write_canvas_node",
    ]);

    const context = await client.callTool({
      name: "read_context",
      arguments: {},
    }) as CallToolResult;
    const contextText = context.content[0];
    assert.ok(contextText && contextText.type === "text");
    assert.match(contextText.text, /Use the connected Canvas context\./);
    assert.equal(
      context.structuredContent?.contextVersion,
      "stdio-snapshot-v1",
    );

    const sources = context.structuredContent?.sources as Array<{
      id: string;
      type: string;
      title: string;
      contentHash: string;
    }>;
    assert.equal(sources.length, 1);
    assert.equal(sources[0].id, "brief");
    assert.equal(sources[0].type, "file");
    assert.equal(sources[0].title, "Brief");
    assert.match(sources[0].contentHash, /^sha256:/);
  } finally {
    await client.close();
  }
});
