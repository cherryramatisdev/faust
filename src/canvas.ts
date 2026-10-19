// Canvas helpers. These use Obsidian's internal, undocumented Canvas API.

import { ItemView, Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import { createHarnessMarkdown } from "./harness-declaration.js";

/** Minimal shape of Obsidian's undocumented Canvas view. */
export interface CanvasView {
  getViewType(): string;
  canvas: Canvas;
  file: TFile;
}

/** Minimal shape of Obsidian's undocumented Canvas API surface used by Faust. */
export interface Canvas {
  getData(): unknown;
  createTextNode(opts: CanvasCreateTextNodeOptions): void;
  requestSave?(): void;
  posCenter(): { x: number; y: number };
}

export interface CanvasCreateTextNodeOptions {
  pos: { x: number; y: number };
  position: string;
  size: { width: number; height: number };
  text: string;
  focus: boolean;
  save: boolean;
}

/** A Canvas view backed by a file in the vault. */
function isCanvasView(view: unknown): view is CanvasView {
  if (view == null || typeof view !== "object") return false;
  const v = view as { getViewType?: () => string; canvas?: unknown; file?: unknown };
  return typeof v.getViewType === "function" && v.getViewType() === "canvas" && v.canvas != null && v.file instanceof TFile;
}

/** Canvas views open in the workspace, the active one first. */
function openCanvasViews(app: App): CanvasView[] {
  const active = app.workspace.getActiveViewOfType(ItemView);
  const views: (ItemView | null)[] = [active, ...app.workspace.getLeavesOfType("canvas").map((leaf) => leaf.view as ItemView)];
  const ordered: CanvasView[] = [];
  for (const view of views) {
    if (!view || !isCanvasView(view) || ordered.some((known) => known.file.path === view.file.path)) continue;
    ordered.push(view);
  }
  return ordered;
}

/** Vault paths of the open Canvas views, the active one first. */
function openCanvasPaths(app: App): string[] {
  return openCanvasViews(app).map((view) => view.file.path);
}

/**
 * Live document of an open Canvas view, as JSON. Includes cards that Obsidian has not
 * saved to disk yet, and it is the only source for a Canvas code block: those render with
 * an empty source path, so the block cannot tell which file it belongs to.
 */
function liveCanvasContent(app: App, canvasPath: string): string | null {
  const view: CanvasView | undefined = openCanvasViews(app).find((candidate) => candidate.file.path === canvasPath);
  const data: unknown = view && typeof view.canvas.getData === "function" ? view.canvas.getData() : null;
  return data ? JSON.stringify(data) : null;
}

/** The canvas in the active view, or null. */
function getActiveCanvas(app: App): Canvas | null {
  const view = app.workspace.getActiveViewOfType(ItemView);
  return view && isCanvasView(view) ? view.canvas : null;
}

/** Adds a declarative harness card. The generated ID stays in Canvas JSON. */
function addHarnessToCanvas(canvas: Canvas, provider: string = "pi"): void {
  if (!canCreateTextNodes(canvas)) {
    new Notice("This Obsidian version doesn't allow plugins to create cards. Create a text card with an agent-harness block instead.");
    return;
  }
  canvas.createTextNode({
    pos: canvasCenter(canvas),
    position: "center",
    size: { width: 640, height: 380 },
    text: createHarnessMarkdown(provider),
    focus: false,
    save: true,
  });
  if (typeof canvas.requestSave === "function") canvas.requestSave();
}

function canCreateTextNodes(canvas: Canvas): boolean {
  return typeof canvas.createTextNode === "function";
}

function canvasCenter(canvas: Canvas): { x: number; y: number } {
  return typeof canvas.posCenter === "function" ? canvas.posCenter() : { x: 0, y: 0 };
}

export { getActiveCanvas, openCanvasPaths, liveCanvasContent, addHarnessToCanvas };
