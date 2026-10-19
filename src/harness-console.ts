import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { FaustPlugin } from "./constants.js";

interface XtermOptions {
  cursorBlink: boolean;
  cursorStyle: string;
  cursorWidth: number;
  fontSize: number;
  fontFamily: string;
  letterSpacing: number;
  lineHeight: number;
  fontWeight: string;
  fontWeightBold: string;
  macOptionIsMeta: boolean;
  scrollback: number;
  allowProposedApi: boolean;
  theme: {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
  };
}

interface XtermBufferLine {
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

interface XtermTerminal {
  rows: number;
  cols: number;
  options: { fontFamily: string };
  buffer: {
    active: {
      baseY: number;
      cursorY: number;
      cursorX: number;
      getLine(y: number): XtermBufferLine | undefined;
    };
  };
  refresh(start: number, end: number): void;
  loadAddon(addon: XtermFitAddon): void;
  open(parent: HTMLElement): void;
  writeln(data: string): void;
  write(data: string): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  onData(handler: (data: string) => void): void;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  paste(data: string): void;
  reset(): void;
  focus(): void;
  dispose(): void;
}

interface XtermFitAddon {
  fit(): void;
}

interface HarnessConsoleOptions {
  cwd?: string | null;
  command?: string;
  env?: Record<string, string>;
}

/**
 * An agent process (PTY host + xterm instance), independent of where it is displayed.
 * It can be attached to / detached from DOM elements without losing the process —
 * needed for Canvas, which unloads cards that are off-screen.
 */
class HarnessConsole {
  plugin: FaustPlugin;
  cwd: string | null;
  env: Record<string, string>;
  pendingCommand: string | null;
  host: ChildProcessWithoutNullStreams | null;
  term: XtermTerminal | null;
  fit: XtermFitAddon | null;
  exited: boolean;
  disposed: boolean;
  lastActive: number;
  parentEl: HTMLElement | null;
  onDispose: (() => void) | null;
  onReveal: (() => void) | null;
  el: HTMLElement;
  resizeObserver: ResizeObserver | null;
  lastSize: boolean | null;

  constructor(plugin: FaustPlugin, { cwd, command, env }: HarnessConsoleOptions = {}) {
    this.plugin = plugin;
    this.cwd = cwd ?? null;
    this.env = env ?? {};
    this.pendingCommand = command || null;
    this.host = null;
    this.term = null;
    this.fit = null;
    this.exited = false;
    this.disposed = false;
    this.lastActive = Date.now();
    this.parentEl = null;
    this.onDispose = null;
    // Called by the harness card when the user reveals its session
    this.onReveal = null;
    this.el = createDiv({ cls: "faust-harness-xterm" });
    this.resizeObserver = null;
    this.lastSize = null;
  }

  /** Shows the agent console inside parentEl (creates xterm the first time). */
  attach(parentEl: HTMLElement): void {
    if (this.disposed) return;
    this.detach();
    this.parentEl = parentEl;
    parentEl.appendChild(this.el);
    if (!this.term) this.createTerm();
    else this.term.refresh(0, this.term.rows - 1);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(parentEl);
    this.resize();

    if (!this.host && !this.exited) this.startShell();
  }

  /** Removes the agent console from the DOM, keeping the shell alive. */
  detach(): void {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.resizeObserver = null;
    this.parentEl = null;
    this.el.detach();
  }

  isAttached(): boolean {
    return !!this.parentEl && this.el.isConnected;
  }

