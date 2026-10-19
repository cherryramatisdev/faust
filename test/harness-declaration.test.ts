import assert from "node:assert/strict";
import test from "node:test";
import { createHarnessMarkdown, findDuplicateHarnessIds, parseHarnessNode } from "../src/harness-declaration.js";
import type { HarnessDeclaration } from "../src/harness-declaration.js";

test("creates a runtime-neutral harness declaration", (): void => {
  const text: string = createHarnessMarkdown("claude-code", "agent-reviewer");

  assert.equal(text, "```agent-harness\nid: agent-reviewer\nprovider: claude-code\n```");
  assert.deepEqual(parseHarnessNode(text), {
    valid: true,
    harness: { id: "agent-reviewer", provider: "claude-code" },
    errors: [],
  });
});

test("rejects provider options the runtime does not support", (): void => {
  const result: HarnessDeclaration = parseHarnessNode("```agent-harness\nid: reviewer\nprovider: claude-code\nmodel: review-model\n```");

  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("Unsupported harness field: model"));
});

test("rejects malformed harness declarations", (): void => {
  const cases: [string, string][] = [
    ["not a code block", "The node must contain an agent-harness code block."],
    ["```agent-harness\nprovider: pi\n```", "Harness ID is required."],
    ["```agent-harness\nid: reviewer\n```", "Harness provider is required."],
  ];

  for (const [text, error] of cases) {
    const result = parseHarnessNode(text);
    assert.equal(result.valid, false, text);
    assert.ok(result.errors.includes(error), text);
  }
});

test("finds duplicate valid harness IDs without treating invalid nodes as harnesses", (): void => {
  const nodes: { id: string; type: string; text: string }[] = [
    { id: "one", type: "text", text: createHarnessMarkdown("pi", "agent-main") },
    { id: "two", type: "text", text: createHarnessMarkdown("codex", "agent-main") },
    { id: "bad", type: "text", text: "```agent-harness\nid:\nprovider: pi\n```" },
  ];

  assert.deepEqual(findDuplicateHarnessIds(nodes), [{ harnessId: "agent-main", nodeIds: ["one", "two"] }]);
});
