import { CanvasGraphError, parseCanvasGraph, resolveOutgoingTarget } from "./canvas-graph.js";
import type { CanvasGraph, CanvasNode, CanvasTargetNode, CanvasWriteMode } from "./canvas-graph.js";
import type { TFile, Vault } from "obsidian";

const mutationQueues: Map<string, Promise<unknown>> = new Map();

function appendContent(existing: string, content: string): string {
  if (!existing) return content;
  if (!content) return existing;
  return existing.endsWith("\n") ? `${existing}${content}` : `${existing}\n${content}`;
}

function applyMode(existing: string, content: string, mode: CanvasWriteMode): string {
  if (mode === "replace") return content;
  if (mode === "append") return appendContent(existing, content);
  throw new CanvasGraphError(`Unsupported write mode "${mode}".`);
}

function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous: Promise<unknown> = mutationQueues.get(key) || Promise.resolve();
  const current: Promise<T> = (async () => {
    try {
      await previous;
    } catch {
      // Swallow the previous operation's rejection so later queued work still runs.
    }
    return operation();
  })();
  const settled: Promise<unknown> = current.catch(() => undefined).finally(() => {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  });
  mutationQueues.set(key, settled);
  return current;
}

interface WriteCanvasOrVaultTargetOptions {
  vault: Vault;
  canvasFile: TFile;
  harnessNodeId: string;
  targetNodeId: string;
  content: string;
  mode?: CanvasWriteMode;
}

interface WriteTargetResult {
  targetNodeId: string;
  targetType: string;
  mode: CanvasWriteMode;
  file?: string;
}

async function writeCanvasOrVaultTarget({ vault, canvasFile, harnessNodeId, targetNodeId, content, mode = "replace" }: WriteCanvasOrVaultTargetOptions): Promise<WriteTargetResult> {
  if (!vault || !canvasFile) throw new CanvasGraphError("Canvas writer requires a vault and Canvas file.");
  if (typeof content !== "string") throw new CanvasGraphError("Canvas write content must be a string.");

  return enqueue(canvasFile.path, async () => {
    const graph: CanvasGraph = parseCanvasGraph(await vault.cachedRead(canvasFile));
    const target: CanvasTargetNode = resolveOutgoingTarget(graph, harnessNodeId, targetNodeId);
    if (target.type === "text") {
      await vault.process(canvasFile, (current: string): string => {
        const liveGraph = parseCanvasGraph(current);
        const liveTarget = resolveOutgoingTarget(liveGraph, harnessNodeId, targetNodeId);
        const node: CanvasNode | undefined = liveGraph.nodes.find((candidate) => candidate.id === liveTarget.id);
        if (!node) throw new CanvasGraphError(`Canvas node "${liveTarget.id}" was not found in the live graph.`);
        node.text = applyMode(node.text ?? "", content, mode);
        return `${JSON.stringify(liveGraph, null, 2)}\n`;
      });
      return { targetNodeId: target.id, targetType: target.type, mode };
    }

    const file = vault.getAbstractFileByPath(target.file!);
    if (!file) throw new CanvasGraphError(`Referenced Canvas file "${target.file}" was not found in the vault.`);
    await vault.process(file as TFile, (current: string) => applyMode(current, content, mode));
    return { targetNodeId: target.id, targetType: target.type, file: target.file!, mode };
  });
}

export { appendContent, applyMode, writeCanvasOrVaultTarget };
