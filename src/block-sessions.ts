// Registry of agent consoles embedded in Canvas harness cards.

import { TFile } from "obsidian";
import { HARNESS_LANGUAGE } from "./harness-declaration.js";
import { HarnessBlockChild } from "./harness-block.js";
import type { FaustPlugin } from "./constants.js";

export interface HarnessBlockSession {
  disposed?: boolean;
  cwd?: string;
  parentEl?: HTMLElement | null;
  onReveal?: () => void;
  onDispose?: () => void;
  isAttached(): boolean;
  attach(el: HTMLElement): void;
  detach(): void;
  restart(): void;
  kill(): void;
  dispose(): void;
}

interface BlockSessionsOptions {
  language?: string | string[];
  createSession?: (opts: Record<string, string>, ctx: unknown, source: string) => Promise<HarnessBlockSession | null>;
  keyFor?: (source: string, sourcePath: string) => string;
}

/** "key: value" options of a Canvas harness declaration. */
function parseBlockOptions(source: string): Record<string, string> {
  const opts: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const m: RegExpMatchArray | null = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
    if (m) opts[m[1].toLowerCase()] = m[2];
  }
  return opts;
}

/** Session key: the harness ID, or file + declaration content. */
function blockKey(source: string, sourcePath: string): string {
  const opts: Record<string, string> = parseBlockOptions(source);
  const id: string | undefined = opts.id;
  return id ? `id:${id}` : `${sourcePath}::${source.trim()}`;
}

class BlockSessions {
  plugin: FaustPlugin;
  language: string | string[];
  keyFor: (source: string, sourcePath: string) => string;
  createSession: (opts: Record<string, string>, ctx: unknown, source: string) => Promise<HarnessBlockSession | null>;
  sessions: Map<string, HarnessBlockSession>;
  orphanTimers: Map<string, ReturnType<typeof setTimeout>>;

  constructor(plugin: FaustPlugin, { language = HARNESS_LANGUAGE, createSession, keyFor = blockKey }: BlockSessionsOptions = {}) {
    this.plugin = plugin;
    this.language = language;
    this.keyFor = keyFor;
    if (typeof createSession !== "function") throw new TypeError("Canvas harness block sessions require a session factory.");
    this.createSession = createSession;
    this.sessions = new Map(); // harness block key -> agent session
    this.orphanTimers = new Map();
  }

  /** Markdown code block processor for a Canvas harness. */
  async process(source: string, el: HTMLElement, ctx: { sourcePath: string; addChild(child: unknown): void }): Promise<void> {
    const opts: Record<string, string> = parseBlockOptions(source);
    const key: string = this.keyFor(source, ctx.sourcePath);
    let session: HarnessBlockSession | null | undefined = this.sessions.get(key);
    if (!session || session.disposed) {
      session = await this.createSession(opts, ctx, source);
      if (!session) return;
      this.sessions.set(key, session);
    }
    ctx.addChild(new HarnessBlockChild(el, this, session, key, ctx.sourcePath));
  }

  /**
   * Called when a block leaves the DOM. Canvas unloads off-screen cards,
   * so the agent session is only stopped if its card no longer exists.
   */
  scheduleOrphanCheck(key: string, sourcePath: string): void {
    clearTimeout(this.orphanTimers.get(key));
    this.orphanTimers.set(
      key,
      setTimeout(async () => {
        this.orphanTimers.delete(key);
        const session: HarnessBlockSession | undefined = this.sessions.get(key);
        if (!session || session.isAttached()) return;
        const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
        let keys: Set<string> | null = new Set();
        if (file instanceof TFile) {
          try {
            keys = this.keysInFile(await this.plugin.app.vault.cachedRead(file), file);
          } catch {
            return;
          }
        }
        if (keys === null) return;
        if (!keys.has(key) && !session.isAttached()) {
          session.dispose();
          this.sessions.delete(key);
        }
      }, 5000)
    );
  }

  keysInFile(content: string, file: TFile): Set<string> | null {
    let texts: string[] = [content];
    if (file.extension === "canvas") {
      try {
        const data: { nodes?: Array<{ type?: string; text?: string }> } = JSON.parse(content);
        texts = (data.nodes || []).filter((n) => n.type === "text").map((n) => n.text || "");
      } catch {
        return null;
      }
    }
    const keys: Set<string> = new Set();
    const languages: string[] = Array.isArray(this.language) ? this.language : [this.language];
    const languagePattern: string = languages.map((language: string) => language.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const fence: RegExp = new RegExp("^(`{3,}|~{3,})[ \\t]*(?:" + languagePattern + ")[ \\t]*\\r?\\n([\\s\\S]*?)^\\1[ \\t]*$", "gm");
    for (const text of texts) {
      for (const m of text.matchAll(fence)) keys.add(this.keyFor(m[2] ?? "", file.path));
    }
    return keys;
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    for (const timer of this.orphanTimers.values()) clearTimeout(timer);
    this.orphanTimers.clear();
  }
}

export { BlockSessions, parseBlockOptions, blockKey };
