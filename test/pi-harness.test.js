"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPiHarnessMarkdown, findDuplicateHarnessIds, parseHarnessNode, parsePiHarnessNode } = require("../src/harness-declaration");

test("creates a stable, valid Pi harness declaration", () => {
  const text = createPiHarnessMarkdown("pi-main");

  assert.equal(text, "```pi-harness\nid: pi-main\nagent: pi\nbridge: faust\n```");
  assert.deepEqual(parsePiHarnessNode(text), {
    valid: true,
    harness: { id: "pi-main", agent: "pi", bridge: "faust" },
    errors: [],
  });
});

test("rejects malformed or unsupported harness declarations", () => {
  const cases = [
    ["not a code block", "The node must contain a pi-harness code block."],
    ["```pi-harness\nagent: pi\n```", "Harness ID is required."],
    ["```pi-harness\nid: pi-main\nagent: codex\n```", 'Unsupported agent "codex".'],
    ["```pi-harness\nid: pi-main\nagent: pi\nbridge: custom\n```", 'Unsupported bridge "custom".'],
  ];

  for (const [text, error] of cases) {
    const result = parsePiHarnessNode(text);
    assert.equal(result.valid, false, text);
    assert.ok(result.errors.includes(error), text);
  }
});

test("parses the runtime-neutral declaration format", () => {
  const result = parseHarnessNode("```agent-harness\nid: reviewer\nprovider: claude-code\n```");

  assert.equal(result.valid, true);
  assert.equal(result.harness.provider, "claude-code");
});

test("finds duplicate valid harness IDs without treating invalid nodes as harnesses", () => {
  const nodes = [
    { id: "one", type: "text", text: createPiHarnessMarkdown("pi-main") },
    { id: "two", type: "text", text: createPiHarnessMarkdown("pi-main") },
    { id: "bad", type: "text", text: "```pi-harness\nid:\nagent: pi\n```" },
  ];

  assert.deepEqual(findDuplicateHarnessIds(nodes), [{ harnessId: "pi-main", nodeIds: ["one", "two"] }]);
});
