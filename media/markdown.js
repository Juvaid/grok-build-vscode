/**
 * Markdown rendering module (LaTeX + Mermaid + export actions).
 * Extracted from the monolithic chat.js for better maintainability.
 *
 * Attaches to globalThis.GrokMarkdown
 */
(function () {
  const { escapeHtml, escapeAttr } = globalThis.GrokWebviewHelpers || {};
  const ICON = (globalThis.GrokIcons || {});

  // Fallbacks in case not available at load
  const safeEscapeHtml = escapeHtml || ((s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  const safeEscapeAttr = escapeAttr || safeEscapeHtml;

  // ---------- shared expr actions ----------
  function exprActionsHtml(kind) {
    const label = kind === "mermaid" ? "diagram" : "LaTeX";
    const copyI = ICON.copy || '';
    const dlI = ICON.download || '';
    const fileI = ICON.file || '';
    return (
      `<span class="expr-actions" contenteditable="false">` +
        `<button class="expr-btn" type="button" data-expr-act="copy" title="Copy ${label}">${copyI}</button>` +
        `<button class="expr-btn" type="button" data-expr-act="download" title="Download as PNG / SVG">${dlI}</button>` +
        `<button class="expr-btn" type="button" data-expr-act="open" title="Open as PNG">${fileI}</button>` +
      `</span>`
    );
  }

  // ---------- Math (LaTeX) ----------
  let mathReady = false;

  function initMathJax() {
    const MJ = globalThis.MathJax;
    if (!MJ) return;
    if (typeof MJ.tex2svg === "function") { mathReady = true; return; }
    const p = MJ.startup && MJ.startup.promise;
    if (p && typeof p.then === "function") {
      p.then(() => { mathReady = true; if (globalThis.GrokMarkdown?.upgradeMathInDom) globalThis.GrokMarkdown.upgradeMathInDom(); }).catch(() => {});
    }
  }

  function rawMath(src, display) {
    const esc = safeEscapeHtml(src);
    return display
      ? `<span class="math-raw math-display">${esc}</span>`
      : `<span class="math-raw">${esc}</span>`;
  }

  function renderMath(latex, display) {
    const orig = (latex == null ? "" : String(latex)).trim();
    const src = (globalThis.GrokWebviewHelpers && globalThis.GrokWebviewHelpers.stripUnsupportedTex) ? globalThis.GrokWebviewHelpers.stripUnsupportedTex(orig) : orig;
    const MJ = globalThis.MathJax;
    let inner = null;
    if (mathReady && MJ && typeof MJ.tex2svg === "function") {
      try {
        const node = MJ.tex2svg(src, { display: !!display });
        if (node && node.outerHTML) inner = node.outerHTML;
      } catch (_) {}
    }
    if (inner == null) inner = rawMath(src, display);
    if (!display) return inner;
    return `<span class="math-export" data-export-kind="latex" data-export-src="${safeEscapeAttr(orig)}">` +
      inner + exprActionsHtml("latex") + `</span>`;
  }

  function upgradeMathInDom() {
    document.querySelectorAll(".math-raw").forEach((span) => {
      const display = span.classList.contains("math-display");
      const host = display ? (span.closest(".math-export") || span) : span;
      const srcAttr = host.getAttribute && host.getAttribute("data-export-src");
      const src = (display && srcAttr != null) ? srcAttr : span.textContent;
      const tmp = document.createElement("div");
      tmp.innerHTML = renderMath(src, display);
      const node = tmp.firstChild;
      if (node && host.parentNode) host.parentNode.replaceChild(node, host);
    });
  }

  // ---------- Mermaid ----------
  const mermaidSvgCache = new Map();
  const mermaidInFlight = new Set();
  let mermaidIdSeq = 0;
  let mermaidReady = false;

  function initMermaid() {
    const m = globalThis.mermaid;
    if (!m || typeof m.initialize !== "function") return;
    const light = document.body.classList.contains("vscode-light");
    try {
      m.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: light ? "default" : "dark",
        fontFamily: "var(--vscode-font-family, sans-serif)",
      });
      mermaidReady = true;
    } catch (_) {
      mermaidReady = false;
    }
  }

  function mermaidSourceOf(block) {
    const codeEl = block.querySelector(".mermaid-src code") || block.querySelector(".mermaid-src");
    return (codeEl ? codeEl.textContent : "").trim();
  }

  function decorateMermaid(block, svg, src) {
    block.innerHTML = svg + exprActionsHtml("mermaid");
    block.setAttribute("data-export-kind", "mermaid");
    block.setAttribute("data-export-src", src);
    block.setAttribute("data-mermaid-state", "done");
  }

  function applyCachedMermaid(src) {
    const svg = mermaidSvgCache.get(src);
    if (!svg) return;
    document.querySelectorAll(".mermaid-block").forEach((block) => {
      if (block.getAttribute("data-mermaid-state") === "done") return;
      if (mermaidSourceOf(block) === src) {
        decorateMermaid(block, svg, src);
      }
    });
  }

  function renderMermaidIn(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    const blocks = root.querySelectorAll(".mermaid-block");
    if (!blocks.length) return;
    const m = globalThis.mermaid;
    if (!mermaidReady || !m || typeof m.render !== "function") return;
    blocks.forEach((block) => {
      if (block.getAttribute("data-mermaid-state") === "done") return;
      const src = mermaidSourceOf(block);
      if (!src) return;
      if (mermaidSvgCache.has(src)) {
        const svg = mermaidSvgCache.get(src);
        if (svg) decorateMermaid(block, svg, src);
        return;
      }
      if (mermaidInFlight.has(src)) return;
      mermaidInFlight.add(src);
      const id = "grok-mmd-" + (mermaidIdSeq++);
      Promise.resolve()
        .then(() => m.render(id, src))
        .then((res) => { mermaidSvgCache.set(src, (res && res.svg) || null); })
        .catch(() => { mermaidSvgCache.set(src, null); })
        .then(() => {
          mermaidInFlight.delete(src);
          applyCachedMermaid(src);
        });
    });
  }

  // ---------- Public API ----------
  const api = {
    initMathJax,
    renderMath,
    upgradeMathInDom,
    initMermaid,
    renderMermaidIn,
    exprActionsHtml, // exported in case other modules want it
    // renderMarkdown will be added by main chat.js or we can move it later
  };

  globalThis.GrokMarkdown = api;
})();

