"use strict";

// Canvas helpers. These use Obsidian's internal, undocumented Canvas API.

const { ItemView, Notice, TFile } = require("obsidian");
const { createHarnessMarkdown } = require("./harness-declaration");

/** A Canvas view backed by a file in the vault. */
function isCanvasView(view) {
  return Boolean(view && view.getViewType() === "canvas" && view.canvas && view.file instanceof TFile);
}

/** Canvas views open in the workspace, the active one first. */
function openCanvasViews(app) {
  const active = app.workspace.getActiveViewOfType(ItemView);
  const views = [active, ...app.workspace.getLeavesOfType("canvas").map((leaf) => leaf.view)];
  const ordered = [];
  for (const view of views) {
    if (!isCanvasView(view) || ordered.some((known) => known.file.path === view.file.path)) continue;
    ordered.push(view);
  }
  return ordered;
}

/** Vault paths of the open Canvas views, the active one first. */
function openCanvasPaths(app) {
  return openCanvasViews(app).map((view) => view.file.path);
}

/**
 * Live document of an open Canvas view, as JSON. Includes cards that Obsidian has not
 * saved to disk yet, and it is the only source for a Canvas code block: those render with
 * an empty source path, so the block cannot tell which file it belongs to.
 */
function liveCanvasContent(app, canvasPath) {
  const view = openCanvasViews(app).find((candidate) => candidate.file.path === canvasPath);
  const data = view && typeof view.canvas.getData === "function" ? view.canvas.getData() : null;
  return data ? JSON.stringify(data) : null;
}

/** The canvas in the active view, or null. */
function getActiveCanvas(app) {
  const view = app.workspace.getActiveViewOfType(ItemView);
  return isCanvasView(view) ? view.canvas : null;
}

/** Adds a declarative harness card. The generated ID stays in Canvas JSON. */
function addHarnessToCanvas(canvas, provider = "pi") {
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

function canCreateTextNodes(canvas) {
  return typeof canvas.createTextNode === "function";
}

function canvasCenter(canvas) {
  return typeof canvas.posCenter === "function" ? canvas.posCenter() : { x: 0, y: 0 };
}

module.exports = { getActiveCanvas, openCanvasPaths, liveCanvasContent, addHarnessToCanvas };
