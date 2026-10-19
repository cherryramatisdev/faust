import fsp from "node:fs/promises";
import { TFile } from "obsidian";
import { createBridgeSession } from "./harness-transport.js";
import { findDuplicateHarnessIds, parseHarnessNode, parseHarnessSource } from "./harness-declaration.js";
import { createHarnessSession } from "./harness-session.js";
import { liveCanvasContent, openCanvasPaths } from "./canvas.js";
import { parseCanvasGraph } from "./canvas-graph.js";
import type { FaustPlugin } from "./constants.js";
import type { HarnessProvider, HarnessProviderRegistry } from "./harness-provider.js";
import type { CanvasGraph, CanvasNode } from "./canvas-graph.js";
import type { HarnessDeclaration } from "./harness-declaration.js";
import type { BridgeSession } from "./harness-transport.js";
import type { HarnessSession } from "./harness-session.js";

const SAVE_SYNC_DEBOUNCE_MS: number = 750;
const LIVE_MIRROR_INTERVAL_MS: number = 250;

class HarnessManager {
  plugin: FaustPlugin;
  providers: HarnessProviderRegistry;
  sessions: Map<string, HarnessSession>;
  syncTimers: Map<string, ReturnType<typeof setTimeout>>;
  liveMirrorTimers: Map<string, ReturnType<typeof setInterval>>;

  constructor(plugin: FaustPlugin, providers: HarnessProviderRegistry) {
    this.plugin = plugin;
    this.providers = providers;
    this.sessions = new Map();
    this.syncTimers = new Map();
    this.liveMirrorTimers = new Map();
  }

  key(canvasPath: string, nodeId: string): string {
    return `${canvasPath}:${nodeId}`;
  }

  async create(source: string, sourcePath: string | null): Promise<unknown | null> {
    const declaration: HarnessDeclaration = parseHarnessSource(source);
    if (!declaration.valid || !declaration.harness) {
      this.plugin.notify(`Invalid harness: ${declaration.errors.join(" ")}`);
      return null;
    }
    const provider: HarnessProvider | null = this.providers.get(declaration.harness.provider);
    if (!provider) {
      this.plugin.notify(`Unsupported harness provider "${declaration.harness.provider}".`);
      return null;
    }
    const candidates: string[] = canvasCandidates(sourcePath, openCanvasPaths(this.plugin.app));
    const located: { canvasPath: string; harnessNodeId: string; graph: CanvasGraph } | null = await this.locate(candidates, declaration.harness.id);
    if (!located) {
      this.plugin.notify(`Could not uniquely identify harness "${declaration.harness.id}" in ${candidates[0] || "an open Canvas"}.`);
      return null;
    }
    const { canvasPath, harnessNodeId, graph }: { canvasPath: string; harnessNodeId: string; graph: CanvasGraph } = located;
    const key: string = this.key(canvasPath, harnessNodeId);
    const existing: HarnessSession | undefined = this.sessions.get(key);
    if (existing && !existing.disposed) return existing.terminal;

    const bridge: BridgeSession = await createBridgeSession();
    bridge.harnessId = declaration.harness.id;
    bridge.canvasPath = canvasPath;
    bridge.harnessNodeId = harnessNodeId;
    let session: HarnessSession;
    try {
      session = await createHarnessSession({
        plugin: this.plugin,
        provider,
        bridge,
        graph,
        key,
        harnessId: declaration.harness.id,
        canvasPath,
        harnessNodeId,
      });
    } catch (error) {
      await fsp.rm(bridge.directory, { recursive: true, force: true }).catch(() => {});
      this.plugin.notify(`Could not start harness "${declaration.harness.id}": ${(error as Error).message}`);
      return null;
    }
    session.onDispose = () => this.remove(session);
    this.sessions.set(key, session);
    this.startLiveMirror(canvasPath);
    session.start();
    return session.terminal;
  }

