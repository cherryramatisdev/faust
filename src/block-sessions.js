"use strict";

// Registry of agent consoles embedded in Canvas harness cards.

const { TFile } = require("obsidian");
const { GENERIC_HARNESS_LANGUAGE } = require("./harness-declaration");
const { HarnessBlockChild } = require("./harness-block");

/** "key: value" options of a Canvas harness declaration. */
function parseBlockOptions(source) {
  const opts = {};
  for (const line of source.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
    if (m) opts[m[1].toLowerCase()] = m[2];
  }
  return opts;
}

/** Session key: the harness ID, or file + declaration content. */
function blockKey(source, sourcePath) {
  const { id } = parseBlockOptions(source);
  return id ? `id:${id}` : `${sourcePath}::${source.trim()}`;
}

class BlockSessions {
  constructor(plugin, { language = GENERIC_HARNESS_LANGUAGE, createSession, keyFor = blockKey } = {}) {
    this.plugin = plugin;
    this.language = language;
    this.keyFor = keyFor;
    if (typeof createSession !== "function") throw new TypeError("Canvas harness block sessions require a session factory.");
    this.createSession = createSession;
    this.sessions = new Map(); // harness block key -> agent session
    this.orphanTimers = new Map();
  }

  /** Markdown code block processor for a Canvas harness. */
  async process(source, el, ctx) {
    const opts = parseBlockOptions(source);
    const key = this.keyFor(source, ctx.sourcePath);
    let session = this.sessions.get(key);
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
  scheduleOrphanCheck(key, sourcePath) {
    clearTimeout(this.orphanTimers.get(key));
    this.orphanTimers.set(
      key,
      setTimeout(async () => {
        this.orphanTimers.delete(key);
        const session = this.sessions.get(key);
        if (!session || session.isAttached()) return;
        const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
        let keys = new Set();
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

  keysInFile(content, file) {
    let texts = [content];
    if (file.extension === "canvas") {
      try {
        const data = JSON.parse(content);
        texts = (data.nodes || []).filter((n) => n.type === "text").map((n) => n.text || "");
      } catch {
        return null;
      }
    }
    const keys = new Set();
    const languages = Array.isArray(this.language) ? this.language : [this.language];
    const languagePattern = languages.map((language) => language.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")).join("|");
    const fence = new RegExp("^(`{3,}|~{3,})[ \\t]*(?:" + languagePattern + ")[ \\t]*\\r?\\n([\\s\\S]*?)^\\1[ \\t]*$", "gm");
    for (const text of texts) {
      for (const m of text.matchAll(fence)) keys.add(this.keyFor(m[2], file.path));
    }
    return keys;
  }

  disposeAll() {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    for (const timer of this.orphanTimers.values()) clearTimeout(timer);
    this.orphanTimers.clear();
  }
}

module.exports = { BlockSessions, parseBlockOptions, blockKey };
