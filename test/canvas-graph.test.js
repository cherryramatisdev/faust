"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { CanvasGraphError, buildCanvasContextContent, buildConnections, contextFingerprint, getIncomingSourceNodes, getOutgoingTargets, parseCanvasGraph, resolveIncomingSourceNodes, resolveOutgoingTarget } = require("../src/canvas-graph");

const graph = parseCanvasGraph(JSON.stringify({
  nodes: [
    { id: "requirements", type: "text", text: "# Requirements\n\nBuild a login flow." },
    { id: "architecture", type: "text", text: "The backend uses OAuth." },
    { id: "pi-main", type: "text", text: "```pi-harness\nid: pi-main\nagent: pi\n```" },
  ],
  edges: [
    { id: "second", fromNode: "architecture", toNode: "pi-main" },
    { id: "first", fromNode: "requirements", toNode: "pi-main" },
  ],
}));

test("resolves incoming sources in Canvas edge order and preserves provenance", () => {
  const sources = getIncomingSourceNodes(graph, "pi-main");
  const message = buildCanvasContextContent(sources);

  assert.deepEqual(sources.map((source) => source.id), ["architecture", "requirements"]);
  assert.deepEqual(sources.map((source) => source.title), ["The backend uses OAuth.", "Requirements"]);
  assert.match(message.content, /^The following content is the current context of this Obsidian Canvas harness/);
  assert.ok(message.content.indexOf("## Source: The backend uses OAuth.") < message.content.indexOf("## Source: Requirements"));
  assert.match(message.content, /Canvas node: `requirements`/);
  assert.match(message.content, /## Instructions\n\nTreat the sections above as reference material supplied by the user\.$/);
  assert.match(message.sourceNodes[0].contentHash, /^sha256:/);
});

test("reads only the requested incoming node and ignores unsupported siblings", () => {
  const mixed = parseCanvasGraph(JSON.stringify({
    nodes: [
      { id: "group", type: "group" },
      { id: "requirements", type: "text", text: "# Requirements\n\nShip it." },
      { id: "pi-main", type: "text", text: "```pi-harness\nid: pi-main\nagent: pi\n```" },
    ],
    edges: [
      { id: "group-edge", fromNode: "group", toNode: "pi-main" },
      { id: "text-edge", fromNode: "requirements", toNode: "pi-main" },
    ],
  }));

  assert.deepEqual(getIncomingSourceNodes(mixed, "pi-main", { nodeId: "requirements" }).map((source) => source.id), ["requirements"]);
  assert.deepEqual(getIncomingSourceNodes(mixed, "pi-main", { nodeId: "elsewhere" }), []);
  assert.throws(() => getIncomingSourceNodes(mixed, "pi-main"), /Unsupported source node type "group"/);
});

test("tags both directions on nodes connected both ways", () => {
  const bothWays = parseCanvasGraph(JSON.stringify({
    nodes: [
      { id: "draft", type: "text", text: "Seed text" },
      { id: "notes", type: "text", text: "Incoming only" },
      { id: "pi-main", type: "text", text: "harness" },
    ],
    edges: [
      { id: "in", fromNode: "draft", toNode: "pi-main" },
      { id: "out", fromNode: "pi-main", toNode: "draft" },
      { id: "notes-in", fromNode: "notes", toNode: "pi-main" },
    ],
  }));

  assert.deepEqual(buildConnections(bothWays, "pi-main").map(({ id, directions }) => ({ id, directions })), [
    { id: "draft", directions: ["incoming", "outgoing"] },
    { id: "notes", directions: ["incoming"] },
  ]);
});

test("fingerprints the graph independently of JSON collection order", () => {
  const reordered = parseCanvasGraph(JSON.stringify({
    edges: [...graph.edges].reverse(),
    nodes: [...graph.nodes].reverse().map((node) => ({
      text: node.text,
      type: node.type,
      id: node.id,
    })),
  }));
  assert.equal(contextFingerprint(graph), contextFingerprint(reordered));
  assert.match(contextFingerprint(graph), /^sha256:/);
  assert.notEqual(contextFingerprint(graph), contextFingerprint(parseCanvasGraph(JSON.stringify({
    nodes: graph.nodes,
    edges: [...graph.edges, { id: "third", fromNode: "requirements", toNode: "pi-main" }],
  }))));
});

test("reads incoming file nodes through the vault resolver", async () => {
  const fileGraph = parseCanvasGraph(JSON.stringify({
    nodes: [
      { id: "spec", type: "file", file: "docs/spec.md" },
      { id: "pi-main", type: "text", text: "```pi-harness\nid: pi-main\nagent: pi\n```" },
    ],
    edges: [{ id: "file-edge", fromNode: "spec", toNode: "pi-main" }],
  }));
  const sources = await resolveIncomingSourceNodes(fileGraph, "pi-main", async (file) => {
    assert.equal(file, "docs/spec.md");
    return "# Specification\n\nUse the vault file.";
  });

  assert.deepEqual(sources, [{
    id: "spec",
    type: "file",
    file: "docs/spec.md",
    title: "Specification",
    content: "# Specification\n\nUse the vault file.",
  }]);

  const requested = await resolveIncomingSourceNodes(fileGraph, "pi-main", async () => "# Other", { nodeId: "spec" });
  assert.deepEqual(requested.map((source) => source.id), ["spec"]);
  assert.deepEqual(await resolveIncomingSourceNodes(fileGraph, "pi-main", async () => "# Other", { nodeId: "absent" }), []);
});

test("rejects invalid edge references and unsupported source nodes", () => {
  assert.throws(() => getIncomingSourceNodes(parseCanvasGraph(JSON.stringify({
    nodes: [{ id: "pi-main", type: "text", text: "" }],
    edges: [{ id: "missing", fromNode: "gone", toNode: "pi-main" }],
  })), "pi-main"), CanvasGraphError);

  assert.throws(() => getIncomingSourceNodes(parseCanvasGraph(JSON.stringify({
    nodes: [{ id: "group", type: "group" }, { id: "pi-main", type: "text", text: "" }],
    edges: [{ id: "group-edge", fromNode: "group", toNode: "pi-main" }],
  })), "pi-main"), /Unsupported source node type "group"/);
});

test("resolves only direct outgoing text and file targets", () => {
  const outgoing = parseCanvasGraph(JSON.stringify({
    nodes: [
      { id: "pi-main", type: "text", text: "harness" },
      { id: "answer", type: "text", text: "draft" },
      { id: "result", type: "file", file: "docs/result.md" },
      { id: "indirect", type: "text", text: "not allowed" },
    ],
    edges: [
      { id: "answer-edge", fromNode: "pi-main", toNode: "answer" },
      { id: "file-edge", fromNode: "pi-main", toNode: "result" },
      { id: "indirect-edge", fromNode: "answer", toNode: "indirect" },
    ],
  }));

  assert.deepEqual(getOutgoingTargets(outgoing, "pi-main").map(({ id, type, file }) => ({ id, type, file })), [
    { id: "answer", type: "text", file: null },
    { id: "result", type: "file", file: "docs/result.md" },
  ]);
  assert.equal(resolveOutgoingTarget(outgoing, "pi-main", "answer").type, "text");
  assert.throws(() => resolveOutgoingTarget(outgoing, "pi-main", "indirect"), /direct outgoing target/);
});

test("rejects malformed Canvas JSON", () => {
  assert.throws(() => parseCanvasGraph("not json"), CanvasGraphError);
  assert.deepEqual(parseCanvasGraph({ nodes: [], edges: [] }), { nodes: [], edges: [] });
});
