"use strict";

const { PluginSettingTab, Setting } = require("obsidian");

class FaustSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName("Shell")
      .setDesc("Shell used to launch Canvas agent sessions.")
      .addDropdown((dd) => {
        dd.addOption("auto", "Automatic (recommended)");
        if (process.platform === "win32") {
          dd.addOption("powershell", "Windows PowerShell");
          dd.addOption("pwsh", "PowerShell 7 (pwsh)");
          dd.addOption("cmd", "Command Prompt (cmd)");
        } else {
          dd.addOption("zsh", "Zsh");
          dd.addOption("bash", "Bash");
        }
        dd.addOption("custom", "Custom");
        dd.setValue(s.shell).onChange(async (v) => {
          s.shell = v;
          await save();
          this.display();
        });
      });

    if (s.shell === "custom") {
      new Setting(containerEl)
        .setName("Custom shell")
        .setDesc('Executable and arguments. E.g.: "C:\\Program Files\\Git\\bin\\bash.exe" --login')
        .addText((t) =>
          t.setValue(s.customShell).onChange(async (v) => {
            s.customShell = v;
            await save();
          })
        );
    }

    new Setting(containerEl)
      .setName("Default harness provider")
      .setDesc("Provider used when adding a new Canvas harness. Existing agent-harness blocks select their provider in the block.")
      .addDropdown((dd) => dd
        .addOption("pi", "Pi")
        .addOption("codex", "Codex")
        .addOption("claude-code", "Claude Code")
        .setValue(s.defaultHarnessProvider)
        .onChange(async (value) => {
          s.defaultHarnessProvider = value;
          await save();
        })
      );

    for (const [provider, label, placeholder] of [
      ["pi", "Pi executable", "pi"],
      ["codex", "Codex executable", "codex"],
      ["claude-code", "Claude Code executable", "claude"],
    ]) {
      new Setting(containerEl)
        .setName(label)
        .setDesc(`Leave empty to use "${placeholder}" from PATH.`)
        .addText((t) => t
          .setPlaceholder(placeholder)
          .setValue(s.harnessProviders[provider].executable)
          .onChange(async (value) => {
            s.harnessProviders[provider].executable = value;
            await save();
          })
        );
    }

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Applies to agent consoles opened after the change.")
      .addSlider((sl) =>
        sl
          .setLimits(9, 24, 1)
          .setValue(s.fontSize)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.fontSize = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Node.js path")
      .setDesc(`Leave empty to auto-detect. Detected: ${this.plugin.resolveNodePath() || "none"}`)
      .addText((t) =>
        t
          .setPlaceholder("C:\\Program Files\\nodejs\\node.exe")
          .setValue(s.nodePath)
          .onChange(async (v) => {
            s.nodePath = v;
            await save();
          })
      );
  }
}

module.exports = { FaustSettingTab };
