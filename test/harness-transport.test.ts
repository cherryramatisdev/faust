import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  BridgeProtocolError,
  createBridgeSession,
  createCanvasWriteOperation,
  validateCanvasWriteAcknowledgement,
  waitForWriteAcknowledgement,
  writeCanvasWriteAcknowledgement,
  writeCanvasWriteOperation,
} from "../src/harness-transport.js";
import type { BridgeSession, CanvasWriteOperation } from "../src/harness-transport.js";

async function temporaryRoot(t: TestContext): Promise<string> {
  const root: string = await fs.mkdtemp(path.join(os.tmpdir(), "faust-transport-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("creates a private session directory outside the vault with a Canvas state path", async (t: TestContext) => {
  const session: BridgeSession = await createBridgeSession({ temporaryRoot: await temporaryRoot(t) });

  assert.match(session.directory, /faust-canvas/);
  assert.equal(path.dirname(session.canvasStatePath), session.directory);
  assert.equal(path.basename(session.canvasStatePath), "canvas-state.json");
  assert.equal(await fs.readFile(session.canvasStatePath, "utf8").catch(() => null), null);
  assert.deepEqual(await fs.readdir(session.outboxDirectory), []);
});

test("writes and acknowledges an authenticated Canvas operation", async (t: TestContext) => {
  const session: BridgeSession = await createBridgeSession({ temporaryRoot: await temporaryRoot(t) });
  session.harnessId = "pi-main";
  const operation: CanvasWriteOperation = createCanvasWriteOperation({
    harnessId: session.harnessId,
    bridgeToken: session.bridgeToken,
    canvasPath: "main.canvas",
    harnessNodeId: "harness",
    targetNodeId: "answer",
    content: "draft",
  });
  const operationPath: string = await writeCanvasWriteOperation(session, operation);
  assert.deepEqual(JSON.parse(await fs.readFile(operationPath, "utf8")), operation);

  await writeCanvasWriteAcknowledgement(session, {
    version: 1,
    operationId: operation.operationId,
    harnessId: session.harnessId,
    status: "accepted",
    targetNodeId: "answer",
    receivedAt: new Date().toISOString(),
  });
  const acknowledgement = await waitForWriteAcknowledgement(session, operation.operationId, { timeoutMs: 100, pollIntervalMs: 2 });
  assert.equal(acknowledgement.status, "accepted");
  assert.doesNotThrow(() => validateCanvasWriteAcknowledgement(acknowledgement, { operationId: operation.operationId }));
});

test("rejects an operation with a mismatched bridge token", async (t: TestContext) => {
  const session: BridgeSession = await createBridgeSession({ temporaryRoot: await temporaryRoot(t) });
  session.harnessId = "pi-main";
  const operation: CanvasWriteOperation = createCanvasWriteOperation({
    harnessId: session.harnessId,
    bridgeToken: "wrong-token",
    canvasPath: "main.canvas",
    harnessNodeId: "harness",
    targetNodeId: "answer",
    content: "draft",
  });

  await assert.rejects(writeCanvasWriteOperation(session, operation), BridgeProtocolError);
});

test("times out without writing a duplicate operation", async (t: TestContext) => {
  const session: BridgeSession = await createBridgeSession({ temporaryRoot: await temporaryRoot(t) });
  await assert.rejects(waitForWriteAcknowledgement(session, "write-missing", { timeoutMs: 10, pollIntervalMs: 2 }), /Timed out/);
});
