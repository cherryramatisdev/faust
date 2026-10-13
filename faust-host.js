"use strict";

// Helper process run with the system Node.js.
// Owns the pseudoterminal (node-pty) and talks to the plugin over stdio:
//   stdin  -> JSON lines: {t:"i",d:"text"} | {t:"r",c:cols,r:rows} | {t:"k"}
//   stdout -> raw terminal output (UTF-8)

const pty = require("node-pty");

const [cwd, shell, cols, rows, ...shellArgs] = process.argv.slice(2);

const term = pty.spawn(shell, shellArgs, {
  name: "xterm-256color",
  cols: parseInt(cols, 10) || 80,
  rows: parseInt(rows, 10) || 24,
  cwd,
  env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
});

term.onData((data) => process.stdout.write(data));
term.onExit(({ exitCode }) => process.exit(exitCode ?? 0));

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.t === "i") term.write(msg.d);
    else if (msg.t === "r") term.resize(Math.max(msg.c, 2), Math.max(msg.r, 1));
    else if (msg.t === "k") shutdown();
  }
});
process.stdin.on("end", shutdown);

function shutdown() {
  try {
    term.kill();
  } catch {}
  setTimeout(() => process.exit(0), 300);
}
