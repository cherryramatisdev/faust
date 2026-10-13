"use strict";

const crypto = require("crypto");

const HARNESS_LANGUAGE = "pi-harness";
const GENERIC_HARNESS_LANGUAGE = "agent-harness";
const SUPPORTED_AGENT = "pi";
const SUPPORTED_BRIDGE = "faust";
const LEGACY_BRIDGE = "open-terminal";
const HARNESS_FENCE = new RegExp("^\\s*```(?:" + HARNESS_LANGUAGE + "|" + GENERIC_HARNESS_LANGUAGE + ")[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```\\s*$");

function newPiHarnessId() {
  const suffix = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  return `pi-${suffix}`;
}

function createPiHarnessMarkdown(id = newPiHarnessId()) {
  return `\`\`\`${HARNESS_LANGUAGE}\nid: ${id}\nagent: ${SUPPORTED_AGENT}\nbridge: ${SUPPORTED_BRIDGE}\n\`\`\``;
}

function createHarnessMarkdown(provider = SUPPORTED_AGENT, id = newHarnessId()) {
  return `\`\`\`${GENERIC_HARNESS_LANGUAGE}\nid: ${id}\nprovider: ${provider}\n\`\`\``;
}

function newHarnessId() {
  const suffix = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  return `agent-${suffix}`;
}

/** Parses a runtime-neutral harness declaration, never executable content. */
function parseHarnessNode(text) {
  const match = typeof text === "string" ? text.match(HARNESS_FENCE) : null;
  if (!match) return invalid("The node must contain a pi-harness or agent-harness code block.");

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
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      errors.push(`Duplicate harness field: ${key}`);
      continue;
    }
    values[key] = field[2];
  }

  if (!values.id) errors.push("Harness ID is required.");
  const provider = values.provider || values.agent;
  if (!provider) errors.push("Harness provider is required.");
  if (values.bridge && values.bridge !== SUPPORTED_BRIDGE && values.bridge !== LEGACY_BRIDGE) errors.push(`Unsupported bridge "${values.bridge}".`);
  if (errors.length) return { valid: false, harness: null, errors };
  return {
    valid: true,
    harness: { id: values.id, agent: provider, provider, bridge: values.bridge || null, config: values },
    errors: [],
  };
}

/** Backward-compatible parser for the original Pi-only declaration. */
function parsePiHarnessNode(text) {
  const result = parseHarnessNode(text);
  if (!result.valid) {
    const errors = result.errors.map((error) => error === "Harness provider is required." ? "Harness agent is required." : error);
    if (errors.length === 1 && errors[0] === "The node must contain a pi-harness or agent-harness code block.") {
      return invalid("The node must contain a pi-harness code block.");
    }
    return { ...result, errors };
  }
  if (result.harness.agent !== SUPPORTED_AGENT) return invalid(`Unsupported agent "${result.harness.agent}".`);
  if (result.harness.bridge && result.harness.bridge !== SUPPORTED_BRIDGE && result.harness.bridge !== LEGACY_BRIDGE) return invalid(`Unsupported bridge "${result.harness.bridge}".`);
  return {
    valid: true,
    harness: { id: result.harness.id, agent: result.harness.agent, bridge: result.harness.bridge },
    errors: [],
  };
}

function parseHarnessSource(source) {
  const text = typeof source === "string" ? source : "";
  return parseHarnessNode(["```agent-harness", text, "```"].join("\n"));
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
  GENERIC_HARNESS_LANGUAGE,
  SUPPORTED_AGENT,
  SUPPORTED_BRIDGE,
  createHarnessMarkdown,
  createPiHarnessMarkdown,
  findDuplicateHarnessIds,
  newHarnessId,
  newPiHarnessId,
  parseHarnessNode,
  parseHarnessSource,
  parsePiHarnessNode,
};
