"use strict";

const { MarkdownRenderChild, setIcon } = require("obsidian");
const path = require("path");

/** Agent console rendered inside an agent-harness Canvas card. */
class HarnessBlockChild extends MarkdownRenderChild {
  constructor(el, blocks, session, key, sourcePath) {
    super(el);
    this.blocks = blocks;
    this.session = session;
    this.key = key;
    this.sourcePath = sourcePath;
  }

  onload() {
    const el = this.containerEl;
    el.empty();
    el.addClass("faust-harness-block");

    const toolbar = el.createDiv({ cls: "faust-harness-block-toolbar" });
    setIcon(toolbar.createSpan({ cls: "faust-harness-block-icon" }), "bot");
    toolbar.createSpan({ cls: "faust-harness-block-title", text: path.basename(this.session.cwd || "") || "Faust agent" });
    toolbar.setAttr("title", this.session.cwd || "");
    const button = (icon, label, onClick) => {
      const b = toolbar.createEl("button", { cls: "clickable-icon faust-harness-block-button", attr: { "aria-label": label } });
      setIcon(b, icon);
      this.registerDomEvent(b, "click", (e) => {
        e.stopPropagation();
        onClick();
      });
    };
    button("rotate-ccw", "Restart agent session", () => this.session.restart());
    button("square", "Stop agent session", () => this.session.kill());

    this.body = el.createDiv({ cls: "faust-harness-block-body" });

    // Keep Canvas from dragging/selecting/zooming or deleting the card while the agent console is in use.
    // The toolbar remains the handle for dragging and editing the card.
    for (const ev of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "keydown", "keyup", "contextmenu"]) {
      this.registerDomEvent(this.body, ev, (e) => e.stopPropagation());
    }

    this.session.onReveal = () => el.scrollIntoView({ block: "nearest" });
    whenConnected(el, () => {
      if (this.unloaded) return;
      this.fitToCanvasNode();
      this.session.attach(this.body);
    });
  }

  /** In Canvas, makes the agent console fill the card's full height. */
  fitToCanvasNode() {
    const nodeEl = this.containerEl.closest(".canvas-node-content");
    if (!nodeEl) return;
    this.containerEl.addClass("is-canvas");
    const apply = () => (this.containerEl.style.height = `${nodeEl.clientHeight}px`);
    apply();
    this.nodeObserver = new ResizeObserver(apply);
    this.nodeObserver.observe(nodeEl);
  }

  onunload() {
    this.unloaded = true;
    if (this.nodeObserver) this.nodeObserver.disconnect();
    if (this.session.parentEl === this.body) this.session.detach();
    // If the block was deleted from the note/canvas, stop the agent process; if it just went off-screen, keep it alive
    this.blocks.scheduleOrphanCheck(this.key, this.sourcePath);
  }
}

/** Runs cb once el is in the document (Markdown rendering creates the element before inserting it). */
function whenConnected(el, cb, tries = 120) {
  if (el.isConnected) return cb();
  if (tries <= 0) return;
  requestAnimationFrame(() => whenConnected(el, cb, tries - 1));
}

module.exports = { HarnessBlockChild };