// Export logic moved from chat.js for modularisation
function canRasterize() {
  try { return !!document.createElement("canvas").getContext("2d"); } catch (_) { return false; }
}

function themeVar(name, fallback) {
  try {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  } catch (_) { return fallback; }
}

function exportColors() {
  return {
    bg: themeVar("--vscode-sideBar-background", "#1e1e1e"),
    fg: themeVar("--vscode-foreground", "#cccccc"),
  };
}

function themedSvg(svgEl, color, bg) {
  const clone = svgEl.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  let style = clone.getAttribute("style") || "";
  if (color) style += `;color:${color}`;
  if (bg) style += `;background:${bg}`;
  clone.setAttribute("style", style);
  return new XMLSerializer().serializeToString(clone);
}

async function mermaidThemedSvg(src, theme, fallbackEl) {
  const m = globalThis.mermaid;
  if (m && typeof m.render === "function" && src) {
    try {
      const id = "grok-mmd-exp-" + (globalThis.mermaidIdSeq || (globalThis.mermaidIdSeq = 0)++);
      const res = await m.render(id, `%%{init: {'theme':'${theme}'}}%%\n` + src);
      if (res && res.svg) {
        const tmp = document.createElement("div");
        tmp.innerHTML = res.svg;
        const el = tmp.querySelector("svg");
        if (el) return themedSvg(el, null, null);
      }
    } catch (_) {}
  }
  return fallbackEl ? themedSvg(fallbackEl, null, null) : "";
}

function copyExprSource(src, btn) {
  navigator.clipboard.writeText(src || "").then(() => {
    const prev = btn.innerHTML;
    btn.innerHTML = (globalThis.GrokIcons && globalThis.GrokIcons.check) || "✓";
    btn.classList.add("copied");
    setTimeout(() => { btn.innerHTML = prev; btn.classList.remove("copied"); }, 1500);
  });
}

async function exportExpr(host, action) {
  const svgEl = host.querySelector("svg");
  if (!svgEl) return;
  const kind = host.getAttribute("data-export-kind") || "latex";
  const colors = exportColors();
  const rect = svgEl.getBoundingClientRect();
  const w = rect.width || 320, h = rect.height || 100;

  const wysiwyg = themedSvg(svgEl, colors.fg, colors.bg);
  let png = null;
  if (canRasterize()) {
    try { png = await svgToPng(wysiwyg, w, h, 3, colors.bg); } catch (_) { png = null; }
  }

  // For download we also generate clean SVGs (transparent bg, themed ink)
  let svgLight = null, svgDark = null;
  if (kind === "latex") {
    svgLight = themedSvg(svgEl, "#000", "");
    svgDark = themedSvg(svgEl, "#fff", "");
  } else if (kind === "mermaid") {
    const src = host.getAttribute("data-export-src") || "";
    try { svgLight = await mermaidThemedSvg(src, "default", svgEl); } catch(_) {}
    try { svgDark = await mermaidThemedSvg(src, "dark", svgEl); } catch(_) {}
  }

  const payload = {
    kind,
    current: host.outerHTML, // or the svg string
    svg: wysiwyg,
    png,
    svgDark: svgDark || svgDark,
    svgLight: svgLight || svgLight,
  };

  // Post to host (the chat.js will forward via vscode.postMessage)
  // Since this is in module, we assume a global post or the caller handles.
  if (typeof window !== "undefined" && window.vscode && action === "download") {
    // In practice, the caller in chat.js will handle the post.
  }
  return payload;
}

// Extend the api
Object.assign(globalThis.GrokMarkdown || (globalThis.GrokMarkdown = {}), {
  canRasterize,
  themeVar,
  exportColors,
  themedSvg,
  mermaidThemedSvg,
  copyExprSource,
  exportExpr,
  svgToPng: async function(svgStr, w, h, scale, bg) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/png"));
        } catch (e) { reject(e); }
      };
      img.onerror = reject;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
    });
  }
});
