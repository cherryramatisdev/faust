"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { HarnessProviderRegistry, PiHarnessProvider } = require("../src/harness-provider");
const { RESEARCH_PARTNER_PROMPT } = require("../src/research-partner-prompt");

function plugin() {
  return {
    settings: { harnessProviders: { pi: { executable: "" } } },
    pluginDir: () => "/vault/.obsidian/plugins/faust",
    quoteArg: (value) => `"${value}"`,
  };
}

test("providers expose a runtime-specific launch spec without owning Canvas state", () => {
  const provider = new PiHarnessProvider(plugin());
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
    },
  });

  assert.equal(provider.id, "pi");
  assert.equal(spec.cwd, "/vault");
  assert.match(spec.command, /faust-canvas\.js/);
  assert.match(spec.command, /--append-system-prompt /);
  assert.doesNotMatch(spec.command, /--system-prompt /);
  assert.ok(spec.command.includes(RESEARCH_PARTNER_PROMPT));
  assert.equal(spec.env.FAUST_CANVAS_STATE_PATH, "/tmp/session/canvas-state.json");
});

test("provider registry selects providers by declaration ID", () => {
  const provider = new PiHarnessProvider(plugin());
  const registry = new HarnessProviderRegistry([provider]);

  assert.equal(registry.get("pi"), provider);
  assert.equal(registry.get("claude-code"), null);
});
