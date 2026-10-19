import { MarkdownRenderChild, setIcon } from "obsidian";
import path from "node:path";

/** Minimal interface for the BlockSessions instance (avoids circular import). */
interface BlockSessionsLike {
  scheduleOrphanCheck(key: string, sourcePath: string): void;
}

/** Minimal interface covering the session surface used by the harness block. */
interface HarnessBlockSession {
  cwd?: string;
  parentEl?: HTMLElement | null;
  onReveal?: () => void;
  restart(): void;
  kill(): void;
  attach(el: HTMLElement): void;
  detach(): void;
}

/** Agent console rendered inside an agent-harness Canvas card. */
class HarnessBlockChild extends MarkdownRenderChild {
  blocks: BlockSessionsLike;
  session: HarnessBlockSession;
  key: string;
  sourcePath: string;
  body!: HTMLElement;
  unloaded: boolean = false;
  nodeObserver?: ResizeObserver | null;

  constructor(el: HTMLElement, blocks: BlockSessionsLike, session: HarnessBlockSession, key: string, sourcePath: string) {
    super(el);
    this.blocks = blocks;
    this.session = session;
    this.key = key;
    this.sourcePath = sourcePath;
  }

  onload(): void {
    const el: HTMLElement = this.containerEl;
    el.empty();
    el.addClass("faust-harness-block");

    const toolbar: HTMLElement = el.createDiv({ cls: "faust-harness-block-toolbar" });
    setIcon(toolbar.createSpan({ cls: "faust-harness-block-icon" }), "bot");
    toolbar.createSpan({ cls: "faust-harness-block-title", text: path.basename(this.session.cwd || "") || "Faust agent" });
    toolbar.setAttr("title", this.session.cwd || "");
    const button = (icon: string, label: string, onClick: () => void): void => {
      const b: HTMLButtonElement = toolbar.createEl("button", { cls: "clickable-icon faust-harness-block-button", attr: { "aria-label": label } });
      setIcon(b, icon);
      this.registerDomEvent(b, "click", (e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      });
    };
    button("rotate-ccw", "Restart agent session", () => this.session.restart());
    button("square", "Stop agent session", () => this.session.kill());

    this.body = el.createDiv({ cls: "faust-harness-block-body" });

    // Keep Canvas from dragging/selecting/zooming or deleting the card while the agent console is in use.
    // The toolbar remains the handle for dragging and editing the card.
    for (const ev of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "keydown", "keyup", "contextmenu"] as const) {
      this.registerDomEvent(this.body, ev, (e: Event) => e.stopPropagation());
    }

    this.session.onReveal = (): void => el.scrollIntoView({ block: "nearest" });
    whenConnected(el, (): void => {
      if (this.unloaded) return;
      this.fitToCanvasNode();
      this.session.attach(this.body);
    });
  }

  /** In Canvas, makes the agent console fill the card's full height. */
  fitToCanvasNode(): void {
    const nodeEl: Element | null = this.containerEl.closest(".canvas-node-content");
    if (!nodeEl) return;
    this.containerEl.addClass("is-canvas");
    const apply = (): void => { this.containerEl.style.height = `${nodeEl.clientHeight}px`; };
    apply();
    this.nodeObserver = new ResizeObserver(apply);
    this.nodeObserver.observe(nodeEl);
  }

  onunload(): void {
    this.unloaded = true;
    if (this.nodeObserver) this.nodeObserver.disconnect();
    if (this.session.parentEl === this.body) this.session.detach();
    // If the block was deleted from the note/canvas, stop the agent process; if it just went off-screen, keep it alive
    this.blocks.scheduleOrphanCheck(this.key, this.sourcePath);
  }
}

/** Runs cb once el is in the document (Markdown rendering creates the element before inserting it). */
function whenConnected(el: HTMLElement, cb: () => void, tries: number = 120): void {
  if (el.isConnected) return cb();
  if (tries <= 0) return;
  requestAnimationFrame(() => whenConnected(el, cb, tries - 1));
}

export { HarnessBlockChild };
