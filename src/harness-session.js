"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { TFile } = require("obsidian");
const { validateCanvasWriteOperation, writeCanvasWriteAcknowledgement } = require("./harness-transport");
const { contextFingerprint, parseCanvasGraph } = require("./canvas-graph");
const { HarnessConsole } = require("./harness-console");
const { writeCanvasOrVaultTarget } = require("./canvas-writer");

class HarnessSession {
  constructor({ plugin, provider, bridge, terminal, key, harnessId, canvasPath, harnessNodeId }) {
    this.plugin = plugin;
    this.provider = provider;
    this.bridge = bridge;
    this.terminal = terminal;
    this.key = key;
    this.harnessId = harnessId;
    this.canvasPath = canvasPath;
    this.harnessNodeId = harnessNodeId;
    this.contextVersion = null;
    this.stateSync = Promise.resolve();
    this.writeProcessing = Promise.resolve();
    this.writeTimer = null;
    this.onDispose = null;
    this.disposed = false;
  }

  start() {
    this.writeTimer = setInterval(() => {
      this.writeProcessing = this.writeProcessing.then(() => this.processWrites()).catch(() => {});
    }, 100);
    this.writeProcessing = this.writeProcessing.then(() => this.processWrites()).catch(() => {});
    return this.terminal;
  }

  /**
   * Mirrors the live Canvas graph for the shared MCP tools. No node content is resolved, staged,
   * or pushed here: `read_context` reads the graph and the vault itself when the model asks.
   */
  syncState(graph) {
    this.stateSync = this.stateSync.catch(() => {}).then(async () => {
      if (this.disposed) return;
      const contextVersion = contextFingerprint(graph);
      if (this.contextVersion === contextVersion) return;
      await writeJsonAtomically(this.bridge.canvasStatePath, {
        protocolVersion: this.bridge.protocolVersion,
        harnessId: this.harnessId,
        canvasPath: this.canvasPath,
        harnessNodeId: this.harnessNodeId,
        contextVersion,
        capturedAt: new Date().toISOString(),
        graph: { nodes: graph.nodes, edges: graph.edges },
      });
      this.contextVersion = contextVersion;
    });
    return this.stateSync;
  }

  async processWrites() {
    if (this.disposed) return;
    let names;
    try {
      names = (await fsp.readdir(this.bridge.outboxDirectory)).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return;
    }
    for (const name of names) await this.processWrite(path.join(this.bridge.outboxDirectory, name), name);
  }

  async processWrite(operationPath, name) {
    let operation;
    try {
      operation = JSON.parse(await fsp.readFile(operationPath, "utf8"));
      validateCanvasWriteOperation(operation, { harnessId: this.harnessId, bridgeToken: this.bridge.bridgeToken });
      if (operation.canvasPath !== this.canvasPath) throw new Error("Canvas operation does not match the active harness session.");
      if (operation.harnessNodeId !== this.harnessNodeId) throw new Error("Canvas operation targets a different harness node.");
      const canvasFile = this.plugin.app.vault.getAbstractFileByPath(this.canvasPath);
      if (!(canvasFile instanceof TFile)) throw new Error(`Canvas file "${this.canvasPath}" was not found.`);
      const result = await writeCanvasOrVaultTarget({
        vault: this.plugin.app.vault,
        canvasFile,
        harnessNodeId: this.harnessNodeId,
        targetNodeId: operation.targetNodeId,
        content: operation.content,
        mode: operation.mode,
      });
      await this.writeAcknowledgement(operation, { status: "accepted", ...result });
      await this.move(operationPath, path.join(this.bridge.writeProcessedDirectory, name));
    } catch (error) {
      const operationId = operation?.operationId || path.basename(name, ".json");
      if (!operationId.startsWith("write-")) return;
      await this.writeAcknowledgement({ operationId }, { status: "rejected", error: error.message });
      await this.move(operationPath, path.join(this.bridge.writeErrorsDirectory, name));
    }
  }

  async writeAcknowledgement(operation, result) {
    await writeCanvasWriteAcknowledgement(this.bridge, {
      version: this.bridge.protocolVersion,
      operationId: operation.operationId,
      harnessId: this.harnessId,
      receivedAt: new Date().toISOString(),
      ...result,
    });
  }

  async move(from, to) {
    try { await fsp.rename(from, to); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.writeTimer) clearInterval(this.writeTimer);
    if (this.onDispose) this.onDispose(this);
    this.terminal.dispose();
    void fsp.rm(this.bridge.directory, { recursive: true, force: true });
  }
}

async function createHarnessSession({ plugin, provider, bridge, graph, key, harnessId, canvasPath, harnessNodeId }) {
  const file = plugin.app.vault.getAbstractFileByPath(canvasPath);
  if (!(file instanceof TFile)) throw new Error(`Canvas file "${canvasPath}" was not found in the vault.`);
  // The caller resolves the node from the live Canvas document, which runs ahead of the saved file.
  const canvasGraph = graph || parseCanvasGraph(await plugin.app.vault.cachedRead(file));
  const launch = provider.createLaunchSpec({ bridge, vaultPath: plugin.getVaultPath() });
  const terminal = new HarnessConsole(plugin, launch);
  const session = new HarnessSession({ plugin, provider, bridge, terminal, key, harnessId, canvasPath, harnessNodeId });
  await session.syncState(canvasGraph);
  terminal.onDispose = () => session.dispose();
  bridge.session = session;
  return session;
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporaryPath, filePath);
}

module.exports = { HarnessSession, createHarnessSession };
