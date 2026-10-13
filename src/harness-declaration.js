"use strict";

const crypto = require("crypto");

const HARNESS_LANGUAGE = "agent-harness";
const HARNESS_FENCE = new RegExp("^\\s*```" + HARNESS_LANGUAGE + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```\\s*$");

function newHarnessId() {
  const suffix = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  return `agent-${suffix}`;
}

function createHarnessMarkdown(provider = "pi", id = newHarnessId()) {
  return [`\`\`\`${HARNESS_LANGUAGE}`, `id: ${id}`, `provider: ${provider}`, "```"].join("\n");
}

/** Parses a runtime-neutral harness declaration, never executable content. */
function parseHarnessNode(text) {
  const match = typeof text === "string" ? text.match(HARNESS_FENCE) : null;
  if (!match) return invalid("The node must contain an agent-harness code block.");

  const values = {};
  const errors = [];
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const field = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
    if (!field) {
      errors.push(`Invalid harness field: ${line}`);
      continue;
    }
    const key = field[1].toLowerCase();
    if (key !== "id" && key !== "provider") {
      errors.push(`Unsupported harness field: ${key}`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      errors.push(`Duplicate harness field: ${key}`);
      continue;
    }
    values[key] = field[2];
  }

  if (!values.id) errors.push("Harness ID is required.");
  if (!values.provider) errors.push("Harness provider is required.");
  if (errors.length) return { valid: false, harness: null, errors };
  return {
    valid: true,
    harness: { id: values.id, provider: values.provider },
    errors: [],
  };
}

function parseHarnessSource(source) {
  const text = typeof source === "string" ? source : "";
  return parseHarnessNode(["```" + HARNESS_LANGUAGE, text, "```"].join("\n"));
}

function invalid(error) {
  return { valid: false, harness: null, errors: [error] };
}

function findDuplicateHarnessIds(nodes) {
  const nodeIdsByHarnessId = new Map();
  for (const node of nodes || []) {
    if (!node || node.type !== "text") continue;
    const declaration = parseHarnessNode(node.text);
    if (!declaration.valid) continue;
    const nodeIds = nodeIdsByHarnessId.get(declaration.harness.id) || [];
    nodeIds.push(node.id);
    nodeIdsByHarnessId.set(declaration.harness.id, nodeIds);
  }

  return [...nodeIdsByHarnessId]
    .filter(([, nodeIds]) => nodeIds.length > 1)
    .map(([harnessId, nodeIds]) => ({ harnessId, nodeIds }));
}

module.exports = {
  HARNESS_LANGUAGE,
  createHarnessMarkdown,
  findDuplicateHarnessIds,
  newHarnessId,
  parseHarnessNode,
  parseHarnessSource,
};
