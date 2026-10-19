import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import {
  BridgeProtocolError,
  createBridgeSession,
  createCanvasWriteOperation,
  submitCanvasWrite,
  validateCanvasWriteOperation,
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
async function acknowledgeNextCanvasWrite(session: BridgeSession): Promise<CanvasWriteOperation> {
  const harnessId: string | undefined = session.harnessId;
  assert.ok(harnessId);
  let operation: CanvasWriteOperation | undefined;
  for (let attempt = 0; attempt < 100 && !operation; attempt++) {
    let name: string | undefined;
    for (const entry of await fs.readdir(session.outboxDirectory)) {
      if (entry.endsWith(".json")) {
        name = entry;
        break;
      }
    }
    if (name) {
      operation = validateCanvasWriteOperation(
        JSON.parse(await fs.readFile(path.join(session.outboxDirectory, name), "utf8")),
        { harnessId, bridgeToken: session.bridgeToken },
      );
      break;
    }
    await delay(10);
  }
  assert.ok(operation, "Canvas write did not reach the bridge outbox");
  await writeCanvasWriteAcknowledgement(session, {
    version: session.protocolVersion,
    operationId: operation.operationId,
    harnessId,
    status: "accepted",
    targetNodeId: operation.targetNodeId,
    targetType: "text",
    mode: operation.mode,
    receivedAt: "2026-10-18T12:00:01.000Z",
  });
  return operation;
}

test("creates a private session directory outside the vault with a Canvas state path", async (t: TestContext) => {
  const session: BridgeSession = await createBridgeSession({ temporaryRoot: await temporaryRoot(t) });

  assert.match(session.directory, /faust-canvas/);
  assert.equal(path.dirname(session.canvasStatePath), session.directory);
  assert.equal(path.basename(session.canvasStatePath), "canvas-state.json");
  assert.equal(await fs.readFile(session.canvasStatePath, "utf8").catch(() => null), null);
  assert.deepEqual(await fs.readdir(session.outboxDirectory), []);
});

test("submits an authenticated Canvas write and waits for its acknowledgement", async (t: TestContext) => {
  const session: BridgeSession = await createBridgeSession({ temporaryRoot: await temporaryRoot(t) });
  const harnessId: string = "pi-main";
  session.harnessId = harnessId;
  const [acknowledgement, operation] = await Promise.all([
    submitCanvasWrite(session, {
      harnessId,
      bridgeToken: session.bridgeToken,
      canvasPath: "main.canvas",
      harnessNodeId: "harness",
      targetNodeId: "answer",
      content: "draft",
      mode: "append",
    }, { timeoutMs: 1_000, pollIntervalMs: 2 }),
    acknowledgeNextCanvasWrite(session),
  ]);

  assert.equal(operation.operation, "write_canvas_node");
  assert.equal(operation.targetNodeId, "answer");
  assert.equal(operation.content, "draft");
  assert.equal(operation.mode, "append");
  assert.equal(acknowledgement.status, "accepted");
  assert.equal(acknowledgement.operationId, operation.operationId);
  assert.equal(acknowledgement.targetNodeId, "answer");
  assert.equal(acknowledgement.mode, "append");
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
