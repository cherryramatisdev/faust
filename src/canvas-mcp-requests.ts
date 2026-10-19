import { setTimeout as delay } from "node:timers/promises";
import {
  buildCanvasContextContent,
  buildConnections,
  resolveIncomingSourceNodes,
} from "./canvas-graph.js";
import type {
  CanvasConnection,
  CanvasContextContent,
  CanvasGraph,
  CanvasSourceNode,
  CanvasWriteMode,
} from "./canvas-graph.js";
import type { CanvasWriteAcknowledgement } from "./harness-transport.js";

export interface CanvasSnapshot {
  version: string | null;
  capturedAt: string | null;
  graph: CanvasGraph;
}

export interface ReadContextArgs {
  nodeId?: string;
}

export interface WriteCanvasNodeArgs {
  targetNodeId?: string;
  content?: string;
  mode?: CanvasWriteMode;
}

export interface CanvasWriteRequest {
  targetNodeId: string;
  content: string;
  mode: CanvasWriteMode;
}

export interface CanvasMcpRequestOptions {
  harnessNodeId: string;
  readCanvasState(): Promise<CanvasSnapshot | null>;
  readVaultFile(filePath: string): Promise<string>;
  submitCanvasWrite(
    request: CanvasWriteRequest,
  ): Promise<CanvasWriteAcknowledgement>;
}

interface TextResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

interface StructuredTextResult extends TextResult {
  structuredContent: Record<string, unknown>;
}

interface ToolErrorResult extends TextResult {
  isError: true;
}

const LIVE_CANVAS_MIRROR_INTERVAL_MS: number = 250;

function createCanvasMcpRequests(
  { harnessNodeId, readCanvasState, readVaultFile, submitCanvasWrite }:
    CanvasMcpRequestOptions,
) {
  return {
    async readContext(
      { nodeId }: ReadContextArgs = {},
    ): Promise<StructuredTextResult> {
      const snapshot: CanvasSnapshot | null = await readCanvasState();
      if (nodeId !== undefined && typeof nodeId !== "string") {
        throw new Error("nodeId must be a string when provided.");
      }
      if (!snapshot) {
        return structuredTextResult(
          "This harness has no Canvas state yet. Ask the user to reopen the Canvas.",
          { contextVersion: null, capturedAt: null, sources: [] },
        );
      }
      const sources: CanvasSourceNode[] = await resolveIncomingSourceNodes(
        snapshot.graph,
        harnessNodeId,
        readVaultFile,
        nodeId ? { nodeId } : {},
      );
      if (sources.length === 0) {
        const message: string = nodeId
          ? `Canvas node "${nodeId}" is not connected to this harness by an incoming edge.`
          : "No Canvas node is connected to this harness yet. Ask the user to connect the nodes that hold the context.";
        return structuredTextResult(message, {
          contextVersion: snapshot.version,
          capturedAt: snapshot.capturedAt,
          sources: [],
        });
      }
      const assembled: CanvasContextContent = buildCanvasContextContent(
        sources,
      );
      return structuredTextResult(assembled.content, {
        contextVersion: snapshot.version,
        capturedAt: snapshot.capturedAt,
        sources: assembled.sourceNodes,
      });
    },

    async findConnectedNodes(): Promise<
      TextResult & { structuredContent: { nodes: CanvasConnection[] } }
    > {
      // Obsidian mirrors unsaved Canvas edits every 250 ms. Wait one cycle plus 50 ms for the snapshot.
      await delay(LIVE_CANVAS_MIRROR_INTERVAL_MS + 50);
      const snapshot: CanvasSnapshot | null = await readCanvasState();
      const nodes: CanvasConnection[] = snapshot
        ? buildConnections(snapshot.graph, harnessNodeId)
        : [];
      return {
        ...textResult(JSON.stringify(nodes, null, 2)),
        structuredContent: { nodes },
      };
    },

    async writeCanvasNode(
      { targetNodeId, content, mode = "replace" }: WriteCanvasNodeArgs = {},
    ): Promise<TextResult & { structuredContent: CanvasWriteAcknowledgement }> {
      if (typeof targetNodeId !== "string" || !targetNodeId) {
        throw new Error("targetNodeId is required.");
      }
      if (typeof content !== "string") {
        throw new Error("content must be a string.");
      }
      if (mode !== "replace" && mode !== "append") {
        throw new Error('mode must be "replace" or "append".');
      }
      const acknowledgement: CanvasWriteAcknowledgement =
        await submitCanvasWrite({ targetNodeId, content, mode });
      const target: string = acknowledgement.targetNodeId || targetNodeId;
      if (acknowledgement.status !== "accepted") {
        return {
          ...toolError(
            `Canvas target ${target} was rejected: ${
              acknowledgement.error || "write failed"
            }`,
          ),
          structuredContent: acknowledgement,
        };
      }
      return {
        ...textResult(`Canvas target ${target} updated with ${mode}.`),
        structuredContent: acknowledgement,
      };
    },
  };
}

function textResult(text: string): TextResult {
  return { content: [{ type: "text", text }] };
}

function structuredTextResult(
  text: string,
  structuredContent: Record<string, unknown>,
): StructuredTextResult {
  return {
    ...textResult(text),
    structuredContent: { ...structuredContent, fullText: text },
  };
}

function toolError(text: string): ToolErrorResult {
  return { ...textResult(text), isError: true };
}

export { createCanvasMcpRequests, toolError };
