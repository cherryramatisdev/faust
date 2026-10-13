"use strict";

const DEFAULT_SETTINGS = {
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

const SHELLS = {
  powershell: { cmd: "powershell.exe", args: ["-NoLogo"], win: true },
  pwsh: { cmd: "pwsh.exe", args: ["-NoLogo"], win: true },
  cmd: { cmd: "cmd.exe", args: [], win: true },
  zsh: { cmd: "/bin/zsh", args: ["-l"], win: false },
  bash: { cmd: "/bin/bash", args: ["-l"], win: false },
};

module.exports = { DEFAULT_SETTINGS, SHELLS };
