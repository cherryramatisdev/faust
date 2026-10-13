# Faust

Faust is a standalone Obsidian plugin for running Pi, Codex, and Claude Code harnesses inside Canvas. Incoming connections provide agent context; outgoing connections are explicit write targets.

The name refers to Goethe's scholar who makes a pact with Mephistopheles in pursuit of knowledge. The implementation was copied and adapted from [Open Terminal](https://github.com/m4rri4nne/open-terminal-obsidian). Faust runs as an independent plugin with its own code, settings, dependencies, and runtime.

## Features

- Add a harness card from the Canvas context menu or command palette.
- Choose Pi, Codex, or Claude Code for each card.
- Read connected incoming text and file nodes through Canvas MCP tools.
- Write only to explicitly connected outgoing text or file nodes, with live target validation and acknowledgements.
- Keep each agent session attached to its Canvas card.

Faust handles `agent-harness` and legacy `pi-harness` blocks only when they are rendered inside Canvas cards. Open Terminal continues to handle `terminal` blocks and general terminal access.

## Known limitations

1. We currently only support 1:1 node connection, meaning that if your node already has other connections and you connect it to a harness, we don't pass all them as context.
2. We currently only support node to node connection (being harness node, text node or file node), we don't support groups of nodes.
3. We currently only support file and text nodes as incoming or outgoing connections, we don't support images, web pages, pdfs, etc..

## Install

1. Install dependencies in this folder with `npm install` (this builds `node-pty` for the current platform).
2. Place the folder at `<vault>/.obsidian/plugins/faust/`.
3. Enable **Faust** in Obsidian's Community plugins settings.

Faust is desktop-only. Its MCP bridge requires Node.js 18 or newer. Configure the Node.js path, agent executable paths, and launch shell in Faust settings as needed.

### macOS and `node-pty`

Node.js must be installed on the Mac because Faust runs `node-pty` in a separate Node process. Faust checks common locations such as `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`, and `PATH`. If it cannot find Node.js, set **Node.js path** in Faust settings.

`node-pty` is a native addon and must be installed for the Mac's OS and architecture. Run `npm install` in the Faust plugin folder on the Mac where Obsidian will use it; do not copy `node_modules` from another operating system or architecture. On macOS, install Xcode Command Line Tools first if the native build needs them:

```bash
xcode-select --install
```

Recent npm versions may report that dependency install scripts were held back. If so, approve the build scripts Faust needs, then run the install again:

```bash
npm install-scripts approve esbuild node-pty
npm install
```

If syncing or copying the plugin strips the executable bit from `node-pty`'s macOS helper, restore it with:

```bash
chmod +x "<vault>/.obsidian/plugins/faust/node_modules/node-pty/prebuilds"/darwin-*/spawn-helper
```

## Development

Edit `src/`, then run `npm run build` to generate `main.js` and `mcp-server.js`. `npm test` runs the harness unit tests.

## Acknowledgments

Huge thanks to [m4rri4nne](https://github.com/m4rri4nne) for the awesome plugin ❤️.
