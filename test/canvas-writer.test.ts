import assert from "node:assert/strict";
import test from "node:test";
import { writeCanvasOrVaultTarget } from "../src/canvas-writer.js";
import type { Vault, TFile } from "obsidian";

interface MockCanvasFile {
  path: string;
  content: string;
}

function fixture(): { canvas: MockCanvasFile; files: Map<string, string>; vault: Vault } {
  const files: Map<string, string> = new Map([
    ["result.md", "old file"],
  ]);
  const canvas: MockCanvasFile = {
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
  // test stub — partial Vault mock
  const vault = {
    async cachedRead(file: unknown): Promise<string> {
      return file === canvas ? canvas.content : (files.get((file as { path: string }).path) ?? "");
    },
    getAbstractFileByPath(filePath: string): TFile | null {
      return files.has(filePath) ? ({ path: filePath } as unknown as TFile) : null;
    },
    async process(file: unknown, callback: (data: string) => string | Promise<string>): Promise<unknown> {
      const current: string = file === canvas ? canvas.content : (files.get((file as { path: string }).path) ?? "");
      const updated: string = await callback(current);
      if (file === canvas) canvas.content = updated;
      else files.set((file as { path: string }).path, updated);
      return file;
    },
  } as unknown as Vault;
  return { canvas, files, vault };
}

test("replaces and appends text Canvas targets", async () => {
  const { canvas, vault } = fixture();
  await writeCanvasOrVaultTarget({ vault, canvasFile: canvas as unknown as TFile, harnessNodeId: "pi", targetNodeId: "text-output", content: "new", mode: "replace" });
  await writeCanvasOrVaultTarget({ vault, canvasFile: canvas as unknown as TFile, harnessNodeId: "pi", targetNodeId: "text-output", content: "more", mode: "append" });
  const graph: { nodes: Array<{ id: string; text?: string }> } = JSON.parse(canvas.content);
  assert.equal(graph.nodes.find((node) => node.id === "text-output")?.text, "new\nmore");
});

test("replaces and appends referenced vault files", async () => {
  const { canvas, files, vault } = fixture();
  await writeCanvasOrVaultTarget({ vault, canvasFile: canvas as unknown as TFile, harnessNodeId: "pi", targetNodeId: "file-output", content: "new", mode: "replace" });
  await writeCanvasOrVaultTarget({ vault, canvasFile: canvas as unknown as TFile, harnessNodeId: "pi", targetNodeId: "file-output", content: "more", mode: "append" });
  assert.equal(files.get("result.md"), "new\nmore");
});

test("rejects a target that is not directly connected", async () => {
  const { canvas, vault } = fixture();
  await assert.rejects(
    writeCanvasOrVaultTarget({ vault, canvasFile: canvas as unknown as TFile, harnessNodeId: "pi", targetNodeId: "missing", content: "nope" }),
    /direct outgoing target/
  );
});
