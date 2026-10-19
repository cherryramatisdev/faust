// Shell and Node.js detection, plus shell-specific command syntax.

import fs from "node:fs";
import path from "node:path";
import { SHELLS } from "./constants.js";
import type { FaustSettings, ShellSpec } from "./constants.js";

/** The shell to launch ({ cmd, args }) for the given settings. */
function getShell(settings: FaustSettings): ShellSpec {
  if (settings.shell === "custom" && settings.customShell.trim()) {
    const parts: string[] = (settings.customShell.trim().match(/"[^"]*"|\S+/g) ?? []).map((p) => p.replace(/^"|"$/g, ""));
    return { cmd: parts[0], args: parts.slice(1) };
  }
  const isWin: boolean = process.platform === "win32";
  const picked: ShellSpec | undefined = SHELLS[settings.shell];
  if (picked && picked.win === isWin) return picked;
  if (isWin) return SHELLS.powershell;
  return { cmd: process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash"), args: ["-l"] };
}

/** Path to the system Node.js binary, or null if it can't be found. */
function resolveNodePath(settings: FaustSettings): string | null {
  if (settings.nodePath.trim()) return settings.nodePath.trim();
  const candidates: string[] = [];
  const dirs: string[] = (process.env.PATH || "").split(path.delimiter);
  const exe: string = process.platform === "win32" ? "node.exe" : "node";
  for (const d of dirs) if (d) candidates.push(path.join(d, exe));
  if (process.platform === "win32") {
    candidates.push(path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"));
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "nvm", "current", "node.exe"));
  } else {
    candidates.push("/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node");
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

/** Quotes an argument for the given shell executable. */
function quoteArg(shellCmd: string, arg: string): string {
  const shell: string = shellCmd.toLowerCase();
  if (shell.includes("cmd")) return '"' + String(arg).replace(/"/g, '""') + '"';
  // PowerShell, bash, zsh: single quotes (no variable expansion)
  if (shell.includes("powershell") || shell.includes("pwsh")) return "'" + String(arg).replace(/'/g, "''") + "'";
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

export { getShell, resolveNodePath, quoteArg };
