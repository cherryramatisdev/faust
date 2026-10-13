"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const PROTOCOL_VERSION = 1;
const SESSION_DIRECTORY_NAME = "faust-canvas";
const WRITE_ID = /^write-[A-Za-z0-9-]+$/;

class BridgeProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeProtocolError";
  }
}

function randomId(prefix) {
  const value = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  return `${prefix}-${value}`;
}

async function createBridgeSession({ temporaryRoot = os.tmpdir() } = {}) {
  const sessionId = randomId("session");
  const directory = path.join(temporaryRoot, SESSION_DIRECTORY_NAME, sessionId);
  const session = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    bridgeToken: crypto.randomBytes(32).toString("base64url"),
    directory,
    canvasStatePath: path.join(directory, "canvas-state.json"),
    outboxDirectory: path.join(directory, "outbox"),
    writeProcessedDirectory: path.join(directory, "write-processed"),
    writeAcknowledgementsDirectory: path.join(directory, "write-acks"),
    writeErrorsDirectory: path.join(directory, "write-errors"),
    sessionPath: path.join(directory, "session.json"),
  };
  await Promise.all([
    fs.mkdir(session.outboxDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(session.writeProcessedDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(session.writeAcknowledgementsDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(session.writeErrorsDirectory, { recursive: true, mode: 0o700 }),
  ]);
  return session;
}

function createCanvasWriteOperation({ harnessId, bridgeToken, canvasPath, harnessNodeId, targetNodeId, content, mode = "replace" }) {
  const operation = {
    version: PROTOCOL_VERSION,
    operationId: randomId("write"),
    operation: "write_canvas_node",
    harnessId,
    bridgeToken,
    canvasPath,
    harnessNodeId,
    targetNodeId,
    content,
    mode,
    createdAt: new Date().toISOString(),
  };
  validateCanvasWriteOperation(operation);
  return operation;
}

function validateCanvasWriteOperation(operation, expected = {}) {
  if (!operation || typeof operation !== "object" || operation.version !== PROTOCOL_VERSION) throw new BridgeProtocolError("Canvas write operation has an unsupported protocol version.");
  for (const field of ["operationId", "harnessId", "bridgeToken", "canvasPath", "harnessNodeId", "targetNodeId", "content", "createdAt"]) {
    if (typeof operation[field] !== "string" || !operation[field]) throw new BridgeProtocolError(`Canvas write field "${field}" is required.`);
  }
  if (operation.operation !== "write_canvas_node") throw new BridgeProtocolError("Unsupported Canvas operation.");
  if (!WRITE_ID.test(operation.operationId)) throw new BridgeProtocolError("Canvas operation ID is invalid.");
  if (!["replace", "append"].includes(operation.mode)) throw new BridgeProtocolError("Canvas write mode is invalid.");
  if (expected.harnessId && operation.harnessId !== expected.harnessId) throw new BridgeProtocolError("Canvas operation targets a different harness.");
  if (expected.bridgeToken && operation.bridgeToken !== expected.bridgeToken) throw new BridgeProtocolError("Canvas operation token is not authorized for this session.");
  return operation;
}

async function writeCanvasWriteOperation(session, operation) {
  validateCanvasWriteOperation(operation, { bridgeToken: session.bridgeToken, harnessId: session.harnessId });
  const operationPath = path.join(session.outboxDirectory, `${operation.operationId}.json`);
  await writeJsonAtomically(operationPath, operation);
  return operationPath;
}

async function waitForWriteAcknowledgement(session, operationId, { timeoutMs = 10_000, pollIntervalMs = 100 } = {}) {
  const acknowledgementPath = path.join(session.writeAcknowledgementsDirectory, `${operationId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const content = await readFileOrNull(acknowledgementPath);
    if (content !== null) {
      let acknowledgement;
      try { acknowledgement = JSON.parse(content); } catch { throw new BridgeProtocolError(`Canvas acknowledgement for "${operationId}" is not valid JSON.`); }
      return validateCanvasWriteAcknowledgement(acknowledgement, { operationId, harnessId: session.harnessId });
    }
    await sleep(pollIntervalMs);
  }
  throw new BridgeProtocolError(`Timed out waiting for Canvas acknowledgement of "${operationId}".`);
}

function validateCanvasWriteAcknowledgement(acknowledgement, expected = {}) {
  if (!acknowledgement || acknowledgement.version !== PROTOCOL_VERSION) throw new BridgeProtocolError("Canvas acknowledgement has an unsupported protocol version.");
  for (const field of ["operationId", "harnessId", "status", "receivedAt"]) {
    if (typeof acknowledgement[field] !== "string" || !acknowledgement[field]) throw new BridgeProtocolError(`Canvas acknowledgement field "${field}" is required.`);
  }
  if (!WRITE_ID.test(acknowledgement.operationId)) throw new BridgeProtocolError("Canvas acknowledgement operation ID is invalid.");
  if (!["accepted", "rejected", "failed"].includes(acknowledgement.status)) throw new BridgeProtocolError(`Unsupported Canvas acknowledgement status "${acknowledgement.status}".`);
  if (expected.operationId && acknowledgement.operationId !== expected.operationId) throw new BridgeProtocolError("Canvas acknowledgement belongs to a different operation.");
  if (expected.harnessId && acknowledgement.harnessId !== expected.harnessId) throw new BridgeProtocolError("Canvas acknowledgement belongs to a different harness.");
  return acknowledgement;
}

async function writeCanvasWriteAcknowledgement(session, acknowledgement) {
  validateCanvasWriteAcknowledgement(acknowledgement, { harnessId: session.harnessId });
  const acknowledgementPath = path.join(session.writeAcknowledgementsDirectory, `${acknowledgement.operationId}.json`);
  await writeJsonAtomically(acknowledgementPath, acknowledgement);
  return acknowledgementPath;
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readFileOrNull(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = {
  BridgeProtocolError,
  PROTOCOL_VERSION,
  createBridgeSession,
  createCanvasWriteOperation,
  validateCanvasWriteOperation,
  validateCanvasWriteAcknowledgement,
  waitForWriteAcknowledgement,
  writeCanvasWriteAcknowledgement,
  writeCanvasWriteOperation,
};
