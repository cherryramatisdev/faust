import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type WriteMode = "replace" | "append";
export type WriteStatus = "accepted" | "rejected" | "failed";

export interface BridgeSession {
  protocolVersion: number;
  sessionId: string;
  bridgeToken: string;
  directory: string;
  canvasStatePath: string;
  outboxDirectory: string;
  writeProcessedDirectory: string;
  writeAcknowledgementsDirectory: string;
  writeErrorsDirectory: string;
  sessionPath: string;
  harnessId?: string;
  canvasPath?: string;
  harnessNodeId?: string;
  session?: unknown;
}

export interface CanvasWriteOperation {
  version: number;
  operationId: string;
  operation: "write_canvas_node";
  harnessId: string;
  bridgeToken: string;
  canvasPath: string;
  harnessNodeId: string;
  targetNodeId: string;
  content: string;
  mode: WriteMode;
  createdAt: string;
}

export interface CanvasWriteAcknowledgement {
  version: number;
  operationId: string;
  harnessId: string;
  status: WriteStatus;
  receivedAt: string;
  targetNodeId?: string;
  targetType?: string;
  file?: string;
  mode?: WriteMode;
  error?: string;
}

export interface ValidationExpected {
  harnessId?: string;
  bridgeToken?: string;
  operationId?: string;
}

export interface CreateCanvasWriteOperationInput {
  harnessId: string;
  bridgeToken: string;
  canvasPath: string;
  harnessNodeId: string;
  targetNodeId: string;
  content: string;
  mode?: WriteMode;
}

export interface WaitForAcknowledgementOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface CreateBridgeSessionOptions {
  temporaryRoot?: string;
}

const PROTOCOL_VERSION: number = 1;
const SESSION_DIRECTORY_NAME: string = "faust-canvas";
const WRITE_ID: RegExp = /^write-[A-Za-z0-9-]+$/;

class BridgeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeProtocolError";
  }
}

function randomId(prefix: string): string {
  const value = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  return `${prefix}-${value}`;
}

async function createBridgeSession({ temporaryRoot = os.tmpdir() }: CreateBridgeSessionOptions = {}): Promise<BridgeSession> {
  const sessionId: string = randomId("session");
  const directory: string = path.join(temporaryRoot, SESSION_DIRECTORY_NAME, sessionId);
  const session: BridgeSession = {
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

function createCanvasWriteOperation({ harnessId, bridgeToken, canvasPath, harnessNodeId, targetNodeId, content, mode = "replace" }: CreateCanvasWriteOperationInput): CanvasWriteOperation {
  const operation: CanvasWriteOperation = {
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

function validateCanvasWriteOperation(operation: unknown, expected: ValidationExpected = {}): CanvasWriteOperation {
  if (!operation || typeof operation !== "object") throw new BridgeProtocolError("Canvas write operation has an unsupported protocol version.");
  const op = operation as CanvasWriteOperation & Record<string, unknown>;
  if (op.version !== PROTOCOL_VERSION) throw new BridgeProtocolError("Canvas write operation has an unsupported protocol version.");
  for (const field of ["operationId", "harnessId", "bridgeToken", "canvasPath", "harnessNodeId", "targetNodeId", "content", "createdAt"] as const) {
    if (typeof op[field] !== "string" || !op[field]) throw new BridgeProtocolError(`Canvas write field "${field}" is required.`);
  }
  if (op.operation !== "write_canvas_node") throw new BridgeProtocolError("Unsupported Canvas operation.");
  if (!WRITE_ID.test(op.operationId)) throw new BridgeProtocolError("Canvas operation ID is invalid.");
  if (!["replace", "append"].includes(op.mode)) throw new BridgeProtocolError("Canvas write mode is invalid.");
  if (expected.harnessId && op.harnessId !== expected.harnessId) throw new BridgeProtocolError("Canvas operation targets a different harness.");
  if (expected.bridgeToken && op.bridgeToken !== expected.bridgeToken) throw new BridgeProtocolError("Canvas operation token is not authorized for this session.");
  return op as CanvasWriteOperation;
}

async function writeCanvasWriteOperation(session: BridgeSession, operation: CanvasWriteOperation): Promise<string> {
  validateCanvasWriteOperation(operation, { bridgeToken: session.bridgeToken, harnessId: session.harnessId });
  const operationPath: string = path.join(session.outboxDirectory, `${operation.operationId}.json`);
  await writeJsonAtomically(operationPath, operation);
  return operationPath;
}

async function waitForWriteAcknowledgement(session: BridgeSession, operationId: string, { timeoutMs = 10_000, pollIntervalMs = 100 }: WaitForAcknowledgementOptions = {}): Promise<CanvasWriteAcknowledgement> {
  const acknowledgementPath: string = path.join(session.writeAcknowledgementsDirectory, `${operationId}.json`);
  const deadline: number = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const content: string | null = await readFileOrNull(acknowledgementPath);
    if (content !== null) {
      let acknowledgement: CanvasWriteAcknowledgement;
      try { acknowledgement = JSON.parse(content); } catch { throw new BridgeProtocolError(`Canvas acknowledgement for "${operationId}" is not valid JSON.`); }
      return validateCanvasWriteAcknowledgement(acknowledgement, { operationId, harnessId: session.harnessId });
    }
    await sleep(pollIntervalMs);
  }
  throw new BridgeProtocolError(`Timed out waiting for Canvas acknowledgement of "${operationId}".`);
}

function validateCanvasWriteAcknowledgement(acknowledgement: unknown, expected: ValidationExpected = {}): CanvasWriteAcknowledgement {
  if (!acknowledgement || typeof acknowledgement !== "object") throw new BridgeProtocolError("Canvas acknowledgement has an unsupported protocol version.");
  const ack = acknowledgement as CanvasWriteAcknowledgement & Record<string, unknown>;
  if (ack.version !== PROTOCOL_VERSION) throw new BridgeProtocolError("Canvas acknowledgement has an unsupported protocol version.");
  for (const field of ["operationId", "harnessId", "status", "receivedAt"] as const) {
    if (typeof ack[field] !== "string" || !ack[field]) throw new BridgeProtocolError(`Canvas acknowledgement field "${field}" is required.`);
  }
  if (!WRITE_ID.test(ack.operationId)) throw new BridgeProtocolError("Canvas acknowledgement operation ID is invalid.");
  if (!["accepted", "rejected", "failed"].includes(ack.status)) throw new BridgeProtocolError(`Unsupported Canvas acknowledgement status "${ack.status}".`);
  if (expected.operationId && ack.operationId !== expected.operationId) throw new BridgeProtocolError("Canvas acknowledgement belongs to a different operation.");
  if (expected.harnessId && ack.harnessId !== expected.harnessId) throw new BridgeProtocolError("Canvas acknowledgement belongs to a different harness.");
  return ack as CanvasWriteAcknowledgement;
}

async function writeCanvasWriteAcknowledgement(session: BridgeSession, acknowledgement: CanvasWriteAcknowledgement): Promise<string> {
  validateCanvasWriteAcknowledgement(acknowledgement, { harnessId: session.harnessId });
  const acknowledgementPath: string = path.join(session.writeAcknowledgementsDirectory, `${acknowledgement.operationId}.json`);
  await writeJsonAtomically(acknowledgementPath, acknowledgement);
  return acknowledgementPath;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath: string = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export {
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
