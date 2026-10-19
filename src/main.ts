import { Plugin, Notice, FileSystemAdapter, TFile } from "obsidian";
import type { MarkdownPostProcessorContext, EventRef } from "obsidian";
import path from "node:path";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { DEFAULT_SETTINGS } from "./constants.js";
import type { FaustSettings, ShellSpec } from "./constants.js";
import * as shell from "./shell.js";
import { BlockSessions, blockKey } from "./block-sessions.js";
import type { HarnessBlockSession } from "./block-sessions.js";
import { getActiveCanvas, addHarnessToCanvas } from "./canvas.js";
import { FaustSettingTab } from "./settings-tab.js";
import { HarnessManager } from "./harness-manager.js";
import { ClaudeCodeHarnessProvider, CodexHarnessProvider, HarnessProviderRegistry, PiHarnessProvider } from "./harness-provider.js";
import { HARNESS_LANGUAGE } from "./harness-declaration.js";

// xterm is loaded via Electron's preload `window.require` at runtime, not a normal ESM import.
// `any` is justified: the Electron preload scope provides `require` on `window`, which TS cannot see.
declare global {
  interface Window { require(id: string): any; }
}

interface XtermBundle { Terminal: typeof Terminal; FitAddon: typeof FitAddon; }

class FaustPlugin extends Plugin {
  declare settings: FaustSettings;
  harnesses!: HarnessManager;
  harnessBlocks!: BlockSessions;
  xterm?: XtermBundle | null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.harnesses = new HarnessManager(this, new HarnessProviderRegistry([
      new PiHarnessProvider(this),
      new CodexHarnessProvider(this),
      new ClaudeCodeHarnessProvider(this),
    ]));
    this.registerEvent(this.app.vault.on("modify", (file) => this.harnesses.scheduleSync(file)));

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "canvas") return;
      menu.addItem((item) => item.setTitle("Add Faust harness").setIcon("bot").onClick(async () => {
        await this.app.workspace.getLeaf(false).openFile(file);
        const canvas = getActiveCanvas(this.app);
        if (canvas) addHarnessToCanvas(canvas, this.settings.defaultHarnessProvider);
      }));
    }));

    // "canvas-menu" is an undocumented Obsidian workspace event; its menu/canvas params are untyped.
    const workspace = this.app.workspace as unknown as { on(event: string, callback: (...args: any[]) => void): EventRef };
    this.registerEvent(workspace.on("canvas-menu", (menu: any, canvas: any) => {
      const targetCanvas = canvas || getActiveCanvas(this.app);
      if (!targetCanvas) return;
      menu.addItem((item: any) => item.setTitle("Add Faust harness").setIcon("bot").onClick(() => addHarnessToCanvas(targetCanvas, this.settings.defaultHarnessProvider)));
    }));

    this.harnessBlocks = new BlockSessions(this, {
      language: HARNESS_LANGUAGE,
      keyFor: (source, sourcePath) => `${sourcePath}::${blockKey(source, sourcePath)}`,
      createSession: async (_opts, ctx, source) => (await this.harnesses.create(source, (ctx as { sourcePath: string }).sourcePath)) as HarnessBlockSession | null,
    });
    const renderCanvasHarness = (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
      // Markdown code block processors can run before Canvas has attached the card's
      // rendered DOM, so `el.closest(".canvas-node-content")` can be false here even
      // for a Canvas card. Canvas renders have an empty source path; regular notes do not.
      if (ctx.sourcePath && !ctx.sourcePath.endsWith(".canvas")) return;
      return this.harnessBlocks.process(source, el, ctx);
    };
    this.registerMarkdownCodeBlockProcessor(HARNESS_LANGUAGE, renderCanvasHarness);

    this.addCommand({
      id: "add-faust-harness-to-canvas",
      name: "Add Faust harness to Canvas",
      checkCallback: (checking) => {
        const canvas = getActiveCanvas(this.app);
        if (!canvas) return false;
        if (!checking) addHarnessToCanvas(canvas, this.settings.defaultHarnessProvider);
        return true;
      },
    });

    this.addSettingTab(new FaustSettingTab(this.app, this));
  }

  onunload(): void {
    this.harnessBlocks.disposeAll();
    this.harnesses.dispose();
  }

  notify(message: string): void { new Notice(message); }
  getShell(): ShellSpec { return shell.getShell(this.settings); }
  resolveNodePath(): string | null { return shell.resolveNodePath(this.settings); }
  quoteArg(arg: string): string { return shell.quoteArg(this.getShell().cmd, arg); }
  pluginDir(): string { return path.join(this.getVaultPath() ?? "", this.manifest.dir ?? ""); }
  hostPath(): string { return path.join(this.pluginDir(), "faust-host.js"); }

  getVaultPath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  loadXterm(): XtermBundle {
    if (!this.xterm) {
      const base = path.join(this.pluginDir(), "node_modules", "@xterm");
      const { Terminal } = window.require(path.join(base, "xterm", "lib", "xterm.js"));
      const { FitAddon } = window.require(path.join(base, "addon-fit", "lib", "addon-fit.js"));
      this.xterm = { Terminal, FitAddon };
    }
    return this.xterm!;
  }

  async loadSettings(): Promise<void> {
    // loadData is untyped; cast to the settings shape.
    const stored = (await this.loadData()) as (Partial<FaustSettings> & { piPath?: string }) | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored) as FaustSettings;
    this.settings.harnessProviders = Object.assign({}, DEFAULT_SETTINGS.harnessProviders, stored?.harnessProviders) as FaustSettings["harnessProviders"];
    for (const [provider, defaults] of Object.entries(DEFAULT_SETTINGS.harnessProviders)) {
      this.settings.harnessProviders[provider as keyof FaustSettings["harnessProviders"]] = Object.assign({}, defaults, this.settings.harnessProviders[provider as keyof FaustSettings["harnessProviders"]]);
    }
    if (stored?.piPath) this.settings.harnessProviders.pi.executable = stored.piPath;
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS.harnessProviders, this.settings.defaultHarnessProvider)) {
      this.settings.defaultHarnessProvider = DEFAULT_SETTINGS.defaultHarnessProvider;
    }
  }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}

export default FaustPlugin;
