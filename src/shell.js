"use strict";

// Shell and Node.js detection, plus shell-specific command syntax.

const fs = require("fs");
const path = require("path");
const { SHELLS } = require("./constants");

/** The shell to launch ({ cmd, args }) for the given settings. */
function getShell(settings) {
  if (settings.shell === "custom" && settings.customShell.trim()) {
    const parts = settings.customShell.trim().match(/"[^"]*"|\S+/g).map((p) => p.replace(/^"|"$/g, ""));
    return { cmd: parts[0], args: parts.slice(1) };
  }
  const isWin = process.platform === "win32";
  const picked = SHELLS[settings.shell];
  if (picked && picked.win === isWin) return picked;
  if (isWin) return SHELLS.powershell;
  return { cmd: process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash"), args: ["-l"] };
}

/** Path to the system Node.js binary, or null if it can't be found. */
function resolveNodePath(settings) {
  if (settings.nodePath.trim()) return settings.nodePath.trim();
  const candidates = [];
  const dirs = (process.env.PATH || "").split(path.delimiter);
  const exe = process.platform === "win32" ? "node.exe" : "node";
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
function quoteArg(shellCmd, arg) {
  const shell = shellCmd.toLowerCase();
  if (shell.includes("cmd")) return '"' + String(arg).replace(/"/g, '""') + '"';
  // PowerShell, bash, zsh: single quotes (no variable expansion)
  if (shell.includes("powershell") || shell.includes("pwsh")) return "'" + String(arg).replace(/'/g, "''") + "'";
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

module.exports = { getShell, resolveNodePath, quoteArg };
