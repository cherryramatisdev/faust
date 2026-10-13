"use strict";

const { CanvasGraphError, parseCanvasGraph, resolveOutgoingTarget } = require("./canvas-graph");

const mutationQueues = new Map();

function appendContent(existing, content) {
  if (!existing) return content;
  if (!content) return existing;
  return existing.endsWith("\n") ? `${existing}${content}` : `${existing}\n${content}`;
}

function applyMode(existing, content, mode) {
  if (mode === "replace") return content;
  if (mode === "append") return appendContent(existing, content);
  throw new CanvasGraphError(`Unsupported write mode "${mode}".`);
}

function enqueue(key, operation) {
  const previous = mutationQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const settled = current.catch(() => {}).finally(() => {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  });
  mutationQueues.set(key, settled);
  return current;
}

async function writeCanvasOrVaultTarget({ vault, canvasFile, harnessNodeId, targetNodeId, content, mode = "replace" }) {
  if (!vault || !canvasFile) throw new CanvasGraphError("Canvas writer requires a vault and Canvas file.");
  if (typeof content !== "string") throw new CanvasGraphError("Canvas write content must be a string.");

  return enqueue(canvasFile.path, async () => {
    const graph = parseCanvasGraph(await vault.cachedRead(canvasFile));
    const target = resolveOutgoingTarget(graph, harnessNodeId, targetNodeId);
    if (target.type === "text") {
      await vault.process(canvasFile, (current) => {
        const liveGraph = parseCanvasGraph(current);
        const liveTarget = resolveOutgoingTarget(liveGraph, harnessNodeId, targetNodeId);
        const node = liveGraph.nodes.find((candidate) => candidate.id === liveTarget.id);
        node.text = applyMode(node.text, content, mode);
        return `${JSON.stringify(liveGraph, null, 2)}\n`;
      });
      return { targetNodeId: target.id, targetType: target.type, mode };
    }

    const file = vault.getAbstractFileByPath(target.file);
    if (!file) throw new CanvasGraphError(`Referenced Canvas file "${target.file}" was not found in the vault.`);
    await vault.process(file, (current) => applyMode(current, content, mode));
    return { targetNodeId: target.id, targetType: target.type, file: target.file, mode };
  });
}

module.exports = { appendContent, applyMode, writeCanvasOrVaultTarget };