  scheduleSync(file: unknown): void {
    if (!(file instanceof TFile) || file.extension !== "canvas") return;
    clearTimeout(this.syncTimers.get(file.path));
    this.syncTimers.set(file.path, setTimeout(() => {
      this.syncTimers.delete(file.path);
      void this.mirror(file.path, { notify: true });
    }, SAVE_SYNC_DEBOUNCE_MS));
  }

  /**
   * Obsidian's vault modify event only observes saved Canvas data. Poll the live Canvas document
   * while a harness is open so unsaved card and edge edits reach the MCP server as well.
   */
  startLiveMirror(canvasPath: string): void {
    if (this.liveMirrorTimers.has(canvasPath)) return;
    this.liveMirrorTimers.set(canvasPath, setInterval(() => {
      void this.mirror(canvasPath);
    }, LIVE_MIRROR_INTERVAL_MS));
  }

  /** Writes the current Canvas graph into every live harness session on that Canvas. */
  async mirror(canvasPath: string, { notify = false }: { notify?: boolean } = {}): Promise<void> {
    let graph: CanvasGraph | undefined;
    try {
      graph = (await this.canvasGraphs(canvasPath))[0];
      if (!graph || findDuplicateHarnessIds(graph.nodes).length) return;
    } catch {
      return;
    }
    for (const node of graph.nodes.filter((candidate: CanvasNode) => candidate.type === "text")) {
      const declaration: HarnessDeclaration = parseHarnessNode(node.text);
      if (!declaration.valid) continue;
      const session: HarnessSession | undefined = this.sessions.get(this.key(canvasPath, node.id));
      if (!session) continue;
      try {
        await session.syncState(graph);
      } catch (error) {
        if (notify) this.plugin.notify(`Could not refresh Canvas state for ${declaration.harness?.id}: ${(error as Error).message}`);
      }
    }
  }

  /** First candidate Canvas that holds exactly one node declaring the harness. */
  async locate(canvasPaths: string[], harnessId: string): Promise<{ canvasPath: string; harnessNodeId: string; graph: CanvasGraph } | null> {
    for (const canvasPath of canvasPaths) {
      for (const graph of await this.canvasGraphs(canvasPath)) {
        const matches: CanvasNode[] = graph.nodes.filter((node: CanvasNode) => node.type === "text" && parseHarnessNode(node.text).harness?.id === harnessId);
        if (matches.length === 1) return { canvasPath, harnessNodeId: matches[0].id, graph };
        if (matches.length > 1) return null;
      }
    }
    return null;
  }

  /**
   * A Canvas code block has no source path and a card Obsidian created moments ago may not be
   * in the saved file yet, so the live Canvas document is searched before the file on disk.
   */
  async canvasGraphs(canvasPath: string): Promise<CanvasGraph[]> {
    const contents: (string | null)[] = [liveCanvasContent(this.plugin.app, canvasPath)];
    const file = this.plugin.app.vault.getAbstractFileByPath(canvasPath);
    if (file instanceof TFile) contents.push(await this.plugin.app.vault.cachedRead(file));
    return contents.filter((c: string | null): c is string => c !== null && c !== "").map((content: string) => parseCanvasGraph(content));
  }

  remove(session: HarnessSession): void {
    if (this.sessions.get(session.key) !== session) return;
    this.sessions.delete(session.key);
    if (![...this.sessions.values()].some((candidate) => candidate.canvasPath === session.canvasPath)) {
      clearInterval(this.liveMirrorTimers.get(session.canvasPath));
      this.liveMirrorTimers.delete(session.canvasPath);
    }
  }

  dispose(): void {
    for (const timer of this.syncTimers.values()) clearTimeout(timer);
    this.syncTimers.clear();
    for (const timer of this.liveMirrorTimers.values()) clearInterval(timer);
    this.liveMirrorTimers.clear();
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}

/** Canvas files that may own a block: its own file first, then the open Canvas views. */
function canvasCandidates(sourcePath: string | null, openPaths: string[]): string[] {
  const paths: string[] = [];
  for (const candidate of [sourcePath, ...openPaths]) {
    if (typeof candidate === "string" && candidate.endsWith(".canvas") && !paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

export { HarnessManager };
