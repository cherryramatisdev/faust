"use strict";

const crypto = require("crypto");
const path = require("path");
const { RESEARCH_PARTNER_PROMPT } = require("./research-partner-prompt");

const MCP_SERVER_NAME = "faust";
const PI_CODEMODE_PROMPT = `## Canvas tools in Pi

Call the Faust Canvas MCP tools through Pi's \`codemode\`. Use \`searchTools(query, { namespace: "faust" })\` or \`describeNamespace("faust")\` to discover them, then call the returned tools from a codemode script, for example \`tools.mcp__faust__read_context({})\`.

Use \`mcp__faust__read_context\` to read connected Canvas content and \`mcp__faust__write_canvas_node\` to make Canvas changes. Do not modify the Canvas file or connected output files with Pi's edit/write tools, shell commands, or scripts.`;
const PI_ADAPTER_PROMPT = `${RESEARCH_PARTNER_PROMPT}\n\n${PI_CODEMODE_PROMPT}`;

/**
 * Provider contract: expose a stable `id` and return `{ cwd, command, env }` from
 * `createLaunchSpec({ bridge, vaultPath })`. HarnessManager owns the shared session lifecycle.
 */
class PiHarnessProvider {
  constructor(plugin) {
    this.id = "pi";
    this.plugin = plugin;
  }

  createLaunchSpec({ bridge, vaultPath }) {
    const bridgeExtensionPath = path.join(this.plugin.pluginDir(), "bridge", "faust-canvas.js");
    const executable = configuredExecutable(this.plugin, this.id, "pi");
    const env = createHarnessEnvironment(this.plugin, bridge, vaultPath);
    const args = [
      "--extension", bridgeExtensionPath,
      "--append-system-prompt", PI_ADAPTER_PROMPT,
    ];
    return { cwd: vaultPath, command: shellCommand(this.plugin, executable, args), env };
  }
}

class CodexHarnessProvider {
  constructor(plugin) {
    this.id = "codex";
    this.plugin = plugin;
  }

  createLaunchSpec({ bridge, vaultPath }) {
    const executable = configuredExecutable(this.plugin, this.id, "codex");
    const server = createMcpServerConfig(this.plugin, bridge, vaultPath);
    const overrides = [
      ["mcp_servers.faust.command", tomlString(server.command)],
      ["mcp_servers.faust.args", tomlArray(server.args)],
      ["mcp_servers.faust.env", tomlTable(server.env)],
      ["mcp_servers.faust.enabled", "true"],
      ["developer_instructions", tomlString(RESEARCH_PARTNER_PROMPT)],
    ];
    const args = ["--sandbox", "read-only"];
    for (const [key, value] of overrides) args.push("-c", `${key}=${value}`);
    return { cwd: vaultPath, command: shellCommand(this.plugin, executable, args), env: createHarnessEnvironment(this.plugin, bridge, vaultPath) };
  }
}

class ClaudeCodeHarnessProvider {
  constructor(plugin) {
    this.id = "claude-code";
    this.plugin = plugin;
  }

  createLaunchSpec({ bridge, vaultPath }) {
    const executable = configuredExecutable(this.plugin, this.id, "claude");
    const server = createMcpServerConfig(this.plugin, bridge, vaultPath);
    const mcpConfig = JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "stdio",
          command: server.command,
          args: server.args,
          env: server.env,
        },
      },
    });
    const args = [
      "--mcp-config", mcpConfig,
      "--append-system-prompt", RESEARCH_PARTNER_PROMPT,
      "--permission-mode", "plan",
    ];
    return { cwd: vaultPath, command: shellCommand(this.plugin, executable, args), env: createHarnessEnvironment(this.plugin, bridge, vaultPath) };
  }
}

function createHarnessEnvironment(plugin, bridge, vaultPath) {
  return {
    FAUST_VAULT_ID: crypto.createHash("sha256").update(vaultPath).digest("hex"),
    FAUST_HARNESS_ID: bridge.harnessId,
    FAUST_BRIDGE_DIR: bridge.directory,
    FAUST_BRIDGE_TOKEN: bridge.bridgeToken,
    FAUST_PROTOCOL_VERSION: String(bridge.protocolVersion),
    FAUST_CANVAS_PATH: bridge.canvasPath || "",
    FAUST_HARNESS_NODE_ID: bridge.harnessNodeId || "",
    FAUST_CANVAS_STATE_PATH: bridge.canvasStatePath || "",
    FAUST_MCP_SERVER_PATH: path.join(plugin.pluginDir(), "mcp-server.js"),
    FAUST_NODE_PATH: plugin.resolveNodePath?.() || "node",
  };
}

function createMcpServerConfig(plugin, bridge, vaultPath) {
  const env = createHarnessEnvironment(plugin, bridge, vaultPath);
  return {
    command: env.FAUST_NODE_PATH,
    args: [env.FAUST_MCP_SERVER_PATH],
    cwd: vaultPath,
    env: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("FAUST_"))),
  };
}

function configuredExecutable(plugin, providerId, fallback) {
  return plugin.settings.harnessProviders?.[providerId]?.executable?.trim() || fallback;
}

function shellCommand(plugin, executable, args) {
  return [executable, ...args].map((value) => plugin.quoteArg(value)).join(" ");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlTable(values) {
  return `{${Object.entries(values).map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ")}}`;
}

class HarnessProviderRegistry {
  constructor(providers) {
    this.providers = new Map();
    for (const provider of providers) {
      if (!provider || typeof provider.id !== "string" || typeof provider.createLaunchSpec !== "function") {
        throw new TypeError("Harness providers must expose an id and createLaunchSpec().");
      }
      if (this.providers.has(provider.id)) throw new Error(`Duplicate harness provider "${provider.id}".`);
      this.providers.set(provider.id, provider);
    }
  }

  get(id) {
    return this.providers.get(id) || null;
  }
}

module.exports = {
  ClaudeCodeHarnessProvider,
  CodexHarnessProvider,
  HarnessProviderRegistry,
  PiHarnessProvider,
  createHarnessEnvironment,
  createMcpServerConfig,
};
