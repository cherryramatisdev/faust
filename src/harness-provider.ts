import crypto from "node:crypto";
import path from "node:path";
import { RESEARCH_PARTNER_PROMPT } from "./research-partner-prompt.js";
import type { BridgeSession } from "./harness-transport.js";
import type { FaustPlugin } from "./constants.js";

export interface LaunchSpec {
  cwd: string | null;
  command: string;
  env: Record<string, string>;
}

export interface HarnessProvider {
  id: string;
  createLaunchSpec(opts: { bridge: BridgeSession; vaultPath: string | null }): LaunchSpec;
}

// Declared as a type alias (not an interface) so it carries an implicit string index
// signature: this lets it assign to `Record<string, string>` and flow through
// `Object.entries()` as `[string, string][]` instead of widening to `any`.
export type HarnessEnvironment = {
  FAUST_VAULT_ID: string;
  FAUST_HARNESS_ID: string;
  FAUST_BRIDGE_DIR: string;
  FAUST_BRIDGE_TOKEN: string;
  FAUST_PROTOCOL_VERSION: string;
  FAUST_CANVAS_PATH: string;
  FAUST_HARNESS_NODE_ID: string;
  FAUST_CANVAS_STATE_PATH: string;
  FAUST_MCP_SERVER_PATH: string;
  FAUST_NODE_PATH: string;
};

export interface McpServerConfig {
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
}

const MCP_SERVER_NAME: string = "faust";
const PI_CODEMODE_PROMPT: string = `## Canvas tools in Pi

Call the Faust Canvas MCP tools through Pi's \`codemode\`. Use \`searchTools(query, { namespace: "faust" })\` or \`describeNamespace("faust")\` to discover them, then call the returned tools from a codemode script, for example \`tools.mcp__faust__read_context({})\`.

Use \`mcp__faust__read_context\` to read connected Canvas content and \`mcp__faust__write_canvas_node\` to make Canvas changes. Do not modify the Canvas file or connected output files with Pi's edit/write tools, shell commands, or scripts.`;
const PI_ADAPTER_PROMPT: string = `${RESEARCH_PARTNER_PROMPT}\n\n${PI_CODEMODE_PROMPT}`;

/**
 * Provider contract: expose a stable `id` and return `{ cwd, command, env }` from
 * `createLaunchSpec({ bridge, vaultPath })`. HarnessManager owns the shared session lifecycle.
 */
class PiHarnessProvider implements HarnessProvider {
  id: string;
  plugin: FaustPlugin;

  constructor(plugin: FaustPlugin) {
    this.id = "pi";
    this.plugin = plugin;
  }

  createLaunchSpec({ bridge, vaultPath }: { bridge: BridgeSession; vaultPath: string | null }): LaunchSpec {
    const bridgeExtensionPath: string = path.join(this.plugin.pluginDir(), "bridge", "faust-canvas.js");
    const executable: string = configuredExecutable(this.plugin, this.id, "pi");
    const env: Record<string, string> = createHarnessEnvironment(this.plugin, bridge, vaultPath);
    const args: string[] = [
      "--extension", bridgeExtensionPath,
      "--append-system-prompt", PI_ADAPTER_PROMPT,
    ];
    return { cwd: vaultPath, command: shellCommand(this.plugin, executable, args), env };
  }
}

class CodexHarnessProvider implements HarnessProvider {
  id: string;
  plugin: FaustPlugin;

  constructor(plugin: FaustPlugin) {
    this.id = "codex";
    this.plugin = plugin;
  }

  createLaunchSpec({ bridge, vaultPath }: { bridge: BridgeSession; vaultPath: string | null }): LaunchSpec {
    const executable: string = configuredExecutable(this.plugin, this.id, "codex");
    const server: McpServerConfig = createMcpServerConfig(this.plugin, bridge, vaultPath);
    const overrides: [string, string][] = [
      ["mcp_servers.faust.command", tomlString(server.command)],
      ["mcp_servers.faust.args", tomlArray(server.args)],
      ["mcp_servers.faust.env", tomlTable(server.env)],
      ["mcp_servers.faust.enabled", "true"],
      ["developer_instructions", tomlString(RESEARCH_PARTNER_PROMPT)],
    ];
    const args: string[] = ["--sandbox", "read-only"];
    for (const [key, value] of overrides) args.push("-c", `${key}=${value}`);
    return { cwd: vaultPath, command: shellCommand(this.plugin, executable, args), env: createHarnessEnvironment(this.plugin, bridge, vaultPath) };
  }
}

