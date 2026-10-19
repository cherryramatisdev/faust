import crypto from "node:crypto";

const HARNESS_LANGUAGE = "agent-harness";
const HARNESS_FENCE = new RegExp("^\\s*```" + HARNESS_LANGUAGE + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```\\s*$");

export interface HarnessSpec {
  id: string;
  provider: string;
}

export interface HarnessDeclaration {
  valid: boolean;
  harness: HarnessSpec | null;
  errors: string[];
}

export interface DuplicateHarnessId {
  harnessId: string;
  nodeIds: string[];
}

function newHarnessId(): string {
  const suffix = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  return `agent-${suffix}`;
}

function createHarnessMarkdown(provider: string = "pi", id: string = newHarnessId()): string {
  return [`\`\`\`${HARNESS_LANGUAGE}`, `id: ${id}`, `provider: ${provider}`, "```"].join("\n");
}

/** Parses a runtime-neutral harness declaration, never executable content. */
function parseHarnessNode(text: unknown): HarnessDeclaration {
  const match: RegExpMatchArray | null = typeof text === "string" ? text.match(HARNESS_FENCE) : null;
  if (!match) return invalid("The node must contain an agent-harness code block.");

  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const field: RegExpMatchArray | null = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
    if (!field) {
      errors.push(`Invalid harness field: ${line}`);
      continue;
    }
    const key: string = field[1].toLowerCase();
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

function parseHarnessSource(source: unknown): HarnessDeclaration {
  const text: string = typeof source === "string" ? source : "";
  return parseHarnessNode(["```" + HARNESS_LANGUAGE, text, "```"].join("\n"));
}

function invalid(error: string): HarnessDeclaration {
  return { valid: false, harness: null, errors: [error] };
}

function findDuplicateHarnessIds(nodes: { id: string; type: string; text?: string }[] | null | undefined): DuplicateHarnessId[] {
  const nodeIdsByHarnessId: Map<string, string[]> = new Map();
  for (const node of nodes || []) {
    if (!node || node.type !== "text") continue;
    const declaration: HarnessDeclaration = parseHarnessNode(node.text);
    if (!declaration.valid || !declaration.harness) continue;
    const nodeIds: string[] = nodeIdsByHarnessId.get(declaration.harness.id) || [];
    nodeIds.push(node.id);
    nodeIdsByHarnessId.set(declaration.harness.id, nodeIds);
  }

  return [...nodeIdsByHarnessId]
    .filter(([, nodeIds]) => nodeIds.length > 1)
    .map(([harnessId, nodeIds]) => ({ harnessId, nodeIds }));
}

export {
  HARNESS_LANGUAGE,
  createHarnessMarkdown,
  findDuplicateHarnessIds,
  newHarnessId,
  parseHarnessNode,
  parseHarnessSource,
};
