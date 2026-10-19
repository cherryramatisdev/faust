import type { Plugin, App } from "obsidian";

export interface HarnessProviderSettings {
  executable: string;
}

export interface FaustSettings {
  shell: string;
  customShell: string;
  nodePath: string;
  harnessProviders: {
    pi: HarnessProviderSettings;
    codex: HarnessProviderSettings;
    "claude-code": HarnessProviderSettings;
  };
  defaultHarnessProvider: string;
  fontSize: number;
}

export interface ShellSpec {
  cmd: string;
  args: string[];
  win?: boolean;
}

export interface FaustPlugin extends Plugin {
  app: App;
  settings: FaustSettings;
  notify(message: string): void;
  getVaultPath(): string | null;
  resolveNodePath(): string | null;
  getShell(): ShellSpec;
  quoteArg(arg: string): string;
  pluginDir(): string;
  hostPath(): string;
  loadXterm(): { Terminal: unknown; FitAddon: unknown } | null;
  saveSettings(): Promise<void>;
}

const DEFAULT_SETTINGS: FaustSettings = {
  shell: "auto",
  customShell: "",
  nodePath: "",
  harnessProviders: {
    pi: { executable: "" },
    codex: { executable: "" },
    "claude-code": { executable: "" },
  },
  defaultHarnessProvider: "pi",
  fontSize: 14,
};

const SHELLS: Record<string, ShellSpec> = {
  powershell: { cmd: "powershell.exe", args: ["-NoLogo"], win: true },
  pwsh: { cmd: "pwsh.exe", args: ["-NoLogo"], win: true },
  cmd: { cmd: "cmd.exe", args: [], win: true },
  zsh: { cmd: "/bin/zsh", args: ["-l"], win: false },
  bash: { cmd: "/bin/bash", args: ["-l"], win: false },
};

export { DEFAULT_SETTINGS, SHELLS };