class ClaudeCodeHarnessProvider implements HarnessProvider {
  id: string;
  plugin: FaustPlugin;

  constructor(plugin: FaustPlugin) {
    this.id = "claude-code";
    this.plugin = plugin;
  }

  createLaunchSpec({ bridge, vaultPath }: { bridge: BridgeSession; vaultPath: string | null }): LaunchSpec {
    const executable: string = configuredExecutable(this.plugin, this.id, "claude");
    const server: McpServerConfig = createMcpServerConfig(this.plugin, bridge, vaultPath);
    const mcpConfig: string = JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "stdio",
          command: server.command,
          args: server.args,
          env: server.env,
        },
      },
    });
    const args: string[] = [
      "--mcp-config", mcpConfig,
      "--append-system-prompt", RESEARCH_PARTNER_PROMPT,
      "--permission-mode", "plan",
    ];
    return { cwd: vaultPath, command: shellCommand(this.plugin, executable, args), env: createHarnessEnvironment(this.plugin, bridge, vaultPath) };
  }
}

function createHarnessEnvironment(plugin: FaustPlugin, bridge: BridgeSession, vaultPath: string | null): HarnessEnvironment {
  return {
    FAUST_VAULT_ID: crypto.createHash("sha256").update(vaultPath ?? "").digest("hex"),
    FAUST_HARNESS_ID: bridge.harnessId ?? "",
    FAUST_BRIDGE_DIR: bridge.directory,
    FAUST_BRIDGE_TOKEN: bridge.bridgeToken,
    FAUST_PROTOCOL_VERSION: String(bridge.protocolVersion),
    FAUST_CANVAS_PATH: bridge.canvasPath ?? "",
    FAUST_HARNESS_NODE_ID: bridge.harnessNodeId ?? "",
    FAUST_CANVAS_STATE_PATH: bridge.canvasStatePath ?? "",
    FAUST_MCP_SERVER_PATH: path.join(plugin.pluginDir(), "mcp-server.js"),
    FAUST_NODE_PATH: plugin.resolveNodePath() || "node",
  };
}

function createMcpServerConfig(plugin: FaustPlugin, bridge: BridgeSession, vaultPath: string | null): McpServerConfig {
  const env: HarnessEnvironment = createHarnessEnvironment(plugin, bridge, vaultPath);
  return {
    command: env.FAUST_NODE_PATH,
    args: [env.FAUST_MCP_SERVER_PATH],
    cwd: vaultPath,
    env: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("FAUST_"))),
  };
}

function configuredExecutable(plugin: FaustPlugin, providerId: string, fallback: string): string {
  return (plugin.settings.harnessProviders as Record<string, { executable: string }>)[providerId]?.executable?.trim() || fallback;
}

function shellCommand(plugin: FaustPlugin, executable: string, args: string[]): string {
  return [executable, ...args].map((value) => plugin.quoteArg(value)).join(" ");
}

function tomlString(value: string): string {
  return JSON.stringify(String(value));
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlTable(values: Record<string, string>): string {
  return `{${Object.entries(values).map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ")}}`;
}

class HarnessProviderRegistry {
  providers: Map<string, HarnessProvider>;

  constructor(providers: HarnessProvider[]) {
    this.providers = new Map();
    for (const provider of providers) {
      if (!provider || typeof provider.id !== "string" || typeof provider.createLaunchSpec !== "function") {
        throw new TypeError("Harness providers must expose an id and createLaunchSpec().");
      }
      if (this.providers.has(provider.id)) throw new Error(`Duplicate harness provider "${provider.id}".`);
      this.providers.set(provider.id, provider);
    }
  }

  get(id: string): HarnessProvider | null {
    return this.providers.get(id) || null;
  }
}

export {
  ClaudeCodeHarnessProvider,
  CodexHarnessProvider,
  HarnessProviderRegistry,
  PiHarnessProvider,
  createHarnessEnvironment,
  createMcpServerConfig,
};