  createTerm(): void {
    const loaded = this.plugin.loadXterm()!;
    const Terminal = loaded.Terminal as new (options: XtermOptions) => XtermTerminal;
    const FitAddon = loaded.FitAddon as new () => XtermFitAddon;
    const css: CSSStyleDeclaration = getComputedStyle(document.body);
    const cssVar = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;

    const isMac: boolean = process.platform === "darwin";
    // On macOS, Obsidian's --font-monospace can resolve to a proportional/unloaded font,
    // which makes xterm's cell measurement wrong (uneven, wide letter spacing).
    const monoFallback: string = "'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace";
    const fontFamily: string = isMac
      ? monoFallback
      : `${cssVar("--font-monospace", "Consolas")}, ${monoFallback}`;

    const term: XtermTerminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontSize: this.plugin.settings.fontSize,
      fontFamily,
      letterSpacing: 0,
      lineHeight: isMac ? 1.25 : 1.1,
      fontWeight: "400",
      fontWeightBold: "600",
      macOptionIsMeta: isMac,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: cssVar("--background-primary", "#1e1e1e"),
        foreground: cssVar("--text-normal", "#dcddde"),
        cursor: cssVar("--text-accent", "#7f6df2"),
        cursorAccent: cssVar("--background-primary", "#1e1e1e"),
        selectionBackground: cssVar("--text-selection", "rgba(127,109,242,0.35)"),
      },
    });
    this.term = term;
    const fit: XtermFitAddon = new FitAddon();
    this.fit = fit;
    term.loadAddon(fit);
    term.open(this.el);

    // Re-measure the character cell once fonts are ready
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (!this.term) return;
        this.term.options.fontFamily = fontFamily;
        this.resize();
      });
    }

    // Ctrl+C copies when there is a selection; Ctrl+V / Ctrl+Shift+V paste
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const key: string = e.key.toLowerCase();
      if (e.ctrlKey && key === "c" && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && key === "c") return false;
      if (e.ctrlKey && key === "v") {
        e.preventDefault();
        navigator.clipboard.readText().then((text) => this.term && this.term.paste(text));
        return false;
      }
      return true;
    });

    term.onData((data) => {
      this.lastActive = Date.now();
      if (this.host) this.send({ t: "i", d: data });
      else if (this.exited) this.startShell();
    });
  }

  startShell(): void {
    if (!this.term || !this.cwd || this.disposed) return;
    const term: XtermTerminal = this.term;
    const cwd: string = this.cwd;
    this.exited = false;

    const node: string | null = this.plugin.resolveNodePath();
    if (!node) {
      term.writeln("\x1b[31mNode.js not found. Set the Node.js path in the plugin settings.\x1b[0m");
      return;
    }

    const { cmd, args }: { cmd: string; args: string[] } = this.plugin.getShell();
    this.fitNow();
    const hostArgs: string[] = [this.plugin.hostPath(), cwd, cmd, String(term.cols), String(term.rows), ...args];

    const host: ChildProcessWithoutNullStreams = spawn(node, hostArgs, {
      cwd: this.plugin.pluginDir(),
      env: { ...process.env, ...this.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.host = host;
    this.lastSize = null;
    host.stdout.setEncoding("utf8");
    host.stderr.setEncoding("utf8");
    host.stdout.on("data", (d: string) => {
      if (this.term) this.term.write(d);
      // Initial command (e.g. from the Claude Skills plugin): send it once the shell has responded
      if (this.pendingCommand) {
        const cmd: string = this.pendingCommand;
        this.pendingCommand = null;
        setTimeout(() => this.send({ t: "i", d: cmd + "\r" }), 400);
      }
    });
    host.stderr.on("data", (d: string) => this.term && this.term.write(`\x1b[31m${d.replace(/\n/g, "\r\n")}\x1b[0m`));
    host.on("error", (err: Error) => {
      if (this.term) this.term.writeln(`\x1b[31mFailed to start the agent console: ${err.message}\x1b[0m`);
    });
    host.on("exit", () => {
      if (this.host !== host) return;
      this.host = null;
      this.exited = true;
      if (this.term) this.term.write("\r\n\x1b[2m[process exited — press any key to restart]\x1b[0m\r\n");
    });
  }

  send(msg: { t: string; d?: string; c?: number; r?: number }): void {
    if (this.host && this.host.stdin.writable) this.host.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** Stops the shell (the agent console stays visible and restarts on the next key press). */
  kill(): void {
    const host = this.host;
    if (!host) return;
    this.send({ t: "k" });
    setTimeout(() => {
      try {
        host.kill();
      } catch {}
    }, 1000);
  }

  /** Restarts the shell in the same folder. */
  restart(): void {
    const host = this.host;
    if (host) {
      this.host = null; // the "exit" handler ignores stale hosts
      try {
        host.kill();
      } catch {}
    }
    if (this.term) this.term.reset();
    this.startShell();
  }

  /** Is the shell running (process alive)? */
  isAlive(): boolean {
    return !!this.host && !!this.term;
  }

  /** Text of the cursor's line, up to the cursor position. */
  cursorLineText(): string {
    if (!this.term) return "";
    const b = this.term.buffer.active;
    const line = b.getLine(b.baseY + b.cursorY);
    return line ? line.translateToString(true, 0, b.cursorX) : "";
  }

  /** Is the shell idle at its prompt (no program running)? */
  isAtPrompt(): boolean {
    if (!this.isAlive() || this.pendingCommand) return false;
    const text: string = this.cursorLineText().trimEnd();
    // PowerShell: "PS C:\...>" | cmd: "C:\...>" | bash/zsh: "...$" "...#" "...%"
    return /^PS [^>]*>$/.test(text) || /^[A-Za-z]:\\[^>]*>$/.test(text) || /[$#%]$/.test(text);
  }

  /** Types text into the agent console; submit=true presses Enter. */
  sendText(text: string, { submit = true }: { submit?: boolean } = {}): void {
    this.lastActive = Date.now();
    this.send({ t: "i", d: text });
    if (submit) setTimeout(() => this.send({ t: "i", d: "\r" }), 150);
  }

  reveal(): void {
    if (this.onReveal) this.onReveal();
    this.focus();
  }

  focus(): void {
    if (this.term) this.term.focus();
  }

  fitNow(): void {
    const fit = this.fit;
    if (!fit || !this.el.isShown()) return;
    try {
      fit.fit();
    } catch {}
  }

  resize(): void {
    if (!this.term) return;
    const term: XtermTerminal = this.term;
    const { cols, rows }: { cols: number; rows: number } = term;
    this.fitNow();
    if (term.cols !== cols || term.rows !== rows || !this.lastSize) {
      this.lastSize = true;
      this.send({ t: "r", c: term.cols, r: term.rows });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    if (this.onDispose) this.onDispose();
    this.kill();
    this.host = null;
    if (this.term) {
      this.term.dispose();
      this.term = null;
    }
  }
}

export { HarnessConsole };
