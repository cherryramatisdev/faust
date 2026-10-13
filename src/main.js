"use strict";

const { Plugin, Notice, FileSystemAdapter, TFile } = require("obsidian");
const path = require("path");
const { DEFAULT_SETTINGS } = require("./constants");
const shell = require("./shell");
const { BlockSessions, blockKey } = require("./block-sessions");
const { getActiveCanvas, addHarnessToCanvas } = require("./canvas");
const { FaustSettingTab } = require("./settings-tab");
const { HarnessManager } = require("./harness-manager");
const { ClaudeCodeHarnessProvider, CodexHarnessProvider, HarnessProviderRegistry, PiHarnessProvider } = require("./harness-provider");
const { GENERIC_HARNESS_LANGUAGE, HARNESS_LANGUAGE } = require("./harness-declaration");

class FaustPlugin extends Plugin {
  async onload() {
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

    this.registerEvent(this.app.workspace.on("canvas-menu", (menu, canvas) => {
      const targetCanvas = canvas || getActiveCanvas(this.app);
      if (!targetCanvas) return;
      menu.addItem((item) => item.setTitle("Add Faust harness").setIcon("bot").onClick(() => addHarnessToCanvas(targetCanvas, this.settings.defaultHarnessProvider)));
    }));

    this.harnessBlocks = new BlockSessions(this, {
      language: [HARNESS_LANGUAGE, GENERIC_HARNESS_LANGUAGE],
      keyFor: (source, sourcePath) => `${sourcePath}::${blockKey(source, sourcePath)}`,
      createSession: (_opts, ctx, source) => this.harnesses.create(source, ctx.sourcePath),
    });
    const renderCanvasHarness = (source, el, ctx) => {
      // Markdown code block processors can run before Canvas has attached the card's
      // rendered DOM, so `el.closest(".canvas-node-content")` can be false here even
      // for a Canvas card. Canvas renders have an empty source path; regular notes do not.
      if (ctx.sourcePath && !ctx.sourcePath.endsWith(".canvas")) return;
      return this.harnessBlocks.process(source, el, ctx);
    };
    this.registerMarkdownCodeBlockProcessor(HARNESS_LANGUAGE, renderCanvasHarness);
    this.registerMarkdownCodeBlockProcessor(GENERIC_HARNESS_LANGUAGE, renderCanvasHarness);

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

  onunload() {
    this.harnessBlocks.disposeAll();
    this.harnesses.dispose();
  }

  notify(message) { new Notice(message); }
  getShell() { return shell.getShell(this.settings); }
  resolveNodePath() { return shell.resolveNodePath(this.settings); }
  quoteArg(arg) { return shell.quoteArg(this.getShell().cmd, arg); }
  pluginDir() { return path.join(this.getVaultPath(), this.manifest.dir); }
  hostPath() { return path.join(this.pluginDir(), "faust-host.js"); }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  loadXterm() {
    if (!this.xterm) {
      const base = path.join(this.pluginDir(), "node_modules", "@xterm");
      const { Terminal } = window.require(path.join(base, "xterm", "lib", "xterm.js"));
      const { FitAddon } = window.require(path.join(base, "addon-fit", "lib", "addon-fit.js"));
      this.xterm = { Terminal, FitAddon };
    }
    return this.xterm;
  }

  async loadSettings() {
    const stored = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    this.settings.harnessProviders = Object.assign({}, DEFAULT_SETTINGS.harnessProviders, stored?.harnessProviders);
    for (const [provider, defaults] of Object.entries(DEFAULT_SETTINGS.harnessProviders)) {
      this.settings.harnessProviders[provider] = Object.assign({}, defaults, this.settings.harnessProviders[provider]);
    }
    if (stored?.piPath) this.settings.harnessProviders.pi.executable = stored.piPath;
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS.harnessProviders, this.settings.defaultHarnessProvider)) {
      this.settings.defaultHarnessProvider = DEFAULT_SETTINGS.defaultHarnessProvider;
    }
  }

  async saveSettings() { await this.saveData(this.settings); }
}

module.exports = FaustPlugin;
