// Pi-specific MCP connection. Canvas policy belongs in the Pi adapter prompt.
"use strict";

import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "faust";

export default function openTerminalCanvasBridge(pi) {
  const serverPath = process.env.FAUST_MCP_SERVER_PATH
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp-server.js");

  pi.registerMcpServer(SERVER_NAME, {
    type: "stdio",
    command: process.env.FAUST_NODE_PATH || "node",
    args: [serverPath],
    cwd: process.cwd(),
    env: {
      FAUST_BRIDGE_DIR: process.env.FAUST_BRIDGE_DIR || "",
      FAUST_HARNESS_ID: process.env.FAUST_HARNESS_ID || "",
      FAUST_BRIDGE_TOKEN: process.env.FAUST_BRIDGE_TOKEN || "",
      FAUST_PROTOCOL_VERSION: process.env.FAUST_PROTOCOL_VERSION || "",
      FAUST_CANVAS_PATH: process.env.FAUST_CANVAS_PATH || "",
      FAUST_HARNESS_NODE_ID: process.env.FAUST_HARNESS_NODE_ID || "",
      FAUST_CANVAS_STATE_PATH: process.env.FAUST_CANVAS_STATE_PATH || "",
    },
    exposure: "codemode",
  });
}
