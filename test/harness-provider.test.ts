import assert from "node:assert/strict";
import test from "node:test";
import { HarnessProviderRegistry, PiHarnessProvider } from "../src/harness-provider.js";
import { RESEARCH_PARTNER_PROMPT } from "../src/research-partner-prompt.js";
import type { BridgeSession } from "../src/harness-transport.js";
import type { FaustPlugin } from "../src/constants.js";

// test stub — only the members PiHarnessProvider accesses are populated
function plugin(): FaustPlugin {
  return {
    settings: { harnessProviders: { pi: { executable: "" } } },
    pluginDir: () => "/vault/.obsidian/plugins/faust",
    resolveNodePath: () => null,
    quoteArg: (value: string): string => value,
  } as unknown as FaustPlugin;
}

test("providers expose a runtime-specific launch spec without owning Canvas state", (): void => {
  const provider: PiHarnessProvider = new PiHarnessProvider(plugin());
  const spec = provider.createLaunchSpec({
    vaultPath: "/vault",
    bridge: {
      harnessId: "main",
      directory: "/tmp/session",
      bridgeToken: "token",
      protocolVersion: 1,
      canvasPath: "main.canvas",
      harnessNodeId: "node",
      canvasStatePath: "/tmp/session/canvas-state.json",
    } as unknown as BridgeSession,
  });

  assert.equal(provider.id, "pi");
  assert.equal(spec.cwd, "/vault");
  assert.match(spec.command, /faust-canvas\.js/);
  assert.match(spec.command, /--append-system-prompt /);
  assert.doesNotMatch(spec.command, /--system-prompt /);
  assert.ok(spec.command.includes(RESEARCH_PARTNER_PROMPT));
  assert.equal(spec.env.FAUST_CANVAS_STATE_PATH, "/tmp/session/canvas-state.json");
});

test("provider registry selects providers by declaration ID", (): void => {
  const provider: PiHarnessProvider = new PiHarnessProvider(plugin());
  const registry: HarnessProviderRegistry = new HarnessProviderRegistry([provider]);

  assert.equal(registry.get("pi"), provider);
  assert.equal(registry.get("claude-code"), null);
});
