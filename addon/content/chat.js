/* Finch — chat window. All model/tool text is escaped before it touches the DOM
 * (this is a privileged chrome document). Links are rendered as <a data-href> and handled in JS. */
/* global Zotero */
(() => {
  const Z = Zotero.Finch;
  // "library" / "reader" when embedded in Zotero's right pane, "window" when popped out.
  const HOST = (window.frameElement && window.frameElement.dataset.host) || "window";
  document.documentElement.classList.add(HOST === "window" ? "in-window" : "embedded");
  const $ = (s) => document.querySelector(s);
  const log = $("#log"), input = $("#input"), pop = $("#pop");
  // The selected tab's slot (its chat + panel state; see core.js 5b) and that slot's chat, if it has one yet.
  let slot = null, session = null;
  const entryEls = new Map();
  const propEls = new Map();

  // ---------------------------------------------------------------- rendering helpers
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Markdown → HTML is markdown-it via core (markdown.js): raw HTML is escaped, links become <a data-href>,
  // and formulas go in as span.tex source text that renderMath() swaps for MathML once they are in the DOM.
  const md = (text) => Z.markdown.chat(text);

  // TeX → MathML with Temml (Gecko renders MathML natively). Cached per formula, since streaming re-renders the
  // whole message on every chunk. Formulas Temml can't parse keep showing their source.
  const mathCache = new Map();
  function renderMath(root) {
    if (typeof temml === "undefined") return;
    for (const s of root.querySelectorAll("span.tex")) {
      const display = s.classList.contains("display"), key = (display ? "D" : "I") + s.dataset.tex;
      let m = mathCache.get(key);
      if (m === undefined) {
        try { const tmp = document.createElement("span"); temml.render(s.dataset.tex, tmp, { displayMode: display, throwOnError: true }); m = tmp.firstChild; }
        catch (e) { m = null; }
        if (mathCache.size > 500) mathCache.clear();
        mathCache.set(key, m);
      }
      if (m) s.replaceChildren(m.cloneNode(true)); else s.classList.add("bad");
    }
  }

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
  function btn(label, onclick, cls) { const b = el("button", cls); b.textContent = label; b.onclick = onclick; return b; }
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "never");
  function scrollDown() { requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; }); }
  function appendToLog(node) { $(".empty")?.remove(); log.append(node); scrollDown(); }
  // A one-line note in the chat log that is not part of the session transcript.
  let noticeSeq = 0;
  const notice = (text) => renderEntry({ id: "notice" + noticeSeq++, kind: "status", text });

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-href]");
    if (a) { e.preventDefault(); Z.openZoteroURI(a.dataset.href); }
  });

  // ---------------------------------------------------------------- entries
  function toolLabel(name, input) {
    const n = name.replace(/^mcp__zotero__/, "zotero.");
    const arg = input && (input.query || input.key || input.title || input.command || input.file_path || input.pattern || input.url || input.description);
    return n + (arg ? " · " + String(arg).slice(0, 120) : "");
  }
  function ctxLine(ctx) {
    if (!ctx) return "";
    const bits = [];
    if (ctx.openPDF) bits.push(`📄 ${ctx.openPDF.title}${ctx.openPDF.page ? " p. " + ctx.openPDF.page : ""}`);
    if (ctx.selectedText) bits.push(`❝ ${ctx.selectedText.text.slice(0, 50)}…`);
    if (ctx.selectedItems && !ctx.openPDF) bits.push(`☑ ${ctx.selectedItems.length} item(s)`);
    if (ctx.collection) bits.push(`📁 ${ctx.collection.path}`);
    return bits.join(" · ");
  }

  // Shown under the last reply of each turn: continue in a new chat from this point (see core forkChat).
  function forkButton(e) {
    const b = el("button", "fork");
    b.textContent = "Fork from here";
    b.title = "Continue in a new chat from this point. This chat is kept, and later messages are left out of the new one.";
    b.onclick = () => fork(e.id);
    return b;
  }
  async function fork(entryId = null) {
    try { await Z.forkChat(slot, session, entryId); input.focus(); }
    catch (err) { notice(err.message); }
  }

  function renderEntry(e) {
    let node = entryEls.get(e.id);
    const fresh = !node;
    switch (e.kind) {
      case "user":
        node = node || el("div", "msg user");
        node.innerHTML = Z.markdown.chatInline(e.text)
          + (e.ctx?.mentioned?.length ? `<span class="att-line">${e.ctx.mentioned.map((m) => `<span class="mention">${esc(m.title || m.path || m.key)}</span>`).join(" ")}</span>` : "")
          + (ctxLine(e.ctx) ? `<span class="ctxline">${esc(ctxLine(e.ctx))}</span>` : "")
          + (e.queued ? `<span class="ctxline">Queued: sends when the current reply ends</span>` : "")
          + (e.unsent ? `<span class="ctxline">Not sent (${esc(e.unsent)})</span>` : "");
        node.classList.toggle("queued", !!e.queued);
        node.classList.toggle("unsent", !!e.unsent);
        break;
      case "assistant":
        node = node || el("div", "msg assistant");
        node.innerHTML = md(e.text);
        renderMath(node);
        node.classList.toggle("streaming", !!e.streaming);
        if (e.forkAt && !e.streaming) node.append(forkButton(e));
        break;
      case "tool":
        node = node || el("div", "tool");
        node.textContent = (e.error ? "✗ " : "› ") + toolLabel(e.name, e.input) + (e.error ? " — " + e.error.slice(0, 300) : "");
        node.classList.toggle("err", !!e.error);
        break;
      case "permission": {
        node = node || el("div", "card perm");
        const detail = e.input?.command || e.input?.file_path || JSON.stringify(e.input, null, 1);
        node.className = "card perm " + (e.status === "pending" ? "" : e.status);
        node.innerHTML = `<div class="head"><span class="title">Allow ${esc(e.tool)}?</span><span class="badge">${esc(e.status)}</span></div>`
          + (e.description ? `<div class="muted">${esc(e.description)}</div>` : "") + `<pre>${esc(String(detail).slice(0, 4000))}</pre>`;
        if (e.status === "pending") {
          const btns = el("div", "btns");
          const allow = el("button", "primary"); allow.textContent = "Allow";
          const deny = el("button"); deny.textContent = "Deny";
          allow.onclick = () => session.answerPermission(e.requestId, true);
          deny.onclick = () => session.answerPermission(e.requestId, false);
          btns.append(allow, deny); node.append(btns);
        }
        break;
      }
      default:
        node = node || el("div", "status");
        node.textContent = e.text;
        node.classList.toggle("warn", /exited|ended|Could not/.test(e.text));
        node.classList.toggle("divider", !!e.divider);
    }
    if (fresh) { entryEls.set(e.id, node); appendToLog(node); } else scrollDown();
  }

  // ---------------------------------------------------------------- proposals
  function renderProposal(p) {
    if (p.source === "explain") return; // explanations live on the PDF and in ⋯ → Explanations…
    let node = propEls.get(p.id);
    // Decided proposals live in ⋯ → Changes…; the chat only keeps a one-line note, written at decision time.
    if (p.status !== "pending" && p.status !== "applying") {
      if (node) { propEls.delete(p.id); node.remove(); decidedNote(p); }
      $("#review").hidden = !$("#review-list").children.length;
      return;
    }
    if (!node) { node = el("div", "card proposal"); propEls.set(p.id, node); }
    const pending = p.status === "pending";
    node.innerHTML = `<div class="head"><span class="title">${esc(p.title)}</span><span class="badge">${esc(p.source)} · ${esc(p.status)}</span></div>`
      + (p.rationale ? `<div class="rationale">${esc(p.rationale)}</div>` : "");
    p.changes.forEach((c, i) => {
      const row = el("div", "change");
      const cb = el("input"); cb.type = "checkbox"; cb.checked = c.status !== "rejected"; cb.disabled = !pending; cb.dataset.idx = i;
      row.append(cb, el("span", "label", esc(c.label)));
      if (c.rows) for (const r of c.rows) row.append(el("div", "row", `${esc(r.field)}: ${r.before ? `<del>${esc(r.before)}</del> → ` : ""}<ins>${esc(r.after)}</ins>`));
      if (c.detail) row.append(el("div", "detail", esc(c.detail)));
      if (!pending && c.status !== "pending") row.append(el("div", "st " + c.status, esc(c.status + (c.error ? ": " + c.error : c.result ? " · " + c.result : ""))));
      node.append(row);
    });
    const btns = el("div", "btns");
    if (pending) {
      const apply = el("button", "primary"); apply.textContent = "Apply selected";
      const reject = el("button"); reject.textContent = "Reject all";
      const fb = el("input", "feedback"); fb.placeholder = "Optional feedback to Finch";
      apply.onclick = () => { const idx = [...node.querySelectorAll("input[type=checkbox]")].filter((x) => x.checked).map((x) => +x.dataset.idx); Z.decide(p.id, idx, fb.value); };
      reject.onclick = () => Z.decide(p.id, [], fb.value);
      btns.append(apply, reject, fb);
    }
    node.append(btns);
    if (node.parentNode !== $("#review-list")) $("#review-list").append(node);
    $("#review").hidden = !$("#review-list").children.length;
    scrollDown();
  }

  function decidedNote(p) {
    const applied = p.changes.filter((c) => c.status === "applied").length;
    const failed = p.changes.filter((c) => c.status === "failed");
    const n = el("div", "status" + (failed.length ? " warn" : ""));
    n.textContent = `“${p.title}”: ${p.status}` + (applied ? ` · ${applied} change${applied === 1 ? "" : "s"}` : "")
      + (failed.length ? ` · ${failed.length} failed (${String(failed[0].error || "").slice(0, 160)})` : "");
    if (applied) {
      const link = el("span", "link"); link.textContent = "Changes"; link.setAttribute("role", "button");
      link.onclick = () => openPage("changes");
      n.append(" · ", link);
    }
    appendToLog(n);
  }

  // ---------------------------------------------------------------- header / context
  function updateHeader() {
    const st = session ? session.state : "none";
    $("#state-dot").className = "dot " + st;
    $("#state-dot").title = st;
    const ws = slot ? Z.slotWorkspace(slot) : Z.currentWorkspace();
    $("#ws-name").textContent = ws ? ws.name : "…";
    $("#ws-btn").title = ws ? `Workspace: ${ws.name}\n${ws.dir}\nClick to switch` : "";
    $("#model").textContent = session?.model ? session.model : "";
    updateSendButton();
  }

  // ---------------------------------------------------------------- composer: context + attachments
  // Context chips show what Finch will see; click one to leave it out of the next messages
  // (it comes back when the context changes). Attachment chips are papers/collections you @-mentioned,
  // attached with ＋, or dragged in from the items list.
  // Context chips sit on a line above the box; attachment chips sit inside it.
  const excluded = new Set();
  let attached = [];

  const svg = (body) => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  const ICON = {
    pdf: svg(`<path d="M4 1.5h5l3.5 3.5v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z"/><path d="M9 1.5V5h3.5"/>`),
    selection: svg(`<path d="M2.5 4h11"/><path d="M2.5 8h11"/><path d="M2.5 12h6.5"/>`),
    items: svg(`<path d="m2.5 4.3 1.3 1.3 2.2-2.3"/><path d="M8 4.5h5.5"/><path d="m2.5 10.3 1.3 1.3 2.2-2.3"/><path d="M8 10.5h5.5"/>`),
    folder: svg(`<path d="M1.5 4.5a1 1 0 0 1 1-1h3.2L7.2 5h6.3a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>`),
    x: svg(`<path d="m4 4 8 8"/><path d="m12 4-8 8"/>`),
    send: svg(`<path d="M8 13V3.5"/><path d="M3.8 7.7 8 3.5l4.2 4.2"/>`),
    stop: svg(`<rect x="3" y="3" width="10" height="10" rx="2"/>`),
  };

  function ctxParts(c) {
    const parts = [];
    if (c.openPDF) parts.push({ field: "openPDF", sig: "pdf:" + c.openPDF.attachmentKey, icon: ICON.pdf, text: `${c.openPDF.title}${c.openPDF.page ? " · p. " + c.openPDF.page : ""}` });
    if (c.selectedText) parts.push({ field: "selectedText", sig: "sel:" + c.selectedText.text.slice(0, 80), icon: ICON.selection, text: c.selectedText.text, clear: true });
    if (c.selectedItems) parts.push({ field: "selectedItems", sig: "items:" + c.selectedItems.map((i) => i.key).join(","), icon: ICON.items, text: c.selectedItems.length === 1 ? c.selectedItems[0].title : `${c.selectedItems.length} selected items` });
    if (c.collection) parts.push({ field: "collection", sig: "coll:" + c.collection.key, icon: ICON.folder, text: c.collection.path });
    return parts;
  }

  function contextForSend() {
    const c = Z.getContext(slot?.tabID);
    for (const p of ctxParts(c)) if (excluded.has(p.sig)) delete c[p.field];
    return c;
  }

  let lastChips = "";
  function refreshContext() {
    const line = $("#ctx"), box = $("#chips");
    const c = Z.getContext(slot?.tabID);
    const parts = ctxParts(c);
    for (const sig of [...excluded]) if (!parts.some((p) => p.sig === sig)) excluded.delete(sig);
    const key = JSON.stringify([parts.map((p) => p.sig + p.text), [...excluded], attached.map((a) => a.key)]);
    if (key === lastChips) return;
    lastChips = key;
    line.textContent = ""; box.textContent = "";
    for (const p of parts) {
      const off = excluded.has(p.sig);
      const chip = el("span", "chip ctx" + (off ? " off" : ""));
      chip.title = (off ? "Not sent. Click to include: " : "Sent as context. Click to leave out: ") + p.text;
      const ic = el("span", "ic", p.icon);
      const tx = el("span", "tx"); tx.textContent = p.text;
      chip.append(ic, tx);
      chip.onclick = () => { off ? excluded.delete(p.sig) : excluded.add(p.sig); refreshContext(); };
      if (p.clear) { const x = el("span", "x", ICON.x); x.title = "Clear selection"; x.onclick = (e) => { e.stopPropagation(); Z.clearSelection(); }; chip.append(x); }
      line.append(chip);
    }
    line.hidden = !parts.length;
    for (const a of attached) {
      const chip = el("span", "chip att");
      chip.title = a.label + (a.sub ? "\n" + a.sub : "");
      const ic = el("span", "ic", a.kind === "collection" ? ICON.folder : ICON.pdf);
      const tx = el("span", "tx"); tx.textContent = a.short || a.label;
      const x = el("span", "x", ICON.x); x.title = "Remove";
      x.onclick = (e) => { e.stopPropagation(); setAttached(attached.filter((y) => y.key !== a.key)); };
      chip.append(ic, tx, x);
      box.append(chip);
    }
  }

  // Every change to the attachment list goes through here.
  function setAttached(list) { attached = list; if (slot) slot.attached = list; refreshContext(); }
  function addAttachment(opt) {
    if (!opt || attached.some((a) => a.key === opt.key)) return;
    setAttached([...attached, opt]);
  }
  function emptyState() {
    if (log.children.length) return;
    log.append(el("div", "empty", `<div class="brand"><img class="logo" src="chrome://finch/content/icon20.svg" alt=""><b>Finch</b></div>`));
  }

  // ---------------------------------------------------------------- session wiring
  function showSession(s) {
    session = s;
    log.textContent = ""; entryEls.clear();
    for (const p of Z.proposals.values()) if (p.status !== "pending") propEls.delete(p.id);
    if (s) s.entries.forEach(renderEntry);
    for (const p of Z.proposals.values()) renderProposal(p);
    emptyState();
    updateHeader();
  }

  // Show a tab's slot: its chat and the panel state saved with it. Called again for the same slot when its chat
  // changes (new chat, resume, workspace switch); then the draft, attachments and page are left as they are,
  // unless `reshow` (this panel was hidden and may have missed edits made in another panel).
  let loadSeq = 0, scrollLocked = false;
  async function load(s, reshow = false) {
    const my = ++loadSeq;
    const fresh = s !== slot || reshow;
    if (fresh) slot = s;
    const ses = await Z.slotSession(s);
    if (my !== loadSeq) return;
    if (fresh || ses !== session) { scrollLocked = true; showSession(ses); }
    if (fresh) {
      input.value = s.draft || ""; histPos = -1; hidePop(); autosize();
      attached = s.attached || []; refreshContext();
      for (const p in PAGES) $("#" + p).hidden = true;
      document.body.classList.remove("managing");
      if (s.page && PAGES[s.page]) openPage(s.page, true);
    }
    // After showSession's own scroll-to-bottom: go back to where this tab was (null = the newest message).
    requestAnimationFrame(() => { scrollLocked = false; if (slot.scroll != null) log.scrollTop = slot.scroll; else log.scrollTop = log.scrollHeight; });
    updateHeader(); drawAttention();
  }
  log.addEventListener("scroll", () => {
    if (!slot || scrollLocked || !log.clientHeight) return; // ignore re-renders and hidden panes
    slot.scroll = log.scrollHeight - log.scrollTop - log.clientHeight < 30 ? null : log.scrollTop;
  });

  // "Another tab's chat needs you" bar: chats elsewhere waiting on a permission prompt.
  function drawAttention() {
    const bar = $("#attn");
    const list = slot ? Z.attention(slot) : [];
    bar.textContent = "";
    bar.hidden = !list.length;
    for (const a of list) {
      const row = el("div", "attn-row");
      const t = el("span", "t"); t.textContent = `The chat in “${a.title}” is waiting for you.`;
      row.append(t, btn("Go there", () => Z.selectTab(a.tabID)));
      bar.append(row);
    }
  }

  function onEvent(ev) {
    switch (ev.type) {
      case "slot": { const cur = Z.currentSlot(); if (cur !== slot || ev.slot === slot || ev.reason === "show") load(cur, ev.reason === "show"); break; }
      case "changes": if (!$("#changes").hidden) drawChanges(); break;
      case "workspaces": updateHeader(); if (!$("#ws-menu").hidden) drawWsMenu(); if (!$("#manage").hidden) drawManage(); break;
      case "entry": case "entry-update":
        if (ev.session === session) renderEntry(ev.entry);
        if (ev.entry.kind === "permission") drawAttention();
        break;
      case "state": if (ev.session === session) updateHeader(); break;
      case "proposal": renderProposal(ev.proposal); break;
      case "context": refreshContext(); break;
      case "explanations": if (!$("#explanations").hidden) drawExplanations(); break;
      case "explain-failed": notice(`Could not explain “${ev.title}”: ${ev.error}`); break;
      case "prefill": if (ev.host === HOST) { Z.takePrefill(HOST); insertText(ev.text); } break;
      case "focus": if (ev.host === HOST) input.focus(); break;
      case "auto": {
        const s = el("div", "status"); s.textContent = `Auto-process “${ev.title}”: ${ev.status}${ev.result ? " — " + String(ev.result).slice(0, 200) : ""}`;
        appendToLog(s); break;
      }
    }
  }

  // ---------------------------------------------------------------- composer: input, send/stop, history
  // Action commands run immediately; the others fill in an editable prompt.
  const ACTIONS = {
    explain: () => {
      try { Z.explainCurrentSelection(); }
      catch (e) { notice(e.message); }
    },
    new: async () => {
      const s = await Z.newSession(slot);
      s.add({ kind: "status", text: "New chat started. The previous one is saved: ⋯ → Manage workspaces… → Chats." });
      input.focus();
    },
    fork: () => fork(),
  };
  ACTIONS.clear = ACTIONS.new; // hidden alias for Claude Code muscle memory; not listed in QUICK
  const QUICK = [
    { cmd: "new", label: "Start a fresh chat (the current one is saved)", action: "new" },
    { cmd: "fork", label: "Continue in a copy of this chat (or use “Fork from here” on an earlier reply)", action: "fork" },
    { cmd: "compact", label: "Summarize the chat so far to save tokens (optionally add what to keep)", text: "/compact " },
    { cmd: "summarize", label: "Summarize this paper", text: "Summarize this paper: the problem, the approach, key results, and limitations." },
    { cmd: "explain", label: "Explain the selection (adds it to the PDF; see ⋯ → Explanations…)", action: "explain" },
    { cmd: "terms", label: "Highlight key terms", text: "Highlight the domain-specific terms on this page and add a comment explaining each one." },
    { cmd: "related", label: "Related papers in my library", text: "Find papers in my library related to this one and explain how each relates." },
    { cmd: "compare", label: "Compare papers", text: "Compare the attached papers: goals, methods, data, results, and limitations." },
    { cmd: "critique", label: "Reviewer critique", text: "Act as a critical reviewer of this paper: strengths, weaknesses, and open questions." },
    { cmd: "note", label: "Write a summary note", text: "Write a summary note for this paper and propose it as a child note." },
    { cmd: "organize", label: "Tag & file selected items", text: "Suggest tags and collections for the selected items using my existing vocabulary, as one proposal." },
  ];

  const isBusy = () => session?.state === "busy";
  function updateSendButton() {
    const b = $("#btn-send");
    const busy = isBusy(), stop = busy && !input.value.trim();
    if (b.classList.contains("stop") !== stop || !b.firstChild) { b.classList.toggle("stop", stop); b.innerHTML = stop ? ICON.stop : ICON.send; }
    b.title = stop ? "Stop (Esc)" : busy ? "Send (queued after the current reply)" : "Send (Enter)";
    b.setAttribute("aria-label", stop ? "Stop" : "Send");
    b.disabled = !busy && !input.value.trim();
    const hint = $("#hint");
    hint.classList.toggle("busy", busy);
    hint.textContent = busy ? "Working · Esc to stop" : "↵ send · ⇧↵ new line";
  }

  function clearInput() { input.value = ""; autosize(); hidePop(); updateSendButton(); }

  // Runs after every change to the box, so it also keeps the tab's draft.
  function autosize() {
    if (slot) slot.draft = input.value;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  }

  async function send() {
    if (!slot) return;
    const text = input.value.trim();
    if (!text) { if (isBusy()) session.interrupt(); return; }
    const compact = text.match(/^\/compact(?:\s+([\s\S]*))?$/i);
    if (compact) {
      clearInput();
      if (!session || !session.entries.some((e) => e.kind === "user")) {
        notice("Nothing to compact yet.");
      } else if (isBusy()) {
        notice("Wait for Finch to finish (or stop it) before compacting.");
      } else {
        await session.compact((compact[1] || "").trim());
      }
      return updateSendButton();
    }
    const cmd = text.match(/^\/([\w-]+)$/);
    if (cmd && ACTIONS[cmd[1].toLowerCase()]) {
      clearInput();
      return ACTIONS[cmd[1].toLowerCase()]();
    }
    clearInput(); histPos = -1;
    let ctx = contextForSend();
    const mentioned = Z.resolveKeys(attached.map((a) => a.key));
    if (mentioned.length) ctx = { ...ctx, mentioned };
    setAttached([]);
    const s = await Z.getSession(slot);
    if (s !== session) showSession(s);
    try { s.send(text, ctx); } catch (e) { notice("Send failed: " + e.message); }
    updateSendButton();
  }

  // Inserted text may carry @[label](KEY) tokens (e.g. "Ask Finch about selected"); they become chips.
  function insertText(t) {
    if (!t) return;
    t = t.replace(/@\[([^\]]*)\]\(([A-Z0-9]{8})\)\s*/g, (m, label, key) => { addAttachment(Z.attachable(key)); return ""; });
    const pos = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, pos) + t + input.value.slice(pos);
    input.focus();
    input.selectionStart = input.selectionEnd = pos + t.length;
    autosize(); updateSendButton();
  }

  // history: ↑/↓ in an empty box (or at the very start) walks your earlier messages in this chat
  let histPos = -1;
  function history() { return (session?.entries || []).filter((e) => e.kind === "user").map((e) => e.text).reverse(); }

  // ---------------------------------------------------------------- composer: @ and / popups
  let opts = [], sel = 0, tokenStart = -1, popKind = null, seq = 0;
  function hidePop() { pop.hidden = true; opts = []; tokenStart = -1; popKind = null; }

  async function onInput() {
    autosize(); updateSendButton();
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const slash = before.match(/^\/([\w-]*)$/);
    if (slash) {
      popKind = "slash"; tokenStart = 0;
      opts = QUICK.filter((q) => q.cmd.startsWith(slash[1].toLowerCase())).map((q) => ({ ...q, labelText: "/" + q.cmd, sub: q.label }));
      sel = 0;
      return opts.length ? drawPop("Quick commands") : hidePop();
    }
    const m = before.match(/(^|\s)@([^\s@\[\]()]{0,40})$/);
    if (!m) return hidePop();
    popKind = "mention"; tokenStart = pos - m[2].length - 1;
    const my = ++seq;
    const res = await Z.mentionSearch(m[2]);
    if (my !== seq) return;
    opts = res.map((o) => ({ ...o, labelText: (o.kind === "collection" ? "📁 " : "") + o.label })); sel = 0;
    if (!opts.length) return hidePop();
    drawPop(m[2].length < 2 ? "Suggestions — type to search" : "Papers & collections");
  }

  function drawPop(title) {
    pop.textContent = "";
    if (title) { const h = el("div", "pop-head"); h.textContent = title; pop.append(h); }
    opts.forEach((o, i) => {
      const d = el("div", "opt" + (i === sel ? " sel" : ""));
      const t = el("span", "t"); t.textContent = o.labelText;
      const sub = el("span", "sub"); sub.textContent = o.sub || "";
      d.append(t, sub);
      d.onmousedown = (e) => { e.preventDefault(); choose(i); };
      pop.append(d);
    });
    pop.hidden = false;
    pop.querySelector(".opt.sel")?.scrollIntoView({ block: "nearest" });
  }

  function choose(i) {
    const o = opts[i];
    const pos = input.selectionStart;
    if (popKind === "slash" && o.action) {
      clearInput();
      return ACTIONS[o.action]();
    }
    if (popKind === "slash") {
      input.value = o.text + input.value.slice(pos);
      input.selectionStart = input.selectionEnd = o.text.length;
    } else {
      const label = "@" + (o.short || o.label) + " ";
      input.value = input.value.slice(0, tokenStart) + label + input.value.slice(pos);
      input.selectionStart = input.selectionEnd = tokenStart + label.length;
      addAttachment(o);
    }
    hidePop(); input.focus(); autosize(); updateSendButton();
  }

  input.addEventListener("input", onInput);
  input.addEventListener("click", () => { if (!pop.hidden) onInput(); });
  input.addEventListener("blur", () => setTimeout(hidePop, 150));
  input.addEventListener("keydown", (e) => {
    if (!pop.hidden && opts.length) {
      if (e.key === "ArrowDown") { sel = (sel + 1) % opts.length; drawPop(pop.querySelector(".pop-head")?.textContent); e.preventDefault(); return; }
      if (e.key === "ArrowUp") { sel = (sel - 1 + opts.length) % opts.length; drawPop(pop.querySelector(".pop-head")?.textContent); e.preventDefault(); return; }
      if (e.key === "Enter" || e.key === "Tab") { choose(sel); e.preventDefault(); return; }
      if (e.key === "Escape") { hidePop(); e.preventDefault(); return; }
    }
    if (e.key === "Escape" && isBusy()) { e.preventDefault(); session.interrupt(); return; }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && (input.value === "" || histPos >= 0) && input.selectionStart === 0) {
      const h = history();
      if (!h.length) return;
      histPos = e.key === "ArrowUp" ? Math.min(histPos + 1, h.length - 1) : histPos - 1;
      input.value = histPos >= 0 ? h[histPos] : "";
      input.selectionStart = input.selectionEnd = 0;
      autosize(); updateSendButton(); e.preventDefault(); return;
    }
    if (e.key === "Backspace" && input.value === "" && attached.length) { setAttached(attached.slice(0, -1)); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  // drag papers from Zotero's items list (or a collection) into the composer to attach them
  const composer = $("#composer");
  composer.addEventListener("dragover", (e) => {
    if (["zotero/item", "zotero/collection"].some((t) => e.dataTransfer.types.includes(t))) { e.preventDefault(); composer.classList.add("drop"); }
  });
  composer.addEventListener("dragleave", () => composer.classList.remove("drop"));
  composer.addEventListener("drop", (e) => {
    composer.classList.remove("drop");
    const ids = e.dataTransfer.getData("zotero/item");
    const colls = e.dataTransfer.getData("zotero/collection");
    if (!ids && !colls) return;
    e.preventDefault();
    for (const id of (ids || "").split(",").filter(Boolean)) addAttachment(Z.attachable(parseInt(id)));
    for (const id of (colls || "").split(",").filter(Boolean)) { const c = Zotero.Collections.get(parseInt(id)); if (c) addAttachment(Z.attachable(c.key)); }
    input.focus();
  });

  $("#btn-send").onclick = send;
  $("#btn-at").onclick = () => { const p = input.selectionStart ?? input.value.length; const pre = p && !/\s/.test(input.value[p - 1]) ? " @" : "@"; insertText(pre); onInput(); };
  $("#btn-slash").onclick = () => { if (!input.value.startsWith("/")) { input.value = "/" + input.value; input.selectionStart = input.selectionEnd = 1; } input.focus(); onInput(); };
  $("#btn-attach").onclick = () => {
    const items = Z.librarySelection();
    if (!items.length) return notice("Select papers in the library first (or drag them here).");
    items.forEach((i) => addAttachment(Z.attachable(i.key)));
    input.focus();
  };
  // ---------------------------------------------------------------- buttons
  $("#btn-new").onclick = async () => { await Z.newSession(slot); input.focus(); };
  $("#btn-pop").onclick = () => Z.popOut();
  $("#btn-dock").onclick = () => { Z.setSidebar(true); window.close(); };
  document.addEventListener("keydown", (e) => {
    if (Z.matchesShortcut(e)) { e.preventDefault(); Z.toggleChat(); }
  });
  $("#btn-menu").onclick = (e) => { e.stopPropagation(); $("#menu").hidden = !$("#menu").hidden; };
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#menu")) $("#menu").hidden = true;
    if (!e.target.closest("#ws-menu") && !e.target.closest("#ws-btn")) $("#ws-menu").hidden = true;
  });
  $("#opt-auto").checked = Z.autoEnabled();
  $("#opt-auto").onchange = (e) => Z.setAuto(e.target.checked);
  $("#btn-terminal").onclick = () => {
    Zotero.Utilities.Internal.copyTextToClipboard(Z.terminalSetup());
    notice("Copied. Run it once in a terminal; then `claude` anywhere (terminal, VS Code) can use your Zotero library and send proposals here for review.");
  };
  $("#btn-folder").onclick = async () => {
    const dir = Z.slotWorkspace(slot).dir;
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    Zotero.File.reveal(dir);
  };
  $("#btn-undo").onclick = async () => {
    $("#menu").hidden = true;
    const last = (await Z.changeLog()).find((r) => r.undo?.length && !r.undone);
    if (!last) return notice("Nothing to undo.");
    if (!confirm(`Undo “${last.title}”?`)) return;
    try { const r = await Z.undoChange(last.uid); notice(`Undid “${last.title}”` + (r.skipped ? ` (${r.skipped} part(s) skipped: edited or removed since)` : "")); }
    catch (e) { alert(e.message); }
  };

  // ---------------------------------------------------------------- ⋯ menu pages
  // Workspaces, Changes and Explanations each cover the chat log; at most one is open at a time.
  const PAGES = { manage: drawManage, changes: drawChanges, explanations: drawExplanations };
  // The open page is part of the tab's slot (restoring = showing a slot's saved page, nothing to save).
  function openPage(id, restoring) {
    for (const p in PAGES) $("#" + p).hidden = p !== id;
    document.body.classList.add("managing");
    if (!restoring && slot) Z.setSlotPage(slot, id);
    PAGES[id]();
  }
  function closePage(id) {
    $("#" + id).hidden = true;
    if (Object.keys(PAGES).every((p) => $("#" + p).hidden)) {
      document.body.classList.remove("managing");
      if (slot && slot.page) Z.setSlotPage(slot, null);
    }
  }

  // ---------------------------------------------------------------- explanations on the open paper (⋯ → Explanations…)
  let explKey = null, explSeq = 0;
  const openPDFKey = () => Z.getContext(slot?.tabID).openPDF?.attachmentKey || null;
  $("#btn-explanations").onclick = () => { $("#menu").hidden = true; openPage("explanations"); };
  $("#btn-expl-back").onclick = () => closePage("explanations");
  async function drawExplanations() {
    const my = ++explSeq;
    explKey = openPDFKey();
    const data = await Z.paperExplanations().catch((e) => { Zotero.logError(e); return null; });
    if (my !== explSeq) return;
    const list = $("#expl-list");
    list.replaceChildren();
    if (!data) { $("#expl-paper").textContent = ""; list.append(el("div", "muted", "Open a PDF to see its explanations.")); return; }
    $("#expl-paper").textContent = data.title;
    if (!data.items.length) { list.append(el("div", "muted", "No explanations on this paper yet. Select text in the PDF and press the bulb.")); return; }
    for (const x of data.items) {
      const card = el("div", "ws-card expl");
      const page = el("div", "page"); page.textContent = x.pageLabel ? "p. " + x.pageLabel : "";
      const passage = el("div", "passage"); passage.textContent = x.text; passage.title = "Click to show all";
      passage.onclick = () => passage.classList.toggle("open");
      const comment = el("div", "comment" + (x.pending ? " pending" : "")); comment.textContent = x.pending ? "Explaining…" : x.comment;
      const btns = el("div", "btns");
      btns.append(btn("Show", () => Z.showAnnotation(x.attachmentID, x.key).catch((e) => alert(e.message))));
      if (!x.pending) {
        btns.append(btn("Ask", () => {
          closePage("explanations");
          insertText(`About the passage${x.pageLabel ? " on p. " + x.pageLabel : ""} “${x.text.replace(/\s+/g, " ").trim()}”, which you explained as “${x.comment.trim()}”: `);
        }));
        btns.append(btn("Undo", async () => {
          if (!confirm("Remove this explanation and its underline?")) return;
          try { await Z.undoExplanation(x.key); } catch (e) { alert(e.message); }
        }));
      }
      card.append(page, passage, comment, btns);
      list.append(card);
    }
  }

  // ---------------------------------------------------------------- ⋯ → Changes… (from the audit log, survives restarts)
  $("#btn-history").onclick = () => { $("#menu").hidden = true; openPage("changes"); };
  $("#btn-changes-back").onclick = () => closePage("changes");
  $("#btn-changes-log").onclick = async () => {
    const f = Z.changesFile();
    if (await IOUtils.exists(f)) Zotero.File.reveal(f); else alert("No changes recorded yet.");
  };
  async function drawChanges() {
    const list = $("#changes-list");
    const recs = await Z.changeLog();
    list.replaceChildren();
    if (!recs.length) { list.append(el("div", "muted", "No changes yet. Everything Finch applies to your library shows up here, with undo.")); return; }
    let day = "";
    for (const r of recs) {
      const d = new Date(r.ts);
      const dayLabel = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      if (dayLabel !== day) { day = dayLabel; list.append(el("div", "day", esc(day))); }
      const card = el("div", "ws-card" + (r.undone ? " undone" : ""));
      const head = el("div", "head");
      head.append(el("span", "name", esc(r.title)), el("span", "badge", esc(r.source)));
      const meta = el("div", "meta", esc(d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + " · " + r.changes.length + " change" + (r.changes.length === 1 ? "" : "s")
        + (r.undone ? " · undone" + (r.skipped ? ` (${r.skipped} skipped)` : "") : "")));
      const ul = el("ul", "ch");
      for (const c of r.changes.slice(0, 6)) ul.append(el("li", null, esc(c)));
      if (r.changes.length > 6) ul.append(el("li", "muted", `… and ${r.changes.length - 6} more`));
      card.append(head, meta, ul);
      if (!r.undone) {
        const btns = el("div", "btns");
        if (r.undo?.length) {
          btns.append(btn("Undo", async () => {
            if (!confirm(`Undo “${r.title}”?\n\nFields you have edited since are left as they are.`)) return;
            try { const res = await Z.undoChange(r.uid); if (res.skipped) alert(`Undone. ${res.skipped} part(s) were skipped because they were edited or removed since.`); }
            catch (e) { alert(e.message); }
            drawChanges();
          }));
        } else btns.append(el("span", "meta", "No undo recorded (made before change history existed)"));
        card.append(btns);
      }
      list.append(card);
    }
  }

  // ---------------------------------------------------------------- workspaces
  async function switchTo(id) {
    if (session && session.state === "busy" && !confirm("Finch is still working. Switch workspace anyway? This chat is saved and can be resumed.")) return;
    await Z.switchWorkspace(id, slot);
    $("#ws-menu").hidden = true;
    closePage("manage");
    input.focus();
  }

  function drawWsMenu() {
    const m = $("#ws-menu");
    m.textContent = "";
    const cur = Z.slotWorkspace(slot);
    for (const ws of Z.listWorkspaces().slice(0, 10)) {
      const b = el("button", "ws-item" + (ws.id === cur?.id ? " current" : ""));
      const n = el("span"); n.textContent = (ws.id === cur?.id ? "✓ " : "") + ws.name;
      const meta = el("span", "muted"); meta.textContent = ws.chatCount ? `${ws.chatCount} chat${ws.chatCount > 1 ? "s" : ""}` : "";
      b.append(n, meta);
      b.onclick = () => switchTo(ws.id);
      m.append(b);
    }
    m.append(el("div", "sep"));
    const row = el("div", "new-inline");
    const inp = el("input"); inp.placeholder = "New workspace…";
    const go = async () => { if (!inp.value.trim()) return; const ws = await Z.createWorkspace(inp.value); await switchTo(ws.id); };
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } };
    row.append(inp, btn("Add", go));
    m.append(row, btn("Manage workspaces…", () => { m.hidden = true; openPage("manage"); }));
  }
  $("#ws-btn").onclick = (e) => { e.stopPropagation(); const m = $("#ws-menu"); m.hidden = !m.hidden; if (!m.hidden) drawWsMenu(); };

  $("#btn-manage").onclick = () => { $("#menu").hidden = true; openPage("manage"); };
  $("#btn-back").onclick = () => closePage("manage");
  $("#opt-archived").onchange = () => drawManage();
  $("#btn-create").onclick = async () => {
    const i = $("#new-ws-name");
    if (!i.value.trim()) return i.focus();
    await Z.createWorkspace(i.value); i.value = "";
  };
  $("#new-ws-name").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $("#btn-create").click(); } };

  // A workspace's saved chats (⋯ → Manage workspaces… → Chats), newest first.
  async function drawChats(ws, box) {
    box.textContent = "Loading…";
    const cs = await Z.listChats(ws.id);
    box.textContent = cs.length ? "" : "No saved chats yet.";
    for (const c of cs) {
      const row = el("div", "chat");
      const t = el("span", "t"); t.textContent = c.title || "(untitled)"; t.title = c.title || "";
      const d = el("span", "d"); d.textContent = `${c.messages} msg · ${fmtDate(c.updated)}`;
      const here = session && session.sessionId === c.sessionId;
      const resume = btn(Z.isChatOpen(c.sessionId) ? "Open here" : "Resume", async () => { await Z.resumeChat(ws.id, c.sessionId, slot); closePage("manage"); });
      const del = btn("Delete", async () => {
        if (!confirm(`Delete “${c.title || "(untitled)"}”?\n\nThis removes the chat and its Claude Code transcript. It can't be undone.`)) return;
        try { await Z.deleteChat(ws.id, c.sessionId); } catch (e) { return alert(e.message); }
        drawChats(ws, box);
      }, "danger");
      row.append(t, d, here ? el("span", "d", "open") : resume, del);
      box.append(row);
    }
  }

  function drawManage() {
    const list = $("#ws-list");
    list.textContent = "";
    const cur = Z.slotWorkspace(slot);
    for (const ws of Z.listWorkspaces({ archived: $("#opt-archived").checked })) {
      const card = el("div", "ws-card" + (ws.id === cur?.id ? " current" : "") + (ws.archived ? " archived" : ""));
      const name = el("div", "name"); name.textContent = ws.name + (ws.id === cur?.id ? "  (current)" : "") + (ws.archived ? "  (archived)" : "");
      const meta = el("div", "meta"); meta.textContent = `${ws.chatCount || 0} chats · last used ${fmtDate(ws.lastUsed)} · created ${fmtDate(ws.created)}`;
      const btns = el("div", "btns");
      const chats = el("div", "chats"); chats.hidden = true;
      if (!ws.archived && ws.id !== cur?.id) btns.append(btn("Open", () => switchTo(ws.id), "primary"));
      btns.append(btn("Chats", () => {
        chats.hidden = !chats.hidden;
        if (!chats.hidden) drawChats(ws, chats);
      }));
      btns.append(btn("Rename", () => {
        const inp = el("input", "rename"); inp.value = ws.name;
        const save = async () => { await Z.renameWorkspace(ws.id, inp.value); };
        inp.onkeydown = (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") drawManage(); };
        inp.onblur = save;
        name.replaceWith(inp); inp.focus(); inp.select();
      }));
      btns.append(btn("CLAUDE.md", () => Zotero.launchFile(PathUtils.join(ws.dir, "CLAUDE.md"))));
      btns.append(btn("Folder", () => Zotero.File.reveal(ws.dir)));
      btns.append(btn(ws.archived ? "Restore" : "Archive", () => Z.archiveWorkspace(ws.id, !ws.archived).catch((e) => alert(e.message))));
      card.append(name, meta, btns, chats);
      list.append(card);
    }
  }

  // ---------------------------------------------------------------- lifecycle
  Z.on(onEvent);
  window.addEventListener("unload", () => { Z.off(onEvent); clearInterval(timer); });
  const hiddenInPane = () => HOST !== "window" && window.frameElement?.parentElement?.hidden;
  const timer = setInterval(() => {
    if (hiddenInPane() || !slot) return;
    if (Z.currentSlot() !== slot) return load(Z.currentSlot()); // missed a tab switch
    refreshContext(); if (!session) updateHeader();
    if (!$("#explanations").hidden && openPDFKey() !== explKey) drawExplanations();
  }, 1500);
  load(Z.currentSlot()).then(() => {
    insertText(Z.takePrefill(HOST));
    updateSendButton();
    if (HOST === "window") input.focus();
  });
})();
