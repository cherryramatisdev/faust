"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { writeCanvasOrVaultTarget } = require("../src/canvas-writer");

function fixture() {
  const files = new Map([
    ["result.md", "old file"],
  ]);
  const canvas = {
    path: "main.canvas",
    content: JSON.stringify({
      nodes: [
        { id: "pi", type: "text", text: "harness" },
        { id: "text-output", type: "text", text: "old draft" },
        { id: "file-output", type: "file", file: "result.md" },
      ],
      edges: [
        { id: "text-edge", fromNode: "pi", toNode: "text-output" },
        { id: "file-edge", fromNode: "pi", toNode: "file-output" },
      ],
    }),
  };
  const vault = {
    async cachedRead(file) { return file === canvas ? canvas.content : files.get(file.path); },
    getAbstractFileByPath(filePath) { return files.has(filePath) ? { path: filePath } : null; },
    async process(file, callback) {
      const current = file === canvas ? canvas.content : files.get(file.path);
      const updated = await callback(current);
      if (file === canvas) canvas.content = updated;
      else files.set(file.path, updated);
      return file;
    },
  };
  return { canvas, files, vault };
}

test("replaces and appends text Canvas targets", async () => {
  const { canvas, vault } = fixture();
  await writeCanvasOrVaultTarget({ vault, canvasFile: canvas, harnessNodeId: "pi", targetNodeId: "text-output", content: "new", mode: "replace" });
  await writeCanvasOrVaultTarget({ vault, canvasFile: canvas, harnessNodeId: "pi", targetNodeId: "text-output", content: "more", mode: "append" });
  const graph = JSON.parse(canvas.content);
  assert.equal(graph.nodes.find((node) => node.id === "text-output").text, "new\nmore");
});

test("replaces and appends referenced vault files", async () => {
  const { canvas, files, vault } = fixture();
  await writeCanvasOrVaultTarget({ vault, canvasFile: canvas, harnessNodeId: "pi", targetNodeId: "file-output", content: "new", mode: "replace" });
  await writeCanvasOrVaultTarget({ vault, canvasFile: canvas, harnessNodeId: "pi", targetNodeId: "file-output", content: "more", mode: "append" });
  assert.equal(files.get("result.md"), "new\nmore");
});

test("rejects a target that is not directly connected", async () => {
  const { canvas, vault } = fixture();
  await assert.rejects(
    writeCanvasOrVaultTarget({ vault, canvasFile: canvas, harnessNodeId: "pi", targetNodeId: "missing", content: "nope" }),
    /direct outgoing target/
  );
});
