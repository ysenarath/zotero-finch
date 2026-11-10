/* Finch — Markdown rendering for the chat window and for notes, built on markdown-it (vendor/, MIT).
 *
 * Loaded by bootstrap.js into the same scope as core.js (needs Services, rootURI). Exposes `FinchMarkdown`:
 *   chat(md)        assistant message → chat HTML (links as <a data-href>, math as span.tex for Temml)
 *   chatInline(md)  user message → inline chat HTML (no blocks; newlines kept as text for white-space: pre-wrap)
 *   note(md)        → Zotero note HTML (math as span.math / pre.math, the note editor's own format)
 * Raw HTML in the input is always escaped (html: false); the chat window is a privileged chrome document.
 */
var FinchMarkdown = (() => {
  // The UMD bundle sees `module`/`exports` in this scope and exports into them instead of onto a global.
  const mod = { exports: {} };
  Services.scriptloader.loadSubScript(rootURI + "content/vendor/markdown-it.umd.min.js", { module: mod, exports: mod.exports });
  const markdownit = mod.exports;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Math: pull TeX out of Markdown before parsing, so * _ | inside formulas are left alone.
  // Delimiters: $$…$$ and \[…\] (display), \(…\) and $…$ (inline); \$ is a literal dollar. A $…$ pair must hug
  // its content and not be followed by a digit, so "$5 and $10" stays text. Code spans/fences are untouched and
  // unclosed delimiters (e.g. mid-stream) stay plain text. Returns {text, math}: each formula in text becomes
  // <n>, with math[n] = {tex, display, src} or {lit}.
  const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\\\$|(?<!\$)\$(?![\s$])((?:\\[^\n]|[^$\\\n])*?(?:\\[^\n]|[^\s\\$]))\$(?!\d)/g;
  function extractMath(md) {
    const math = [];
    const text = String(md ?? "").split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/).map((seg, i) => (i % 2 ? seg : seg.replace(MATH_RE, (src, d1, d2, i1, i2) => {
      math.push(src === "\\$" ? { lit: "$" } : { tex: (d1 ?? d2 ?? i1 ?? i2).trim(), display: d1 != null || d2 != null, src });
      return `${math.length - 1}`;
    }))).join("");
    return { text, math };
  }

  // @[title](KEY): an item/collection mention typed in the chat input.
  function mention(state, silent) {
    if (state.src.charCodeAt(state.pos) !== 0x40 /* @ */) return false;
    const m = /^@\[([^\]\n]*)\]\(([A-Z0-9]{8})\)/.exec(state.src.slice(state.pos));
    if (!m) return false;
    if (!silent) state.push("mention", "", 0).content = m[1];
    state.pos += m[0].length;
    return true;
  }

  function create({ chat, breaks }) {
    const md = markdownit({ html: false, linkify: false, typographer: false, breaks });
    md.disable("image"); // never fetch remote images into a chrome document or a note
    md.inline.ruler.before("link", "mention", mention);
    md.renderer.rules.mention = (tokens, i) => (chat ? `<span class="mention">@${esc(tokens[i].content)}</span>` : esc("@" + tokens[i].content));
    if (chat) {
      // Only zotero:// and http(s) links become links (anything else stays text); chat.js opens them via data-href.
      md.validateLink = (url) => /^(zotero|https?):\/\//i.test(url.trim());
      md.renderer.rules.link_open = (tokens, i) => `<a data-href="${esc(tokens[i].attrGet("href"))}">`;
      md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
      md.renderer.rules.table_close = () => "</table></div>\n";
      md.core.ruler.push("finch_h4", (state) => {
        for (const t of state.tokens) if (t.type === "heading_open" || t.type === "heading_close") t.tag = "h4";
      });
    } else {
      // The note editor's table schema is just table > tr > th/td.
      for (const r of ["thead_open", "thead_close", "tbody_open", "tbody_close"]) md.renderer.rules[r] = () => "";
    }
    return md;
  }

  const chatMd = create({ chat: true, breaks: true });
  const userMd = create({ chat: true, breaks: false });
  const noteMd = create({ chat: false, breaks: true });

  const PH = /(\d+)/g;
  function render(md, input, display, inline) {
    const { text, math } = extractMath(input);
    // A display formula on a line of its own becomes its own paragraph (indent kept, so it stays in a list item).
    const src = text.replace(/^([ \t]*)(\d+)[ \t]*$/gm, (line, ind, n) => (math[n].display ? `\n${ind}${n}\n` : line));
    return md.render(src)
      .replace(/<p>(\d+)<\/p>/g, (m, n) => (math[n].display ? display(math[n]) : m))
      .replace(PH, (m, n) => math[n].lit ?? inline(math[n]));
  }

  // Formulas go into the chat as their source text; chat.js's renderMath() swaps in MathML once they are in the DOM.
  const texSpan = (x) => `<span class="tex${x.display ? " display" : ""}" data-tex="${esc(x.tex)}" title="${esc(x.src)}">${esc(x.src)}</span>`;

  return {
    chat: (md) => render(chatMd, md, (x) => `<p>${texSpan(x)}</p>`, texSpan),
    chatInline: (md) => userMd.renderInline(String(md ?? "")),
    note: (md) => render(noteMd, md, (x) => `<pre class="math">$$${esc(x.tex)}$$</pre>`, (x) => `<span class="math">$${esc(x.tex)}$</span>`),
  };
})();
