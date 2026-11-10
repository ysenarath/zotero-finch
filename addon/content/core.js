/* Finch — core.
 *
 * Loaded by bootstrap.js into a scope that has Zotero, Services, Cc, Ci, ChromeUtils, IOUtils, PathUtils,
 * rootURI, pluginID, version. Exposes `Finch`.
 *
 *  1. Context      what the user is looking at (selected items, collection, open PDF/page, selected text)
 *  2. Library ops  read helpers + review-gated writes (proposals) with undo, My Library only
 *  3. PDF          text location in the open reader -> highlight annotations
 *  4. MCP server   Streamable-HTTP JSON-RPC at http://127.0.0.1:<port>/finch/mcp (bearer token)
 *  5. Sessions     chats; each turn runs its own `claude -p --resume` stream-json process
 *  6. Auto         Notifier observer that runs a headless Claude job on newly added items
 */
var Finch = (() => {
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

  const PREF = "extensions.finch.";
  const getPref = (k) => Zotero.Prefs.get(PREF + k, true);
  const setPref = (k, v) => Zotero.Prefs.set(PREF + k, v, true);
  const LIB = () => Zotero.Libraries.userLibraryID;
  const log = (m) => Zotero.debug("[finch] " + m);
  const HOME = Services.dirsvc.get("Home", Ci.nsIFile).path;
  const MCP_PATH = "/finch/mcp";

  const listeners = new Set();
  const emit = (ev) => { for (const l of listeners) { try { l(ev); } catch (e) { Zotero.logError(e); } } };

  // ------------------------------------------------------------------ helpers
  function token() {
    let t = getPref("token");
    if (!t) { t = Zotero.Utilities.randomString(40); setPref("token", t); }
    return t;
  }
  function checkAuth(headers) { return headers && headers.authorization === "Bearer " + token(); }
  function mcpURL() { return `http://127.0.0.1:${Zotero.Server.port}${MCP_PATH}`; }
  // Layout under workspaceRoot(): workspaces/<slug>-<id>/ (one per workspace), inbox/ (auto-processing), changes.jsonl.
  // Default is a "finch" folder in the Zotero data directory, so it travels with the library when it is moved or copied.
  function workspaceRoot() { return getPref("workspaceRoot") || PathUtils.join(Zotero.DataDirectory.dir, "finch"); }
  function workspacesDir() { return PathUtils.join(workspaceRoot(), "workspaces"); }
  function inboxDir() { return PathUtils.join(workspaceRoot(), "inbox"); }
  function changesFile() { return PathUtils.join(workspaceRoot(), "changes.jsonl"); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function ensureDir(dir) { return IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true }); }

  // ------------------------------------------------------------------ migration from Lyra (the plugin's old name)
  // Runs once at startup. Copies, never moves or deletes: the old prefs and ~/Documents/Lyra stay as a backup.
  const LEGACY = { pref: "extensions.lyra.", root: PathUtils.join(HOME, "Documents", "Lyra"), mcpPath: "/lyra/mcp", explainTag: "lyra:explain", tabSlot: "lyraSlot" };
  function migratePrefs() {
    const old = Services.prefs.getBranch(LEGACY.pref);
    for (const k of old.getChildList("")) {
      if (!old.prefHasUserValue(k) || Services.prefs.prefHasUserValue(PREF + k)) continue;
      const t = old.getPrefType(k);
      const v = t === old.PREF_BOOL ? old.getBoolPref(k) : t === old.PREF_INT ? old.getIntPref(k) : old.getStringPref(k);
      setPref(k, v);
    }
  }
  // `claude --resume` finds a session by the directory it ran in: <config>/projects/<path with non-alphanumerics as ->
  // holds <sessionId>.jsonl (the transcript) and <sessionId>/ (tool results, subagents) for each session run there.
  function claudeProjectDir(cwd) {
    const projects = PathUtils.join(Services.env.get("CLAUDE_CONFIG_DIR") || PathUtils.join(HOME, ".claude"), "projects");
    return PathUtils.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  }
  // Each workspace's session folder is copied to match the workspace's new location.
  async function migrateClaudeSessions(oldRoot, newRoot) {
    for (const dir of await IOUtils.getChildren(PathUtils.join(newRoot, "workspaces")).catch(() => [])) {
      const src = claudeProjectDir(PathUtils.join(oldRoot, "workspaces", PathUtils.filename(dir)));
      const dst = claudeProjectDir(dir);
      if (await IOUtils.exists(src) && !(await IOUtils.exists(dst))) await IOUtils.copy(src, dst, { recursive: true });
    }
  }
  async function migrateFromLyra() {
    try { migratePrefs(); } catch (e) { Zotero.logError(e); }
    if (getPref("workspaceRoot")) return; // a custom folder (set by the user, or carried over from Lyra) stays put
    const root = workspaceRoot();
    if (await IOUtils.exists(root) || !(await IOUtils.exists(LEGACY.root))) return;
    try {
      const tmp = root + ".partial"; // copy aside, then rename, so an interrupted copy is retried next start
      await IOUtils.remove(tmp, { recursive: true, ignoreAbsent: true });
      await IOUtils.copy(LEGACY.root, tmp, { recursive: true });
      await IOUtils.move(tmp, root);
      log(`copied ${LEGACY.root} to ${root}`);
      await migrateClaudeSessions(LEGACY.root, root);
    } catch (e) { Zotero.logError(e); }
  }
  // pdf.js and reader objects live in the reader's content compartment. Values that come back through promises are
  // Xray-wrapped, which hides pdf.js methods (e.g. getTextContent), so waive Xrays and copy data out.
  const W = (o) => (o && o.wrappedJSObject) || o;
  function stripHTML(h) { return String(h || "").replace(/<\/t[dh]>/gi, " ").replace(/<(br|\/p|\/li|\/h\d|\/tr|\/pre)[^>]*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim(); }

  // Keyboard shortcut from the `shortcut` pref, e.g. "accel+alt+L" (accel = ⌘ on macOS, Ctrl elsewhere).
  // An empty pref disables it. Letters and digits match by physical key, since Option changes e.key on macOS.
  const DEFAULT_SHORTCUT = "accel+alt+L";
  function shortcut() {
    const spec = getPref("shortcut") ?? DEFAULT_SHORTCUT;
    if (!String(spec).trim()) return null;
    const parts = String(spec).split("+").map((p) => p.trim()).filter(Boolean);
    const key = parts.pop();
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    const accel = mods.has("accel");
    return {
      key, alt: mods.has("alt") || mods.has("option"), shift: mods.has("shift"),
      meta: mods.has("meta") || mods.has("cmd") || (accel && Zotero.isMac),
      ctrl: mods.has("ctrl") || mods.has("control") || (accel && !Zotero.isMac),
    };
  }
  function matchesShortcut(e) {
    const s = shortcut();
    if (!s || e.metaKey !== s.meta || e.ctrlKey !== s.ctrl || e.altKey !== s.alt || e.shiftKey !== s.shift) return false;
    if (/^[a-z]$/i.test(s.key)) return e.code === "Key" + s.key.toUpperCase();
    if (/^\d$/.test(s.key)) return e.code === "Digit" + s.key;
    return e.key.toLowerCase() === s.key.toLowerCase();
  }
  function shortcutLabel() {
    const s = shortcut();
    if (!s) return "";
    const key = s.key.length === 1 ? s.key.toUpperCase() : s.key;
    if (Zotero.isMac) return (s.ctrl ? "⌃" : "") + (s.alt ? "⌥" : "") + (s.shift ? "⇧" : "") + (s.meta ? "⌘" : "") + key;
    return [s.ctrl && "Ctrl", s.alt && "Alt", s.shift && "Shift", s.meta && "Meta", key].filter(Boolean).join("+");
  }

  function getItem(key) {
    const it = key && Zotero.Items.getByLibraryAndKey(LIB(), String(key).trim());
    if (!it) throw new Error(`No item with key ${key} in My Library`);
    return it;
  }
  function collPath(c) {
    const parts = [];
    while (c) { parts.unshift(c.name); c = c.parentID ? Zotero.Collections.get(c.parentID) : null; }
    return parts.join(" / ");
  }
  function allCollections() { return Zotero.Collections.getByLibrary(LIB(), true).filter((c) => !c.deleted); }
  function findCollection(spec, refs = {}) {
    if (!spec) return null;
    if (refs[spec]) return refs[spec];
    const byKey = Zotero.Collections.getByLibraryAndKey(LIB(), spec);
    if (byKey && !byKey.deleted) return byKey;
    const norm = (s) => s.split("/").map((p) => p.trim()).join(" / ").toLowerCase();
    const all = allCollections();
    const byPath = all.find((c) => norm(collPath(c)) === norm(spec));
    if (byPath) return byPath;
    const byName = all.filter((c) => c.name.toLowerCase() === spec.trim().toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`Collection name "${spec}" is ambiguous; use its key or full path`);
    throw new Error(`No collection "${spec}"`);
  }
  function year(it) { const d = it.getField("date", true, true); return d ? d.slice(0, 4) : ""; }
  function brief(it) {
    const out = { key: it.key, itemType: it.itemType, title: it.getDisplayTitle() };
    if (it.isRegularItem()) {
      out.creators = it.getCreators().slice(0, 3).map((c) => c.lastName || c.name).join(", ") + (it.numCreators() > 3 ? " et al." : "");
      out.year = year(it);
    }
    if (it.parentItem) out.parentKey = it.parentItem.key;
    return out;
  }
  async function bestAttachment(it) {
    if (it.isAttachment()) return it;
    if (!it.isRegularItem()) throw new Error(`${it.key} is a ${it.itemType}, not a paper or attachment`);
    const att = await it.getBestAttachment();
    if (!att) throw new Error(`${it.key} has no attachment`);
    return att;
  }

  // ------------------------------------------------------------------ 1. context
  const ctxState = { selection: null };

  // Context = only where the user is, in the given tab (default: the selected one; a chat's tools pass its own tab):
  //   reader tab  → the open paper (+ the page that tab is on) and, if made in this PDF, the selected text
  //   library tab → the selected items and the selected collection
  function getContext(tabID) {
    const out = { library: "My Library" };
    const win = Zotero.getMainWindow();
    if (!win) return out;
    const tabs = win.Zotero_Tabs;
    tabID = tabID || tabs?.selectedID;
    out.view = !tabs || tabID === LIBRARY_TAB || !tabInfo(tabID) ? "library" : "reader";
    if (out.view === "reader") {
      const reader = Zotero.Reader.getByTabID(tabID);
      const itemID = reader?.itemID ?? tabInfo(tabID)?.data?.itemID; // an unloaded tab has no reader
      const att = itemID && Zotero.Items.get(itemID);
      if (att && att.libraryID === LIB() && att.isAttachment()) { // not note tabs
        const page = (reader && readerPage(reader)) ?? att.getAttachmentLastPageIndex();
        out.openPDF = {
          attachmentKey: att.key,
          parentKey: att.parentItem?.key,
          title: (att.parentItem || att).getDisplayTitle(),
          page: Number.isInteger(page) ? page + 1 : undefined,
        };
        const s = ctxState.selection;
        if (s && s.attachmentKey === att.key && Date.now() - s.at < 10 * 60 * 1000) {
          out.selectedText = { text: s.text.slice(0, 4000), page: s.pageIndex + 1, pageLabel: s.pageLabel };
        }
      }
      return out;
    }
    try {
      const zp = win.ZoteroPane;
      const coll = zp.getSelectedCollection();
      if (coll && coll.libraryID === LIB()) out.collection = { key: coll.key, path: collPath(coll) };
      const sel = zp.getSelectedItems().filter((i) => i.libraryID === LIB());
      if (sel.length) {
        out.selectedItems = sel.slice(0, 20).map(brief);
        if (sel.length > 20) out.selectedItemsTruncated = sel.length;
      }
    } catch (e) { /* items pane not ready */ }
    return out;
  }

  function onTextSelectionPopup(ev) {
    try {
      const { reader, doc, params, append } = ev;
      const a = W(params.annotation);
      const att = Zotero.Items.get(reader.itemID);
      if (!a || !att) return;
      // Copy out of the reader's compartment so the data stays usable after the popup closes.
      const sel = {
        text: String(a.text || ""), attachmentKey: att.key, pageIndex: W(a.position)?.pageIndex ?? 0,
        pageLabel: a.pageLabel ? String(a.pageLabel) : undefined, sortIndex: a.sortIndex ? String(a.sortIndex) : undefined,
        position: a.position ? JSON.parse(JSON.stringify(W(a.position))) : undefined, at: Date.now(),
      };
      ctxState.selection = sel;
      emit({ type: "context" });
      // Icon buttons (tooltips carry the labels), set apart from the colour dots by a thin divider.
      const SVGNS = "http://www.w3.org/2000/svg";
      const row = doc.createElement("div");
      row.style.cssText = "display:flex;gap:2px;align-items:center;justify-content:center;margin:4px 0 2px;padding-top:4px;border-top:1px solid rgba(128,128,128,.25);";
      const mk = (title, paths, onClick) => {
        const b = doc.createElement("button");
        b.title = title;
        b.setAttribute("aria-label", title);
        b.className = "toolbar-button";
        b.style.cssText = "width:28px;height:24px;padding:0;display:flex;align-items:center;justify-content:center;color:#5b5fc7;background:none;border:0;border-radius:5px;cursor:pointer;";
        b.addEventListener("mouseenter", () => { b.style.background = "rgba(128,128,128,.18)"; });
        b.addEventListener("mouseleave", () => { b.style.background = "none"; });
        const svg = doc.createElementNS(SVGNS, "svg");
        svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("viewBox", "0 0 16 16");
        for (const d of paths) {
          const path = doc.createElementNS(SVGNS, "path");
          path.setAttribute("d", d);
          path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor");
          path.setAttribute("stroke-width", "1.4"); path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
          svg.appendChild(path);
        }
        b.appendChild(svg);
        b.addEventListener("click", onClick);
        row.appendChild(b);
      };
      // lightbulb
      mk("Explain: underline this passage and add an explanation as the comment",
        ["M8 1.6a4.4 4.4 0 0 0-2.5 8c.4.3.6.7.6 1.2v.5h3.8v-.5c0-.5.2-.9.6-1.2A4.4 4.4 0 0 0 8 1.6z", "M6.3 13.4h3.4", "M6.9 14.9h2.2"],
        () => explainSelection(sel).catch((e) => Zotero.logError(e)));
      // chat bubble
      mk("Ask Finch about this selection",
        ["M3 3h10a1.5 1.5 0 0 1 1.5 1.5v5.5A1.5 1.5 0 0 1 13 11.5H7.5L4.5 14v-2.5H3A1.5 1.5 0 0 1 1.5 10V4.5A1.5 1.5 0 0 1 3 3z", "M5 6.3h6", "M5 8.6h4"],
        () => openChat({ focus: true }));
      append(row);
    } catch (e) { Zotero.logError(e); }
  }

  // ------------------------------------------------------------------ 1b. "Explain" on a reader selection
  // One click: the passage is underlined immediately (purple, comment "Explaining…", tag finch:explain), a one-shot
  // tool-less `claude -p` writes the explanation, and the comment is filled in. Nothing is added to the chat;
  // the annotations are the record, listed per paper in ⋯ → Explanations…, with undo in ⋯ → Changes…
  const EXPLAIN_TAG = "finch:explain";
  const explainPending = new Set(); // annotation keys still waiting for their explanation
  async function oneShot(prompt, cwd) {
    // --setting-sources "": no user/project settings or CLAUDE.md (not even ~/.claude/CLAUDE.md) shape the answer.
    const out = await runClaude(["-p", prompt, "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", "",
      ...modelArgs(getPref("explainModel") || getPref("model"))], cwd);
    let res;
    try { res = JSON.parse(out.slice(out.indexOf("{"))); } catch (e) { throw new Error("Claude Code returned no result: " + out.slice(-300)); }
    if (res.is_error || !res.result) throw new Error(res.result || res.subtype || "Claude Code failed");
    return String(res.result).trim();
  }

  async function pageWindow(att, sel, size = 1400) {
    try {
      const pdf = await pdfFor(att, sel.pageIndex);
      const { text } = await pageText(pdf, sel.pageIndex);
      const flat = text.replace(/\s+/g, " ");
      const probe = sel.text.replace(/\s+/g, " ").slice(0, 40);
      const at = Math.max(0, flat.indexOf(probe));
      return flat.slice(Math.max(0, at - size), at + sel.text.length + size);
    } catch (e) { return ""; }
  }

  async function explainSelection(sel) {
    if (!sel?.text || !sel.position) throw new Error("No selection");
    const att = getItem(sel.attachmentKey);
    const paper = att.parentItem || att;
    const key = Zotero.DataObjectUtilities.generateKey();
    explainPending.add(key);
    await Zotero.Annotations.saveFromJSON(att, {
      key, type: "underline", text: sel.text, comment: "Explaining…", color: COLORS.purple,
      pageLabel: sel.pageLabel, sortIndex: sel.sortIndex, position: sel.position, tags: [{ name: EXPLAIN_TAG }],
    });
    const made = Zotero.Items.getByLibraryAndKey(LIB(), key);
    if (made && !made.hasTag(EXPLAIN_TAG)) { made.addTag(EXPLAIN_TAG); await made.saveTx(); }
    const short = Zotero.Utilities.ellipsize(sel.text.replace(/\s+/g, " "), 70);
    const rec = {
      id: nextProposal++, uid: Zotero.Utilities.randomString(12), title: `Explain “${short}”`, rationale: "", source: "explain", created: Date.now(), status: "applying",
      changes: [{ op: "underline", label: `Underline + explanation on p. ${sel.pageLabel || sel.pageIndex + 1} of “${Zotero.Utilities.ellipsize(paper.getDisplayTitle(), 50)}”`, detail: "Explaining…", status: "pending" }],
    };
    emit({ type: "explanations" });
    try {
      const abstract = paper.isRegularItem() ? paper.getField("abstractNote").slice(0, 1200) : "";
      const ctx = await pageWindow(att, sel);
      const b = paper.isRegularItem() ? brief(paper) : { title: paper.getDisplayTitle() };
      const prompt = `You are annotating a PDF that the user is reading in Zotero.
Paper: "${b.title}"${b.creators ? ` (${b.creators}${b.year ? ", " + b.year : ""})` : ""}.
${abstract ? `Abstract: ${abstract}\n` : ""}${ctx ? `Text around the passage (page ${sel.pageLabel || sel.pageIndex + 1}):\n"""${ctx}"""\n` : ""}
Selected passage:
"""${sel.text}"""

Write the comment for an underline annotation on the selected passage. Explain it in plain language for a researcher outside this subfield, define any domain-specific terms, symbols or acronyms in it, and say briefly what role it plays in this paper. 2-4 sentences, at most 90 words. Plain text only: no markdown, no preamble, do not repeat the passage.`;
      // Run from the Finch root, not a workspace, so a workspace's CLAUDE.md never changes how explanations read.
      const cwd = workspaceRoot();
      await ensureDir(cwd);
      const text = await oneShot(prompt, cwd);
      const a = Zotero.Items.getByLibraryAndKey(LIB(), key);
      if (!a) throw new Error("The underline was removed before the explanation arrived");
      a.annotationComment = text;
      await a.saveTx();
      Object.assign(rec.changes[0], { detail: text, status: "applied", result: "comment saved" });
      rec.status = "applied";
      rec.undo = [{ op: "erase_annotation", key }];
      history.push(rec);
      await audit({ event: "explain", uid: rec.uid, id: rec.id, title: rec.title, source: "explain", status: rec.status, attachment: att.key, annotation: key, page: sel.pageIndex + 1,
        changes: [{ op: "underline", label: rec.changes[0].label, status: "applied", result: text }], undo: rec.undo });
      emit({ type: "changes" });
    } catch (e) {
      const a = Zotero.Items.getByLibraryAndKey(LIB(), key);
      if (a) await a.eraseTx().catch(() => {});
      Zotero.logError(e);
      emit({ type: "explain-failed", title: short, error: e.message });
    } finally {
      explainPending.delete(key);
      emit({ type: "explanations" });
    }
  }

  // /explain in the chat: the same as the bulb, on the text currently selected in the open PDF.
  function explainCurrentSelection() {
    const ctx = getContext();
    const s = ctxState.selection;
    if (!ctx.selectedText || !s) throw new Error("Select some text in the open PDF first, then run /explain (or press the bulb in the selection popup).");
    explainSelection(s).catch((e) => Zotero.logError(e));
  }

  // The paper whose explanations to list: the parent of the PDF open in the reader (all its PDFs), or null in the library view.
  function openPaper() {
    const ctx = getContext();
    if (!ctx.openPDF) return null;
    const att = Zotero.Items.getByLibraryAndKey(LIB(), ctx.openPDF.attachmentKey);
    if (!att) return null;
    const parent = att.parentItem;
    const atts = parent ? Zotero.Items.get(parent.getAttachments()).filter((x) => x.isPDFAttachment?.() && !x.deleted) : [att];
    return { title: (parent || att).getDisplayTitle(), parentKey: parent?.key, attachments: atts.length ? atts : [att] };
  }

  // Explanations made before the finch:explain tag existed: tag the ones recorded in the change log, once per PDF per run.
  const legacyChecked = new Set();
  async function tagLegacyExplanations(att) {
    if (legacyChecked.has(att.key)) return;
    legacyChecked.add(att.key);
    const keys = new Set();
    for (const e of await readChanges((line) => line.includes('"explain"') && line.includes(att.key))) {
      if (e.event === "explain" && e.attachment === att.key && e.annotation) keys.add(e.annotation);
    }
    for (const k of keys) {
      const a = Zotero.Items.getByLibraryAndKey(LIB(), k);
      if (a && a.isAnnotation() && !a.hasTag(EXPLAIN_TAG)) { a.addTag(EXPLAIN_TAG); await a.saveTx().catch((e) => Zotero.logError(e)); }
    }
  }

  // Finch's explanations on the open paper, in reading order.
  async function paperExplanations() {
    const paper = openPaper();
    if (!paper) return null;
    const out = [];
    for (const att of paper.attachments) {
      await tagLegacyExplanations(att).catch((e) => Zotero.logError(e));
      for (const a of att.getAnnotations()) {
        if (!a.hasTag(EXPLAIN_TAG) && !a.hasTag(LEGACY.explainTag)) continue;
        out.push({
          key: a.key, attachmentKey: att.key, attachmentID: att.id, text: a.annotationText || "", comment: a.annotationComment || "",
          pageLabel: a.annotationPageLabel || "", sortIndex: (paper.attachments.length > 1 ? att.key + ":" : "") + (a.annotationSortIndex || ""),
          pending: explainPending.has(a.key),
        });
      }
    }
    out.sort((x, y) => (x.sortIndex < y.sortIndex ? -1 : x.sortIndex > y.sortIndex ? 1 : 0));
    return { title: paper.title, items: out };
  }

  async function showAnnotation(attachmentID, annotationKey) {
    await Zotero.Reader.open(attachmentID, { annotationID: annotationKey });
  }

  // Undo from the Explanations page: through the change log when the explanation is recorded there, else just erase it.
  async function undoExplanation(annotationKey) {
    const uid = (await readChanges((line) => line.includes(annotationKey)))
      .findLast((e) => e.event === "explain" && e.annotation === annotationKey && e.uid)?.uid;
    const rec = uid && (await changeLog()).find((r) => r.uid === uid);
    if (rec && !rec.undone) await undoChange(uid);
    else await revert([{ op: "erase_annotation", key: annotationKey }]);
    emit({ type: "explanations" });
  }

  // ------------------------------------------------------------------ 2a. read tools
  async function toolSearch({ query = "", mode = "fields", collection, tag, limit = 25 }) {
    const s = new Zotero.Search();
    s.libraryID = LIB();
    if (query) s.addCondition(mode === "everything" ? "quicksearch-everything" : "quicksearch-fields", "contains", query);
    if (collection) { s.addCondition("collection", "is", findCollection(collection).key); s.addCondition("recursive", "true"); }
    if (tag) s.addCondition("tag", "is", tag);
    if (!query && !collection && !tag) throw new Error("Give a query, collection or tag");
    const ids = await s.search();
    const seen = new Map();
    for (const it of Zotero.Items.get(ids)) {
      const top = it.parentItem ? (it.parentItem.parentItem || it.parentItem) : it;
      if (!top.deleted && top.isRegularItem() && !seen.has(top.key)) seen.set(top.key, top);
    }
    const all = [...seen.values()];
    return { total: all.length, items: all.slice(0, limit).map(brief) };
  }

  async function toolGetItem({ key }) {
    const it = getItem(key);
    if (it.isNote()) return { key: it.key, itemType: "note", parentKey: it.parentItem?.key, text: stripHTML(it.getNote()).slice(0, 30000) };
    const json = it.toJSON();
    delete json.relations;
    const out = { ...json, key: it.key };
    if (it.isRegularItem()) {
      out.collections = it.getCollections().map((id) => { const c = Zotero.Collections.get(id); return { key: c.key, path: collPath(c) }; });
      out.notes = Zotero.Items.get(it.getNotes()).map((n) => ({ key: n.key, title: n.getNoteTitle(), chars: n.getNote().length }));
      out.attachments = Zotero.Items.get(it.getAttachments()).map((a) => ({
        key: a.key, title: a.getDisplayTitle(), contentType: a.attachmentContentType,
        annotations: a.isFileAttachment() ? a.getAnnotations().length : 0,
      }));
    }
    return out;
  }

  async function toolGetAnnotations({ key }) {
    const it = getItem(key);
    const atts = it.isAttachment() ? [it] : Zotero.Items.get(it.getAttachments());
    const out = [];
    for (const a of atts) {
      if (!a.isFileAttachment()) continue;
      for (const an of a.getAnnotations()) {
        let pos = {};
        try { pos = JSON.parse(an.annotationPosition); } catch (e) {}
        out.push({
          key: an.key, attachmentKey: a.key, type: an.annotationType, text: an.annotationText || undefined,
          comment: an.annotationComment || undefined, page: (pos.pageIndex ?? 0) + 1, pageLabel: an.annotationPageLabel,
          color: an.annotationColor, tags: an.getTags().map((t) => t.tag), author: an.annotationAuthorName || undefined,
        });
      }
    }
    out.sort((x, y) => x.attachmentKey.localeCompare(y.attachmentKey) || x.page - y.page);
    return { count: out.length, annotations: out };
  }

  async function toolGetFulltext({ key, offset = 0, length = 20000 }) {
    const att = await bestAttachment(getItem(key));
    let text = "";
    const cache = Zotero.FullText.getItemCacheFile(att).path;
    if (await IOUtils.exists(cache)) text = await IOUtils.readUTF8(cache);
    else if (att.isPDFAttachment()) text = (await Zotero.PDFWorker.getFullText(att.id, null, true)).text || "";
    if (!text) return { attachmentKey: att.key, error: "No indexed text for this attachment" };
    return { attachmentKey: att.key, totalChars: text.length, offset, text: text.slice(offset, offset + Math.min(length, 60000)) };
  }

  async function toolGetPageText({ key, page }, caller = {}) {
    const att = await bestAttachment(getItem(key));
    const pdf = await pdfFor(att, page ? page - 1 : undefined, caller.tabID);
    const n = page || pageOf(att, caller.tabID) + 1;
    const { text } = await pageText(pdf, n - 1);
    return { attachmentKey: att.key, page: n, totalPages: Number(pdf.numPages), text };
  }

  function toolListCollections() {
    return allCollections().map((c) => ({ key: c.key, path: collPath(c), items: c.getChildItems(true).length }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  async function toolListTags() { return (await Zotero.Tags.getAll(LIB())).map((t) => t.tag).sort(); }

  async function toolOpen({ key, page }) {
    const it = getItem(key);
    const win = Zotero.getMainWindow();
    if (page || it.isAttachment()) {
      const att = await bestAttachment(it);
      await Zotero.Reader.open(att.id, page ? { pageIndex: page - 1 } : undefined);
      return { opened: att.key, page };
    }
    win.Zotero_Tabs.select("zotero-pane");
    await win.ZoteroPane.selectItem(it.id);
    return { selected: it.key };
  }

  // ------------------------------------------------------------------ 2c. paper search outside the library
  // Read-only lookups on OpenAlex (search, metadata, citation graph) and Semantic Scholar (TL;DRs, abstracts OpenAlex
  // lacks, similar papers). Without keys both share a small free quota per IP address: OpenAlex allows roughly 100
  // searches a day (lookups by id are free) and Semantic Scholar often answers 429, so each key has a pref.
  const OA = "https://api.openalex.org";
  const S2 = "https://api.semanticscholar.org";
  const OA_SELECT = "id,doi,title,publication_year,authorships,primary_location,best_oa_location,cited_by_count,abstract_inverted_index,type";
  const OA_SELECT_FULL = OA_SELECT + ",keywords,referenced_works_count";
  const S2_FIELDS = "title,year,authors,venue,citationCount,externalIds,abstract,openAccessPdf,publicationTypes";
  const OA_SORT = { relevance: "relevance_score:desc", citations: "cited_by_count:desc", newest: "publication_date:desc" };

  const qs = (params) => Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  // An id inside a URL path (DOIs contain "/" and ":", which both APIs expect unescaped).
  const pathId = (s) => encodeURIComponent(s).replace(/%2F/gi, "/").replace(/%3A/gi, ":");
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s);
  const normDOI = (d) => String(d || "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
  const normTitle = (t) => String(t || "").replace(/<[^>]+>/g, "").normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  function arxivOf(...strs) {
    for (const s of strs) {
      const m = String(s || "").match(/(?:arxiv\.org\/(?:abs|pdf)\/|arxiv[.:]\s*)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})/i);
      if (m) return m[1].toLowerCase();
    }
    return "";
  }

  async function getJSON(url, headers, service) {
    const retries = service === "Semantic Scholar" ? 3 : 1;
    for (let attempt = 0; ; attempt++) {
      const xhr = await Zotero.HTTP.request("GET", url, { headers, responseType: "json", timeout: 30000, successCodes: false });
      if (xhr.status === 200) return xhr.response;
      if (xhr.status === 404) throw new Error(`${service}: not found`);
      if (xhr.status === 429 && attempt < retries) { await Zotero.Promise.delay(2000 * (attempt + 1)); continue; }
      if (xhr.status === 429) {
        throw new Error(service === "OpenAlex"
          ? "OpenAlex's free daily quota for this network is used up. A free key (https://openalex.org/settings/api) set in Zotero's Config Editor as extensions.finch.openalexKey raises it."
          : "Semantic Scholar is rate-limiting requests. Try again shortly; a free key (https://www.semanticscholar.org/product/api#api-key-form) set as extensions.finch.semanticScholarKey avoids this.");
      }
      if (!xhr.status) throw new Error(`Could not reach ${service}`);
      const msg = xhr.response?.message || xhr.response?.error;
      throw new Error(`${service}: HTTP ${xhr.status}${msg ? " – " + msg : ""}`);
    }
  }
  function oa(path, params = {}) {
    const key = getPref("openalexKey");
    return getJSON(`${OA}${path}?${qs({ ...params, api_key: key || undefined })}`, {}, "OpenAlex");
  }
  function s2(path, params = {}) {
    const key = getPref("semanticScholarKey");
    return getJSON(`${S2}${path}?${qs(params)}`, key ? { "x-api-key": key } : {}, "Semantic Scholar");
  }

  function authorList(names, full) {
    if (!names.length) return undefined;
    if (full) return names.slice(0, 50).join(", ") + (names.length > 50 ? ` … (${names.length} authors)` : "");
    return names.slice(0, 3).join(", ") + (names.length > 3 ? ` et al. (${names.length} authors)` : "");
  }
  function oaAbstract(inv) {
    if (!inv) return "";
    const words = [];
    for (const [w, positions] of Object.entries(inv)) for (const p of positions) words[p] = w;
    return words.join(" ").replace(/\s+/g, " ").trim();
  }
  function fromOA(w, full) {
    const loc = w.primary_location || {};
    const doi = normDOI(w.doi);
    const abstract = oaAbstract(w.abstract_inverted_index);
    return clean({
      id: String(w.id || "").replace("https://openalex.org/", ""),
      title: String(w.title || "").replace(/<[^>]+>/g, ""), year: w.publication_year,
      authors: authorList((w.authorships || []).map((a) => a.author?.display_name).filter(Boolean), full),
      venue: loc.source?.display_name, type: w.type, doi,
      arxiv: arxivOf(doi, loc.landing_page_url, w.best_oa_location?.landing_page_url),
      citations: w.cited_by_count, references: w.referenced_works_count,
      keywords: full && w.keywords?.length ? w.keywords.map((k) => k.display_name).join(", ") : undefined,
      pdf: w.best_oa_location?.pdf_url, url: loc.landing_page_url,
      abstract: full ? abstract : clip(abstract, 600),
    });
  }
  function fromS2(p, full) {
    const x = p.externalIds || {};
    return clean({
      id: p.paperId, title: p.title, year: p.year,
      authors: authorList((p.authors || []).map((a) => a.name).filter(Boolean), full),
      venue: p.venue, type: p.publicationTypes?.[0], doi: normDOI(x.DOI), arxiv: String(x.ArXiv || "").toLowerCase(),
      citations: p.citationCount, pdf: p.openAccessPdf?.url, url: p.paperId && `https://www.semanticscholar.org/paper/${p.paperId}`,
      tldr: p.tldr?.text, abstract: full ? p.abstract : clip(p.abstract, 600),
    });
  }

  // DOI, arXiv id and title of a library item, as the APIs report them.
  function itemIds(it) {
    const f = (k) => { try { return it.getField(k) || ""; } catch (e) { return ""; } };
    const extra = f("extra");
    const doi = normDOI(f("DOI") || extra.match(/^DOI:\s*(\S+)/im)?.[1]);
    return { doi, arxiv: arxivOf(doi, f("url"), f("archiveID"), extra), title: f("title") };
  }
  // Lets search results point at the copy the user already has.
  async function libraryIndex() {
    const idx = { doi: new Map(), arxiv: new Map(), title: new Map() };
    for (const it of await Zotero.Items.getAll(LIB(), true)) {
      if (!it.isRegularItem() || it.deleted) continue;
      const { doi, arxiv, title } = itemIds(it);
      if (doi) idx.doi.set(doi, it.key);
      if (arxiv) idx.arxiv.set(arxiv, it.key);
      const t = normTitle(title);
      if (t.length > 12) idx.title.set(t, it.key);
    }
    return idx;
  }
  function markLibrary(recs, idx) {
    for (const r of recs) {
      const key = (r.doi && idx.doi.get(r.doi)) || (r.arxiv && idx.arxiv.get(r.arxiv)) || idx.title.get(normTitle(r.title));
      if (key) r.in_library = key;
    }
    return recs;
  }

  // Turn what the caller passed (item key, DOI, arXiv id, OpenAlex or Semantic Scholar id, URL or title) into ids.
  async function resolvePaper(spec) {
    const s = String(spec || "").trim();
    if (!s) throw new Error("Give a paper: Zotero item key, DOI, arXiv id, OpenAlex id, Semantic Scholar id or title");
    if (/^[A-Z0-9]{8}$/.test(s)) {
      let it = Zotero.Items.getByLibraryAndKey(LIB(), s);
      if (it && !it.isRegularItem() && it.parentItem) it = it.parentItem;
      if (it?.isRegularItem()) return { key: it.key, ...itemIds(it) };
    }
    let m = s.match(/^(?:https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?)?(W\d+)$/i);
    if (m) return { oaid: m[1].toUpperCase() };
    m = s.match(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i);
    if (m) return { doi: normDOI(m[1]), arxiv: arxivOf(m[1]) };
    const ax = arxivOf(s) || (s.match(/^(\d{4}\.\d{4,5})(v\d+)?$/) || [])[1];
    if (ax) return { arxiv: ax };
    m = s.match(/^(?:https?:\/\/www\.semanticscholar\.org\/paper\/(?:[^/]+\/)?)?([0-9a-f]{40})$/i);
    if (m) {
      const p = await s2(`/graph/v1/paper/${m[1]}`, { fields: "title,externalIds" });
      return { s2id: p.paperId, doi: normDOI(p.externalIds?.DOI), arxiv: String(p.externalIds?.ArXiv || "").toLowerCase(), title: p.title };
    }
    return { title: s };
  }
  async function oaWork(ref, select = OA_SELECT_FULL) {
    const tries = [];
    if (ref.oaid) tries.push(() => oa(`/works/${ref.oaid}`, { select }));
    if (ref.doi) tries.push(() => oa(`/works/doi:${pathId(ref.doi)}`, { select }));
    if (ref.arxiv) tries.push(() => oa(`/works/doi:10.48550/arxiv.${pathId(ref.arxiv)}`, { select }));
    if (ref.title) {
      tries.push(async () => {
        const r = await oa("/works", { filter: "title.search:" + ref.title.replace(/[,|:]/g, " "), "per-page": 5, select });
        const t = normTitle(ref.title);
        // An item from the library must match exactly; a typed title takes the best match (its title is returned).
        const hit = r.results.find((w) => normTitle(w.title) === t) || (!ref.key && r.results[0]);
        if (!hit) throw new Error("OpenAlex: not found");
        return hit;
      });
    }
    for (const t of tries) {
      try { return await t(); } catch (e) { if (!/not found/.test(e.message)) throw e; }
    }
    throw new Error("OpenAlex has no record of this paper");
  }
  // The Semantic Scholar record for a paper. Semantic Scholar doesn't know every DOI (it files some papers under their
  // arXiv id only), so this tries the DOI, then the arXiv id, then a title match.
  async function s2Paper(ref, work, fields) {
    if (ref.s2id) return s2(`/graph/v1/paper/${ref.s2id}`, { fields });
    // The caller's own ids first: OpenAlex may have merged an arXiv preprint into its published version.
    const wdoi = normDOI(work?.doi), warxiv = arxivOf(wdoi, work?.primary_location?.landing_page_url);
    const ids = new Set([ref.doi && "DOI:" + ref.doi, ref.arxiv && "ARXIV:" + ref.arxiv, wdoi && "DOI:" + wdoi, warxiv && "ARXIV:" + warxiv].filter(Boolean));
    const title = work?.title || ref.title;
    const tries = [
      ...[...ids].map((id) => () => s2(`/graph/v1/paper/${pathId(id)}`, { fields })),
      title && (async () => {
        const hit = (await s2("/graph/v1/paper/search/match", { query: title.replace(/<[^>]+>/g, ""), fields })).data?.[0];
        if (!hit || normTitle(hit.title) !== normTitle(title)) throw new Error("Semantic Scholar: not found");
        return hit;
      }),
    ].filter(Boolean);
    for (const t of tries) {
      try { return await t(); } catch (e) { if (!/not found/.test(e.message)) throw e; }
    }
    throw new Error("Semantic Scholar has no record of this paper");
  }

  async function toolFindPapers({ query: q, source = "openalex", from_year, to_year, sort = "relevance", open_access, limit = 10 }) {
    if (!q?.trim()) throw new Error("Give a query");
    limit = Math.max(1, Math.min(Number(limit) || 10, 50));
    let total, papers;
    if (source === "semantic_scholar") {
      const r = await s2("/graph/v1/paper/search", {
        query: q, limit, fields: S2_FIELDS,
        year: from_year || to_year ? `${from_year || ""}-${to_year || ""}` : undefined,
        openAccessPdf: open_access ? "" : undefined,
      });
      total = r.total;
      papers = (r.data || []).map((p) => fromS2(p));
      if (sort === "citations") papers.sort((a, b) => (b.citations || 0) - (a.citations || 0));
      if (sort === "newest") papers.sort((a, b) => (b.year || 0) - (a.year || 0));
    } else {
      const filter = [from_year && `from_publication_date:${from_year}-01-01`, to_year && `to_publication_date:${to_year}-12-31`, open_access && "is_oa:true"].filter(Boolean).join(",");
      const r = await oa("/works", { search: q, filter: filter || undefined, sort: OA_SORT[sort] || OA_SORT.relevance, "per-page": limit, select: OA_SELECT });
      total = r.meta?.count;
      papers = (r.results || []).map((w) => fromOA(w));
    }
    return { source, total, papers: markLibrary(papers, await libraryIndex()) };
  }

  async function toolGetPaper({ paper }) {
    const ref = await resolvePaper(paper);
    const notes = [];
    let work = null, sp = null;
    try { work = await oaWork(ref); } catch (e) { notes.push(e.message); }
    try { sp = await s2Paper(ref, work, S2_FIELDS + ",tldr"); } catch (e) { notes.push(e.message); }
    if (!work && !sp) throw new Error(notes.join("; "));
    const a = work && fromOA(work, true), b = sp && fromS2(sp, true);
    const out = a ? { ...a, s2_id: b?.id, tldr: b?.tldr, abstract: b?.abstract || a.abstract, pdf: a.pdf || b?.pdf, s2_citations: b?.citations } : b;
    if (a && b && !a.arxiv && b.arxiv) out.arxiv = b.arxiv;
    markLibrary([out], await libraryIndex());
    if (ref.key) out.in_library = ref.key;
    if (notes.length) out.notes = notes;
    return clean(out);
  }

  async function toolRelatedPapers({ paper, relation = "citations", sort = "citations", limit = 20 }) {
    limit = Math.max(1, Math.min(Number(limit) || 20, 50));
    const ref = await resolvePaper(paper);
    let seed, source, total, papers;
    if (relation === "similar") {
      const work = ref.s2id ? null : await oaWork(ref, "id,doi,title,primary_location").catch(() => null);
      const p = await s2Paper(ref, work, "title");
      seed = { id: p.paperId, title: p.title };
      const r = await s2(`/recommendations/v1/papers/forpaper/${p.paperId}`, { limit, fields: S2_FIELDS });
      source = "semantic_scholar";
      papers = (r.recommendedPapers || []).map((x) => fromS2(x));
      total = papers.length;
    } else {
      const work = await oaWork(ref, "id,title");
      seed = { id: work.id.replace("https://openalex.org/", ""), title: work.title };
      const r = await oa("/works", { filter: (relation === "references" ? "cited_by:" : "cites:") + seed.id, sort: sort === "newest" ? OA_SORT.newest : OA_SORT.citations, "per-page": limit, select: OA_SELECT });
      source = "openalex";
      total = r.meta?.count;
      papers = r.results.map((w) => fromOA(w));
    }
    return { paper: seed, relation, source, total, papers: markLibrary(papers, await libraryIndex()) };
  }

  // ------------------------------------------------------------------ 3. PDF text location
  // The reader showing `att`: preferably in `tabID` (a chat's own tab), then in the selected tab, then any.
  // With duplicate tabs of one paper this picks the tab the user (or the chat) is actually on.
  function readerIn(tabID, att) { const r = tabID && Zotero.Reader.getByTabID(tabID); return r && r.itemID === att.id ? r : null; }
  function readerFor(att, tabID) {
    return readerIn(tabID, att) || readerIn(mainTabs()?.selectedID, att) || Zotero.Reader._readers.find((r) => r.itemID === att.id);
  }
  // The page (0-based) a reader is on right now. Zotero keeps one "last page" per PDF, shared by all its tabs,
  // so this reads the reader's own view state (what its toolbar shows); null if unavailable.
  function readerPage(reader) {
    try { const pi = W(W(W(reader._internalReader)?._state)?.primaryViewStats)?.pageIndex; return Number.isInteger(pi) ? pi : null; }
    catch (e) { return null; }
  }
  function pageOf(att, tabID) {
    const r = readerIn(tabID, att) || readerIn(mainTabs()?.selectedID, att);
    return (r && readerPage(r)) ?? att.getAttachmentLastPageIndex() ?? 0;
  }

  async function pdfFor(att, pageIndex, tabID) {
    if (!att.isPDFAttachment()) throw new Error(`${att.key} is not a PDF`);
    let reader = readerFor(att, tabID);
    if (!reader) reader = await Zotero.Reader.open(att.id, pageIndex !== undefined ? { pageIndex } : undefined);
    for (let i = 0; i < 100; i++) {
      try {
        const w = reader._internalReader?._primaryView?._iframeWindow;
        const app = (w?.wrappedJSObject || w)?.PDFViewerApplication;
        if (app?.pdfDocument) return W(app.pdfDocument);
      } catch (e) { /* not ready */ }
      await Zotero.Promise.delay(150);
    }
    throw new Error("Could not access the PDF in the reader");
  }

  async function getPage(pdf, pageIndex) {
    const page = W(await W(pdf).getPage(pageIndex + 1));
    return { page, view: Array.from(W(page.view)).map(Number) };
  }

  async function pageText(pdf, pageIndex) {
    const { page, view } = await getPage(pdf, pageIndex);
    const tc = W(await page.getTextContent());
    const items = Array.from(W(tc.items)).map(W).filter((i) => typeof i.str === "string")
      .map((i) => ({ str: String(i.str), transform: Array.from(W(i.transform)).map(Number), width: Number(i.width), height: Number(i.height), hasEOL: !!i.hasEOL }));
    let text = "";
    for (const i of items) text += i.str + (i.hasEOL ? "\n" : "");
    return { view, items, text };
  }

  // Locate `quote` on a page; returns rects in PDF user space (y up) or null.
  async function locate(pdf, pageIndex, quote) {
    const { view, items } = await pageText(pdf, pageIndex);
    const page = { view };
    const norm = (c) => c.toLowerCase().replace(/[‐-―­]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    // Build a whitespace-free char stream with a map back to (item, offset).
    const chars = [], map = [];
    items.forEach((it, ii) => { for (let k = 0; k < it.str.length; k++) { const c = it.str[k]; if (!/\s/.test(c)) { chars.push(norm(c)); map.push([ii, k]); } } });
    const stream = chars.join("");
    let q = norm(quote).replace(/\s+/g, "");
    let at = stream.indexOf(q);
    if (at < 0) { // tolerate hyphenated line breaks
      const dehyph = q.replace(/-/g, "");
      const s2 = []; const m2 = [];
      chars.forEach((c, i) => { if (c !== "-") { s2.push(c); m2.push(map[i]); } });
      at = s2.join("").indexOf(dehyph);
      if (at < 0) return null;
      return rectsFor(page, items, m2.slice(at, at + dehyph.length));
    }
    return rectsFor(page, items, map.slice(at, at + q.length));
  }

  function rectsFor(page, items, span) {
    const byItem = new Map();
    for (const [ii, k] of span) { const r = byItem.get(ii) || [k, k]; r[0] = Math.min(r[0], k); r[1] = Math.max(r[1], k); byItem.set(ii, r); }
    const rects = [];
    for (const [ii, [a, b]] of byItem) {
      const it = items[ii];
      const [, , c, d, e, f] = it.transform;
      const h = Math.hypot(c, d) || it.height || 10;
      const len = it.str.length || 1;
      const x1 = e + (it.width * a) / len, x2 = e + (it.width * (b + 1)) / len;
      const r = [x1, f - 0.25 * h, x2, f + 0.85 * h];
      const prev = rects[rects.length - 1];
      if (prev && Math.abs(prev[1] - r[1]) < h * 0.5 && r[0] - prev[2] < h * 2) { prev[2] = Math.max(prev[2], r[2]); prev[0] = Math.min(prev[0], r[0]); }
      else rects.push(r);
    }
    const view = page.view; // [x0, y0, x1, y1]
    return { rects: rects.map((r) => r.map((v) => Math.round(v * 1000) / 1000)), pageHeight: view[3] - view[1] };
  }

  function sortIndex(pageIndex, offset, top) {
    return [String(pageIndex).padStart(5, "0"), String(Math.max(0, Math.floor(offset))).padStart(6, "0"), String(Math.max(0, Math.floor(top))).padStart(5, "0")].join("|");
  }

  async function pageLabel(pdf, pageIndex) {
    try { const labels = W(await pdf.getPageLabels()); if (labels && labels[pageIndex]) return String(labels[pageIndex]); } catch (e) {}
    return String(pageIndex + 1);
  }

  // ------------------------------------------------------------------ 2b. proposals (review-gated writes)
  const proposals = new Map();
  const history = []; // applied batches, newest last
  let nextProposal = 1;

  const COLORS = { yellow: "#ffd400", red: "#ff6666", green: "#5fb236", blue: "#2ea8e5", purple: "#a28ae5", magenta: "#e56eee", orange: "#f19837", gray: "#aaaaaa" };

  // Markdown → Zotero note HTML (see markdown.js). Content that is already HTML is stored as is.
  function mdToHtml(md) {
    if (/^\s*<(p|h\d|ul|ol|div|blockquote|table|pre)[\s>]/i.test(md)) return md;
    return FinchMarkdown.note(md);
  }

  // Validate + describe one change. Returns {label, detail}. Throws on invalid input.
  async function describe(ch, refs) {
    const short = (it) => `“${Zotero.Utilities.ellipsize(it.getDisplayTitle(), 60)}”`;
    switch (ch.op) {
      case "update_fields": {
        const it = getItem(ch.key);
        const fields = ch.fields || {};
        if (!Object.keys(fields).length) throw new Error("update_fields needs fields");
        const rows = Object.entries(fields).map(([f, v]) => {
          const fid = Zotero.ItemFields.getID(f);
          if (!fid || !Zotero.ItemFields.isValidForType(fid, it.itemTypeID)) throw new Error(`Field "${f}" is not valid for ${it.itemType}`);
          return { field: f, before: it.getField(f), after: String(v) };
        });
        return { label: `Edit ${short(it)}`, rows };
      }
      case "add_tags": case "remove_tags": {
        const it = getItem(ch.key);
        if (!Array.isArray(ch.tags) || !ch.tags.length) throw new Error(`${ch.op} needs tags`);
        return { label: `${ch.op === "add_tags" ? "Tag" : "Untag"} ${short(it)}`, detail: ch.tags.join(", ") };
      }
      case "add_to_collection": case "remove_from_collection": {
        const it = getItem(ch.key);
        const c = findCollection(ch.collection, refs);
        return { label: `${ch.op === "add_to_collection" ? "Add" : "Remove"} ${short(it)} ${ch.op === "add_to_collection" ? "to" : "from"}`, detail: c.name ? collPath(c) : `new collection "${c.pendingName}"` };
      }
      case "create_collection": {
        if (!ch.name) throw new Error("create_collection needs name");
        const parent = ch.parent ? findCollection(ch.parent, refs) : null;
        refs[ch.ref || ch.name] = { pendingName: ch.name };
        return { label: "New collection", detail: (parent ? (parent.name ? collPath(parent) : parent.pendingName) + " / " : "") + ch.name };
      }
      case "create_note": {
        if (!ch.content) throw new Error("create_note needs content");
        const parent = ch.parent ? getItem(ch.parent) : null;
        if (parent && !parent.isRegularItem()) throw new Error("Notes can only be children of regular items");
        if (ch.collection) findCollection(ch.collection, refs);
        return { label: parent ? `Note on ${short(parent)}` : "Standalone note", detail: stripHTML(mdToHtml(ch.content)).slice(0, 400) };
      }
      case "highlight": {
        const att = await bestAttachment(getItem(ch.attachment || ch.key));
        if (!att.isPDFAttachment()) throw new Error("Highlights need a PDF");
        if (!ch.use_selection && !ch.text) throw new Error("highlight needs text (an exact quote) or use_selection: true");
        if (ch.use_selection && !ctxState.selection) throw new Error("No text is selected in the reader");
        const text = ch.use_selection ? ctxState.selection.text : ch.text;
        return { label: `Highlight in ${short(att.parentItem || att)}${ch.page ? ` p. ${ch.page}` : ""}`, detail: `“${Zotero.Utilities.ellipsize(text, 300)}”` + (ch.comment ? ` — comment: ${ch.comment}` : "") };
      }
      case "add_page_comment": {
        const att = await bestAttachment(getItem(ch.attachment || ch.key));
        if (!att.isPDFAttachment()) throw new Error("Page comments need a PDF");
        if (!ch.page || !ch.comment) throw new Error("add_page_comment needs page and comment");
        return { label: `Comment on p. ${ch.page} of ${short(att.parentItem || att)}`, detail: ch.comment };
      }
      case "trash": {
        const it = getItem(ch.key);
        return { label: `Move to Trash: ${short(it)}`, detail: it.itemType };
      }
      default:
        throw new Error(`Unknown op "${ch.op}"`);
    }
  }

  async function propose({ title, rationale, changes, wait = true }, { source = "terminal", tabID = null } = {}) {
    if (!Array.isArray(changes) || !changes.length) throw new Error("changes must be a non-empty array");
    if (changes.length > 200) throw new Error("At most 200 changes per proposal");
    const refs = {};
    const described = [];
    for (const [i, ch] of changes.entries()) {
      try { described.push({ ...ch, ...(await describe(ch, refs)), status: "pending" }); }
      catch (e) { throw new Error(`Change ${i + 1} (${ch.op}): ${e.message}`); }
    }
    let resolve;
    const p = {
      id: nextProposal++, uid: Zotero.Utilities.randomString(12), title: title || "Proposed changes", rationale: rationale || "", source, tabID, created: Date.now(),
      changes: described, status: "pending", decided: new Promise((r) => (resolve = r)),
    };
    p._resolve = resolve;
    proposals.set(p.id, p);
    emit({ type: "proposal", proposal: p });
    if (source === "auto") setPendingBadge(true); else openChat({ focus: true });
    if (!wait) return { proposalId: p.id, status: "pending", note: "Queued for the user's review in Zotero." };
    const mins = getPref("proposalTimeoutMin") || 15;
    const timeout = Zotero.Promise.delay(mins * 60000).then(() => "timeout");
    const r = await Promise.race([p.decided, timeout]);
    if (r === "timeout") return { proposalId: p.id, status: "pending", note: `No decision after ${mins} min; it stays in the review queue. Check later with get_proposal.` };
    return summary(p);
  }

  function summary(p) {
    return {
      proposalId: p.id, status: p.status, feedback: p.feedback || undefined,
      changes: p.changes.map((c, i) => ({ index: i + 1, op: c.op, status: c.status, error: c.error, result: c.result })),
    };
  }

  // Apply the accepted subset. Each change records its own inverse for undo.
  async function decide(id, acceptedIdx, feedback) {
    const p = proposals.get(id);
    if (!p || p.status !== "pending") return;
    p.status = "applying";
    p.feedback = feedback || "";
    emit({ type: "proposal", proposal: p });
    const refs = {};
    const undo = [];
    for (const [i, ch] of p.changes.entries()) {
      if (!acceptedIdx.includes(i)) { ch.status = "rejected"; continue; }
      try { ch.result = await applyOne(ch, refs, undo, p.tabID); ch.status = "applied"; }
      catch (e) { ch.status = "failed"; ch.error = e.message; Zotero.logError(e); }
    }
    const applied = p.changes.filter((c) => c.status === "applied").length;
    p.status = applied ? (applied === p.changes.length ? "applied" : "partially applied") : (p.changes.some((c) => c.status === "failed") ? "failed" : "rejected");
    if (undo.length) { p.undo = undo; history.push(p); }
    await audit({ event: "decide", uid: p.uid, id: p.id, title: p.title, source: p.source, status: p.status, changes: p.changes.map(({ detail, rows, ...c }) => c), undo: p.undo });
    emit({ type: "changes" });
    emit({ type: "proposal", proposal: p });
    setPendingBadge([...proposals.values()].some((x) => x.status === "pending"));
    p._resolve(p.status);
  }

  async function applyOne(ch, refs, undo, tabID) {
    switch (ch.op) {
      case "update_fields": {
        const it = getItem(ch.key);
        const before = {};
        for (const [f, v] of Object.entries(ch.fields)) { before[f] = it.getField(f); it.setField(f, String(v)); }
        await it.saveTx();
        undo.push({ op: "update_fields", key: it.key, fields: before, after: Object.fromEntries(Object.keys(before).map((f) => [f, it.getField(f)])) });
        return "saved";
      }
      case "add_tags": {
        const it = getItem(ch.key);
        const added = ch.tags.filter((t) => !it.hasTag(t));
        added.forEach((t) => it.addTag(t));
        if (added.length) { await it.saveTx(); undo.push({ op: "remove_tags", key: it.key, tags: added }); }
        return `${added.length} added`;
      }
      case "remove_tags": {
        const it = getItem(ch.key);
        const removed = it.getTags().filter((t) => ch.tags.includes(t.tag));
        removed.forEach((t) => it.removeTag(t.tag));
        if (removed.length) { await it.saveTx(); undo.push({ op: "restore_tags", key: it.key, tags: removed }); }
        return `${removed.length} removed`;
      }
      case "add_to_collection": case "remove_from_collection": {
        const it = getItem(ch.key);
        const c = findCollection(ch.collection, refs);
        if (!c.id) throw new Error("Collection was not created");
        const add = ch.op === "add_to_collection";
        if (add === it.inCollection(c.id)) return "no change";
        add ? it.addToCollection(c.id) : it.removeFromCollection(c.id);
        await it.saveTx();
        undo.push({ op: add ? "remove_from_collection" : "add_to_collection", key: it.key, collection: c.key });
        return "saved";
      }
      case "create_collection": {
        const parent = ch.parent ? findCollection(ch.parent, refs) : null;
        if (parent && !parent.id) throw new Error("Parent collection was not created");
        const c = new Zotero.Collection({ name: ch.name, libraryID: LIB(), ...(parent ? { parentID: parent.id } : {}) });
        await c.saveTx();
        refs[ch.ref || ch.name] = c;
        undo.push({ op: "trash_collection", key: c.key });
        return c.key;
      }
      case "create_note": {
        const n = new Zotero.Item("note");
        n.libraryID = LIB();
        if (ch.parent) n.parentID = getItem(ch.parent).id;
        n.setNote(mdToHtml(ch.content));
        if (!ch.parent && ch.collection) { const c = findCollection(ch.collection, refs); if (c.id) n.addToCollection(c.id); }
        await n.saveTx();
        undo.push({ op: "trash", key: n.key });
        return n.key;
      }
      case "highlight": case "add_page_comment": {
        const att = await bestAttachment(getItem(ch.attachment || ch.key));
        const json = await annotationJSON(att, ch, tabID);
        const saved = await Zotero.Annotations.saveFromJSON(att, json);
        undo.push({ op: "erase_annotation", key: saved.key });
        const reader = readerFor(att, tabID);
        if (reader) { try { await reader.navigate({ annotationID: saved.key }); } catch (e) {} }
        return `${saved.key} on p. ${json.position.pageIndex + 1}${json._approx ? " (text not found; placed as page comment)" : ""}`;
      }
      case "trash": {
        const it = getItem(ch.key);
        it.deleted = true;
        await it.saveTx();
        undo.push({ op: "untrash", key: it.key });
        return "in Trash";
      }
    }
    throw new Error("unsupported op " + ch.op);
  }

  async function annotationJSON(att, ch, tabID) {
    const color = COLORS[ch.color] || (/^#[0-9a-f]{6}$/i.test(ch.color || "") ? ch.color : COLORS.yellow);
    const key = Zotero.DataObjectUtilities.generateKey();
    const base = { key, color, comment: ch.comment || "", tags: [], authorName: "Finch" };
    if (ch.op === "highlight" && ch.use_selection) {
      const s = ctxState.selection;
      if (!s || s.attachmentKey !== att.key) throw new Error("The reader selection is not in this PDF any more");
      return { ...base, type: "highlight", text: s.text, pageLabel: s.pageLabel, sortIndex: s.sortIndex, position: s.position };
    }
    const pdf = await pdfFor(att, ch.page ? ch.page - 1 : undefined, tabID);
    if (ch.op === "highlight") {
      const pages = ch.page ? [ch.page - 1] : [...Array(Number(pdf.numPages)).keys()];
      for (const pi of pages) {
        const loc = await locate(pdf, pi, ch.text);
        if (loc && loc.rects.length) {
          const top = loc.pageHeight - loc.rects[0][3];
          return { ...base, type: "highlight", text: ch.text, pageLabel: await pageLabel(pdf, pi), sortIndex: sortIndex(pi, 0, top), position: { pageIndex: pi, rects: loc.rects } };
        }
      }
      if (!ch.page) throw new Error("Quote not found in the PDF text; give the exact wording or a page number");
    }
    // Page comment (also the fallback when a quote can't be located on a given page).
    const pi = ch.page - 1;
    const { view } = await getPage(pdf, pi);
    const [, , x1, y1] = view;
    const rect = [x1 - 40, y1 - 40, x1 - 18, y1 - 18]; // top-right corner of the page
    const comment = ch.op === "highlight" ? `“${ch.text}”${ch.comment ? "\n\n" + ch.comment : ""}` : ch.comment;
    return { ...base, type: "note", comment, pageLabel: await pageLabel(pdf, pi), sortIndex: sortIndex(pi, 0, 18), position: { pageIndex: pi, rects: [rect] }, _approx: ch.op === "highlight" };
  }

  // Revert a recorded undo list (newest change first). Fields edited by hand since Claude's change are left alone.
  async function revert(undoList) {
    let reverted = 0, skipped = 0;
    for (const u of [...undoList].reverse()) {
      try {
        if (u.op === "trash_collection") { const c = Zotero.Collections.getByLibraryAndKey(LIB(), u.key); if (c) { c.deleted = true; await c.saveTx(); reverted++; } else skipped++; continue; }
        if (u.op === "erase_annotation") { const a = Zotero.Items.getByLibraryAndKey(LIB(), u.key); if (a) { await a.eraseTx(); reverted++; } else skipped++; continue; }
        const it = Zotero.Items.getByLibraryAndKey(LIB(), u.key);
        if (!it) { skipped++; continue; }
        if (u.op === "update_fields") {
          for (const [f, v] of Object.entries(u.fields)) {
            if (u.after && it.getField(f) !== u.after[f]) { skipped++; continue; }
            it.setField(f, v); reverted++;
          }
        } else {
          if (u.op === "remove_tags") u.tags.forEach((t) => it.removeTag(t));
          else if (u.op === "restore_tags") u.tags.forEach((t) => it.addTag(t.tag, t.type || 0));
          else if (u.op === "remove_from_collection") it.removeFromCollection(Zotero.Collections.getByLibraryAndKey(LIB(), u.collection).id);
          else if (u.op === "add_to_collection") it.addToCollection(Zotero.Collections.getByLibraryAndKey(LIB(), u.collection).id);
          else if (u.op === "trash") it.deleted = true;
          else if (u.op === "untrash") it.deleted = false;
          reverted++;
        }
        await it.saveTx();
      } catch (e) { skipped++; Zotero.logError(e); }
    }
    return { reverted, skipped };
  }

  // Undo any recorded change by its persistent uid: this session's history first, then the change log on disk.
  async function undoChange(uid) {
    const p = history.find((h) => h.uid === uid);
    let undoList = p?.undo;
    if (p?.undone) throw new Error("Already undone");
    if (!p) {
      const rec = (await changeLog()).find((r) => r.uid === uid);
      if (!rec || !rec.undo?.length) throw new Error("This change has no undo information");
      if (rec.undone) throw new Error("Already undone");
      undoList = rec.undo;
    }
    const result = await revert(undoList);
    if (p) { p.undone = true; p.status = "undone"; emit({ type: "proposal", proposal: p }); }
    await audit({ event: "undo", uid, id: p?.id, ...result });
    emit({ type: "changes" });
    return result;
  }

  // The change log (newest first): every applied proposal / explanation, folded with later undo events.
  async function changeLog(limit = 300) {
    const recs = new Map();
    let n = 0;
    for (const e of await readChanges()) {
      if (e.event === "decide" || e.event === "explain") {
        if (e.event === "decide" && !(e.changes || []).some((c) => c.status === "applied")) continue; // rejected / failed batches
        const uid = e.uid || `legacy-${n++}`;
        recs.set(uid, {
          uid, ts: e.ts, title: e.title || (e.event === "explain" ? "Explanation" : "Changes"), source: e.source || (e.event === "explain" ? "explain" : "change"), status: e.status,
          changes: (e.changes || []).filter((c) => c.status === "applied").map((c) => c.label || c.op), undo: e.undo, undone: false,
        });
      } else if (e.event === "undo" && e.uid && recs.has(e.uid)) {
        Object.assign(recs.get(e.uid), { undone: true, undoneAt: e.ts, skipped: e.skipped || 0 });
      }
    }
    return [...recs.values()].reverse().slice(0, limit);
  }

  // Raw change-log entries, oldest first; unparseable lines are skipped. `match` pre-filters lines before parsing.
  async function readChanges(match) {
    const file = changesFile();
    if (!(await IOUtils.exists(file))) return [];
    const out = [];
    for (const line of (await IOUtils.readUTF8(file)).split("\n")) {
      if (!line.trim() || (match && !match(line))) continue;
      try { out.push(JSON.parse(line)); } catch (e) {}
    }
    return out;
  }

  async function audit(entry) {
    try {
      await ensureDir(workspaceRoot());
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
      await IOUtils.writeUTF8(changesFile(), line, { mode: "appendOrCreate" });
    } catch (e) { Zotero.logError(e); }
  }

  // ------------------------------------------------------------------ 4. MCP server
  const S = (props, required = []) => ({ type: "object", properties: props, required });
  const CHANGE_SCHEMA = {
    type: "object",
    properties: {
      op: { type: "string", enum: ["update_fields", "add_tags", "remove_tags", "add_to_collection", "remove_from_collection", "create_collection", "create_note", "highlight", "add_page_comment", "trash"] },
      key: { type: "string", description: "Item key (update_fields, tags, collection membership, trash)" },
      fields: { type: "object", description: "update_fields: {field: value} using Zotero field names (e.g. publicationTitle, date, DOI, pages)" },
      tags: { type: "array", items: { type: "string" } },
      collection: { type: "string", description: "Collection key, full path 'A / B', unique name, or the ref of a create_collection in this proposal" },
      name: { type: "string", description: "create_collection: name" },
      parent: { type: "string", description: "create_collection: parent collection; create_note: parent item key" },
      ref: { type: "string", description: "create_collection: name other changes in this proposal can use as `collection`" },
      content: { type: "string", description: "create_note: Markdown or HTML. Math in Markdown: $…$ inline, $$…$$ display" },
      attachment: { type: "string", description: "highlight/add_page_comment: PDF attachment key (or parent item key: its best PDF)" },
      text: { type: "string", description: "highlight: exact quote from the PDF" },
      use_selection: { type: "boolean", description: "highlight: use the text the user has selected in the reader" },
      page: { type: "integer", description: "1-based page number" },
      comment: { type: "string" },
      color: { type: "string", description: "yellow|red|green|blue|purple|magenta|orange|gray or #rrggbb" },
    },
    required: ["op"],
  };

  const TOOLS = [
    { name: "get_context", description: "What the user is looking at in Zotero right now: open PDF + page, selected items, selected collection, and text selected in the reader.", inputSchema: S({}), run: (args, caller) => getContext(caller.tabID) },
    { name: "search", description: "Search My Library. mode 'fields' (title/creator/year/all fields) or 'everything' (also full text and notes). Filter by collection (key/path/name, recursive) and/or tag.", inputSchema: S({ query: { type: "string" }, mode: { type: "string", enum: ["fields", "everything"] }, collection: { type: "string" }, tag: { type: "string" }, limit: { type: "integer" } }), run: toolSearch },
    { name: "get_item", description: "Full metadata for an item (fields, creators, tags, collections, child notes and attachments). For a note key, returns the note text.", inputSchema: S({ key: { type: "string" } }, ["key"]), run: toolGetItem },
    { name: "get_annotations", description: "Highlights, underlines and comments on an item's PDFs (or one attachment), with page numbers.", inputSchema: S({ key: { type: "string" } }, ["key"]), run: toolGetAnnotations },
    { name: "get_fulltext", description: "Indexed full text of an item's best attachment (or a given attachment). Paginate with offset/length (chars).", inputSchema: S({ key: { type: "string" }, offset: { type: "integer" }, length: { type: "integer" } }, ["key"]), run: toolGetFulltext },
    { name: "get_page_text", description: "Text of one PDF page (1-based; default: the page the user is on). Opens the PDF in Zotero's reader if needed.", inputSchema: S({ key: { type: "string" }, page: { type: "integer" } }, ["key"]), run: toolGetPageText },
    { name: "list_collections", description: "All collections in My Library with keys, full paths and item counts.", inputSchema: S({}), run: toolListCollections },
    { name: "list_tags", description: "All tags in My Library.", inputSchema: S({}), run: toolListTags },
    { name: "open", description: "Show an item to the user: select it in the library, or open its PDF (optionally at a page).", inputSchema: S({ key: { type: "string" }, page: { type: "integer" } }, ["key"]), run: toolOpen },
    {
      name: "find_papers",
      description: "Search published research beyond the user's library (OpenAlex by default, or Semantic Scholar). Returns papers with ids, DOI/arXiv, venue, citation count, open-access PDF link and a short abstract; papers the user already has carry in_library (their item key). Keyword searches use a small shared daily quota, so prefer a few well-chosen queries.",
      inputSchema: S({
        query: { type: "string" },
        source: { type: "string", enum: ["openalex", "semantic_scholar"] },
        from_year: { type: "integer" }, to_year: { type: "integer" },
        sort: { type: "string", enum: ["relevance", "citations", "newest"] },
        open_access: { type: "boolean", description: "Only papers with a free full text" },
        limit: { type: "integer", description: "1–50, default 10" },
      }, ["query"]),
      run: toolFindPapers,
    },
    {
      name: "get_paper",
      description: "Full record for one paper from OpenAlex and Semantic Scholar: all authors, full abstract, TL;DR, keywords, citation and reference counts, PDF link, in_library. `paper` is a Zotero item key, DOI, arXiv id, OpenAlex id (W…), Semantic Scholar id, or a title.",
      inputSchema: S({ paper: { type: "string" } }, ["paper"]),
      run: toolGetPaper,
    },
    {
      name: "related_papers",
      description: "Walk the citation graph from one paper: `citations` (papers citing it), `references` (papers it cites), or `similar` (Semantic Scholar recommendations, which favour recent work). `paper` accepts the same ids as get_paper, including a Zotero item key.",
      inputSchema: S({
        paper: { type: "string" },
        relation: { type: "string", enum: ["citations", "references", "similar"] },
        sort: { type: "string", enum: ["citations", "newest"], description: "citations/references only; default citations" },
        limit: { type: "integer", description: "1–50, default 20" },
      }, ["paper"]),
      run: toolRelatedPapers,
    },
    {
      name: "propose_changes",
      description: "The ONLY way to change the library. Submits a batch of changes that the user reviews (accepts/rejects each) in Zotero; nothing is written before approval and every applied batch can be undone. Group related edits into one call. With wait=true (default) returns the outcome per change, including the user's feedback.",
      inputSchema: S({ title: { type: "string", description: "Short summary shown to the user" }, rationale: { type: "string" }, changes: { type: "array", items: CHANGE_SCHEMA }, wait: { type: "boolean" } }, ["title", "changes"]),
      run: (args, caller) => propose(args, caller),
    },
    { name: "get_proposal", description: "Status of an earlier proposal.", inputSchema: S({ id: { type: "integer" } }, ["id"]), run: ({ id }) => { const p = proposals.get(id); if (!p) throw new Error("Unknown proposal"); return summary(p); } },
  ];

  const INSTRUCTIONS = `Tools for the user's Zotero desktop library (My Library only; group libraries are out of scope).
Read freely. Change the library ONLY through propose_changes: the user reviews every change in Zotero before it is applied.
find_papers, get_paper and related_papers look up papers outside the library (OpenAlex, Semantic Scholar). Results the user already has carry in_library; link those as library items.
Link items in replies as [Title](zotero://select/library/items/KEY) and PDF pages as [p. N](zotero://open-pdf/library/items/ATTACHMENT_KEY?page=N).`;

  async function handleMcp(req) {
    if (!checkAuth(req.headers)) return [403, "application/json", JSON.stringify({ error: "invalid or missing bearer token" })];
    if (req.method === "GET") return [405, "text/plain", "SSE stream not supported"];
    if (req.method === "DELETE") return [200, "application/json", "{}"];
    // Finch's own chats send X-Finch-Chat, so their tools act on that chat's tab; others (terminal) get the selected tab.
    const caller = { source: req.headers["x-finch-source"] || "terminal", tabID: chatTab(req.headers["x-finch-chat"]) };
    const msgs = Array.isArray(req.data) ? req.data : [req.data];
    const out = [];
    for (const m of msgs) {
      if (!m || m.id === undefined || m.id === null) continue; // notification
      out.push(await rpc(m, caller));
    }
    if (!out.length) return [202, "application/json", ""];
    return [200, "application/json", JSON.stringify(Array.isArray(req.data) ? out : out[0])];
  }

  async function rpc(m, caller = { source: "terminal", tabID: null }) {
    const ok = (result) => ({ jsonrpc: "2.0", id: m.id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id: m.id, error: { code, message } });
    try {
      switch (m.method) {
        case "initialize":
          return ok({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "zotero", version }, instructions: INSTRUCTIONS });
        case "ping": return ok({});
        case "tools/list": return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case "tools/call": {
          const tool = TOOLS.find((t) => t.name === m.params?.name);
          if (!tool) return fail(-32602, "Unknown tool " + m.params?.name);
          emit({ type: "tool-call", name: tool.name, source: caller.source });
          try {
            const r = await tool.run(m.params.arguments || {}, caller);
            return ok({ content: [{ type: "text", text: JSON.stringify(r, null, 1) }] });
          } catch (e) {
            return ok({ content: [{ type: "text", text: "Error: " + e.message }], isError: true });
          }
        }
        case "resources/list": return ok({ resources: [] });
        case "prompts/list": return ok({ prompts: [] });
        default: return fail(-32601, "Method not found: " + m.method);
      }
    } catch (e) { Zotero.logError(e); return fail(-32603, e.message); }
  }

  function registerEndpoint() {
    Object.assign(Zotero.Server.responseCodes, { 202: "Accepted", 405: "Method Not Allowed" });
    const E = function () {};
    E.prototype = { supportedMethods: ["GET", "POST", "DELETE"], supportedDataTypes: ["application/json"], init: function (req) { return handleMcp(req); } };
    Zotero.Server.Endpoints[MCP_PATH] = E;
    Zotero.Server.Endpoints[LEGACY.mcpPath] = E; // keeps `claude mcp add` setups made under the old name working
  }

  // ------------------------------------------------------------------ 5. Claude sessions
  async function claudePath() {
    const cands = [getPref("claudePath"), PathUtils.join(HOME, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].filter(Boolean);
    for (const c of cands) if (await IOUtils.exists(c)) return c;
    throw new Error("Claude Code CLI not found. Install it (https://claude.com/claude-code) or set extensions.finch.claudePath");
  }
  function env() {
    const path = [PathUtils.join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
    return { PATH: path, ZOTERO_CLAUDE: "1" };
  }
  function modelArgs(model = getPref("model")) { return model ? ["--model", model] : []; }
  // Run `claude` to completion and return its combined stdout/stderr.
  async function runClaude(args, cwd) {
    const proc = await Subprocess.call({ command: await claudePath(), arguments: args, workdir: cwd, environment: env(), environmentAppend: true, stderr: "stdout" });
    let out = "";
    while (true) { const s = await proc.stdout.readString(); if (!s) break; out += s; }
    await proc.wait();
    return out;
  }
  function mcpConfig(source, chat) {
    const headers = { Authorization: "Bearer " + token(), "X-Finch-Source": source, ...(chat ? { "X-Finch-Chat": chat } : {}) };
    return JSON.stringify({ mcpServers: { zotero: { type: "http", url: mcpURL(), headers } } });
  }

  const SYSTEM = `You are Claude Code running inside the Zotero desktop app as the engine of Finch, a research-companion plugin.
- Each user message begins with a <zotero_context> block: what the user is looking at (open PDF + page, selected items, collection, selected text, @-mentioned items). Use it to resolve "this paper", "this page", "the selection".
- Use the mcp__zotero__* tools to read the library. To find papers the user doesn't have, use find_papers, get_paper and related_papers; link those by DOI or URL. Change the library ONLY with mcp__zotero__propose_changes (the user reviews each change in Zotero). Put related edits in one proposal.
- To mark up a PDF, propose "highlight" changes with exact quotes (copy text from get_page_text) or use_selection, or "add_page_comment".
- Link items as [Title](zotero://select/library/items/KEY) and pages as [p. N](zotero://open-pdf/library/items/ATTACHMENT_KEY?page=N).
- Write math in LaTeX: $…$ inline, $$…$$ on its own line for display (rendered in the chat and in notes). Write a literal dollar sign as \\$.
- Only My Library is in scope. Never touch files in the Zotero data directory.
- The working directory is this project's workspace folder; keep durable notes in NOTES.md there when asked to remember something.`;

  // ------------------------------------------------------------------ 5a. workspaces
  // A workspace is a standalone folder under workspacesDir() with a stable id (never derived from collections):
  //   <slug>-<id>/workspace.json   {id, name, created, lastUsed, archived}
  //   <slug>-<id>/CLAUDE.md        instructions Claude reads in every chat of this workspace
  //   <slug>-<id>/chats/<sessionId>.json   saved transcripts (title, timestamps, entries) for resume
  // Renaming only changes workspace.json, so folders and links survive any reorganisation of the library.
  // Folders without workspace.json (from earlier versions) are adopted as workspaces on load.
  const workspaces = new Map();

  function slugify(s) { return String(s).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 40) || "workspace"; }

  async function writeWorkspace(ws) {
    const { dir, chatCount, ...json } = ws;
    await IOUtils.writeJSON(PathUtils.join(dir, "workspace.json"), json);
  }

  async function loadWorkspaces() {
    const root = workspacesDir();
    await ensureDir(root);
    workspaces.clear();
    let hadJSON = false;
    for (const dir of await IOUtils.getChildren(root)) {
      const base = PathUtils.filename(dir);
      if (base.startsWith(".")) continue;
      const info = await IOUtils.stat(dir).catch(() => null);
      if (!info || info.type !== "directory") continue;
      const file = PathUtils.join(dir, "workspace.json");
      let ws;
      if (await IOUtils.exists(file)) {
        try { ws = await IOUtils.readJSON(file); hadJSON = true; } catch (e) { log("bad workspace.json in " + base); continue; }
      } else {
        ws = { id: Zotero.Utilities.randomString(8).toLowerCase(), name: base, created: Date.now(), lastUsed: 0, archived: false };
        await IOUtils.writeJSON(file, ws);
      }
      ws.dir = dir;
      ws.chatCount = (await IOUtils.getChildren(PathUtils.join(dir, "chats")).catch(() => [])).filter((f) => f.endsWith(".json")).length;
      workspaces.set(ws.id, ws);
    }
    // First run of the workspace feature (or nothing active): make sure a default "General" workspace exists.
    if (!hadJSON || ![...workspaces.values()].some((w) => !w.archived)) {
      if (![...workspaces.values()].some((w) => w.name === "General")) await createWorkspace("General");
    }
    emit({ type: "workspaces" });
  }

  async function createWorkspace(name) {
    name = String(name || "").trim();
    if (!name) throw new Error("Workspace name is empty");
    const id = Zotero.Utilities.randomString(8).toLowerCase();
    const dir = PathUtils.join(workspacesDir(), `${slugify(name)}-${id}`);
    await ensureDir(PathUtils.join(dir, "chats"));
    const ws = { id, name, created: Date.now(), lastUsed: Date.now(), archived: false, dir, chatCount: 0 };
    await writeWorkspace(ws);
    await IOUtils.writeUTF8(PathUtils.join(dir, "CLAUDE.md"),
      `# ${name}\n\nInstructions and notes for this workspace. Claude reads this file at the start of every chat here.\nAdd goals, conventions, reading lists, or anything Claude should remember.\n`);
    workspaces.set(id, ws);
    emit({ type: "workspaces" });
    return ws;
  }

  async function renameWorkspace(id, name) {
    const ws = workspaces.get(id);
    if (!ws || !String(name).trim()) return;
    ws.name = String(name).trim();
    await writeWorkspace(ws);
    emit({ type: "workspaces" });
  }

  async function archiveWorkspace(id, archived) {
    const ws = workspaces.get(id);
    if (!ws) return;
    if (archived && [...workspaces.values()].filter((w) => !w.archived).length === 1) throw new Error("Keep at least one active workspace");
    ws.archived = !!archived;
    await writeWorkspace(ws);
    if (archived) {
      if (getPref("currentWorkspace") === id) setPref("currentWorkspace", listWorkspaces()[0].id);
      for (const slot of slots.values()) if (slot.workspaceId === id) resetSlot(slot, listWorkspaces()[0].id);
    }
    emit({ type: "workspaces" });
  }

  function listWorkspaces({ archived = false } = {}) {
    return [...workspaces.values()].filter((w) => archived || !w.archived).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || a.name.localeCompare(b.name));
  }

  function currentWorkspace() {
    const ws = workspaces.get(getPref("currentWorkspace"));
    if (ws && !ws.archived) return ws;
    return listWorkspaces()[0];
  }

  // Switching changes only the given tab: it gets a fresh chat (started lazily, on the next message) in that
  // workspace, which also becomes the default for new tabs. The previous chat stays saved and resumable.
  async function switchWorkspace(id, slot = currentSlot()) {
    const ws = workspaces.get(id);
    if (!ws) throw new Error("Unknown workspace");
    setPref("currentWorkspace", id);
    ws.lastUsed = Date.now();
    await writeWorkspace(ws);
    if (slot.workspaceId !== id || (slot.session && slot.session.workspace.id !== id)) resetSlot(slot, id);
    emit({ type: "workspaces" });
  }

  async function listChats(id) {
    const ws = workspaces.get(id);
    if (!ws) return [];
    const dir = PathUtils.join(ws.dir, "chats");
    const out = [];
    for (const f of await IOUtils.getChildren(dir).catch(() => [])) {
      if (!f.endsWith(".json")) continue;
      try { const c = await IOUtils.readJSON(f); out.push({ sessionId: c.sessionId, title: c.title, created: c.created, updated: c.updated, messages: (c.entries || []).filter((e) => e.kind === "user").length }); }
      catch (e) {}
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  // Delete a saved chat: Finch's transcript and Claude Code's session for it. Tabs showing it get a fresh chat.
  // Claude Code's session is kept while a fork in this workspace has not had its first turn yet, since that turn
  // copies from it.
  async function deleteChat(id, sessionId) {
    const ws = workspaces.get(id);
    if (!ws || !sessionId) throw new Error("Unknown chat");
    const open = findOpenChat(sessionId);
    if (open?.running) throw new Error("Wait for Finch to finish (or stop it) before deleting this chat.");
    if (open) open.deleted = true; // closing it below must not save it again
    for (const slot of slots.values()) if (slot.sessionId === sessionId || slot.session?.sessionId === sessionId) resetSlot(slot, ws.id);
    const dir = PathUtils.join(ws.dir, "chats");
    const file = PathUtils.join(dir, sessionId + ".json");
    const existed = await IOUtils.exists(file);
    await IOUtils.remove(file, { ignoreAbsent: true });
    let forkSource = false;
    for (const f of await IOUtils.getChildren(dir).catch(() => [])) {
      if (!f.endsWith(".json")) continue;
      try { if ((await IOUtils.readJSON(f)).forkFrom?.from === sessionId) { forkSource = true; break; } } catch (e) {}
    }
    if (!forkSource) {
      const cc = claudeProjectDir(ws.dir);
      await IOUtils.remove(PathUtils.join(cc, sessionId + ".jsonl"), { ignoreAbsent: true });
      await IOUtils.remove(PathUtils.join(cc, sessionId), { recursive: true, ignoreAbsent: true });
    }
    if (existed) ws.chatCount = Math.max(0, (ws.chatCount || 0) - 1);
    emit({ type: "workspaces" });
  }

  // Open a saved chat in the given tab. A chat that is already open in another tab is shared, not loaded twice.
  async function resumeChat(id, sessionId, slot = currentSlot()) {
    const ws = workspaces.get(id);
    if (!ws) throw new Error("Unknown workspace");
    setPref("currentWorkspace", id);
    const s = findOpenChat(sessionId) || (await loadChat(ws, sessionId));
    if (!s) throw new Error("Could not read this chat");
    setSlotSession(slot, s);
    return s;
  }

  // A saved chat as a Session (no process until its next turn), or null if the file is missing or unreadable.
  // Concurrent loads of the same chat share one promise, so there is never more than one Session per chat.
  const loadingChats = new Map();
  function loadChat(ws, sessionId) {
    if (!ws || !sessionId) return Promise.resolve(null);
    if (loadingChats.has(sessionId)) return loadingChats.get(sessionId);
    const p = (async () => {
      try {
        const c = await IOUtils.readJSON(PathUtils.join(ws.dir, "chats", sessionId + ".json"));
        const entries = (c.entries || []).map((e) => (e.kind === "permission" && e.status === "pending" ? { ...e, status: "expired" } : e));
        return findOpenChat(sessionId) || new Session(ws, { resumeId: sessionId, entries, title: c.title, created: c.created, forkFrom: c.forkFrom });
      } catch (e) { return null; }
      finally { loadingChats.delete(sessionId); }
    })();
    loadingChats.set(sessionId, p);
    return p;
  }

  // A chat. It has no process of its own between turns: each turn starts `claude -p` (with --resume once the
  // chat has a session id), writes the message, reads until the `result`, then closes stdin so the process exits.
  // Messages sent while a turn is running wait in `queue` and go to the same process when the turn ends.
  // Fork points: each user entry gets `turn` (its turn number) when it is actually sent, and at the end of a turn
  // the last reply entry gets `forkAt` (the uuid of Claude Code's last assistant message) and `forkTurn`.
  // A fork that has not had its first turn yet has `forkFrom` {from, at}: see forkChat.
  class Session {
    constructor(workspace, { resumeId, sessionId, forkFrom, entries, title, created } = {}) {
      this.workspace = workspace;
      this.key = Zotero.Utilities.randomString(12); // sent with this chat's tool calls (X-Finch-Chat)
      this.entries = (entries || []).map((e, i) => ({ ...e, id: i, streaming: false }));
      this.state = "idle";
      this.sessionId = resumeId || sessionId || null;
      this.resumeId = resumeId || null;
      this.forkFrom = forkFrom || null;
      this.turnSeq = Math.max(0, ...this.entries.map((e) => e.turn || 0));
      this.title = title || null;
      this.created = created || Date.now();
      this.pendingPerms = new Map();
      this.queue = [];
      this.proc = null;
      this.running = false; // a turn is starting or running (set before the process exists)
    }
    add(entry) { entry.id = this.entries.length; this.entries.push(entry); emit({ type: "entry", session: this, entry }); this.scheduleSave(); return entry; }
    update(entry) { emit({ type: "entry-update", session: this, entry }); if (!entry.streaming) this.scheduleSave(); }

    scheduleSave() {
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.save().catch((e) => Zotero.logError(e)), 800);
    }
    async save() {
      const first = this.entries.find((e) => e.kind === "user");
      if (!this.sessionId || !first || this.deleted) return;
      if (!this.title) this.title = first.text.replace(/@\[([^\]]*)\]\([A-Z0-9]{8}\)/g, "$1").slice(0, 80);
      const dir = PathUtils.join(this.workspace.dir, "chats");
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      const entries = this.entries.filter((e) => e.kind !== "permission" || e.status !== "pending").map(({ id, streaming, queued, ...e }) => e);
      await IOUtils.writeJSON(PathUtils.join(dir, this.sessionId + ".json"),
        { sessionId: this.sessionId, workspaceId: this.workspace.id, title: this.title, created: this.created, updated: Date.now(), model: this.model,
          ...(this.forkFrom ? { forkFrom: this.forkFrom } : {}), entries });
      if (this._oldId) { await IOUtils.remove(PathUtils.join(dir, this._oldId + ".json"), { ignoreAbsent: true }); this._oldId = null; }
      if (!this._counted) { this._counted = true; if (!this.resumeId) { this.workspace.chatCount = (this.workspace.chatCount || 0) + 1; emit({ type: "workspaces" }); } }
    }
    setState(s) { this.state = s; emit({ type: "state", session: this }); }

    // Start a process for one turn and give it `payload` (a stream-json user message).
    async runTurn(payload, entry) {
      this.running = true;
      this.setState("busy");
      let proc;
      try {
        await IOUtils.makeDirectory(this.workspace.dir, { ignoreExisting: true });
        const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
          "--permission-prompt-tool", "stdio", "--mcp-config", mcpConfig("chat", this.key), "--strict-mcp-config", "--allowedTools", "mcp__zotero",
          "--append-system-prompt", SYSTEM, ...modelArgs()];
        // A fork's first turn copies its source into a new session with the id chosen in forkChat, cut off after
        // the fork point (--resume-session-at), so the model never sees what was said later in the source.
        if (this.forkFrom) args.push("--resume", this.forkFrom.from, "--fork-session", "--session-id", this.sessionId,
          ...(this.forkFrom.at ? ["--resume-session-at", this.forkFrom.at] : []));
        else if (this.sessionId) args.push("--resume", this.sessionId);
        proc = this.proc = await Subprocess.call({ command: await claudePath(), arguments: args, workdir: this.workspace.dir, environment: env(), environmentAppend: true, stderr: "pipe" });
      } catch (e) {
        this.proc = null; this.running = false;
        this.add({ kind: "status", text: "Could not start Claude Code: " + e.message });
        this.dropQueue("not sent");
        this.setState("idle");
        return;
      }
      this.turnDone = false;
      const stderr = this.readErr(proc);
      this.beginTurn(payload, entry);
      await this.readLoop(proc);
      const code = await proc.wait().then((r) => r.exitCode).catch(() => -1);
      const err = this.turnDone ? "" : await stderr;
      // From here on no awaits: a message sent now must find the chat either busy or fully idle.
      clearTimeout(this._killTimer);
      if (this.proc === proc) this.proc = null;
      this.running = false;
      if (!this.turnDone) {
        this.live = null;
        this.add({ kind: "status", text: `Claude Code exited (code ${code}).${err ? " " + err.slice(-500) : ""}` });
      }
      for (const id of [...this.pendingPerms.keys()]) this.expirePermission(id);
      this.dropQueue("not sent");
      this.setState("idle");
    }

    async readLoop(proc) {
      let buf = "";
      try {
        while (true) {
          const s = await proc.stdout.readString();
          if (!s) break;
          buf += s;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            let m; try { m = JSON.parse(line); } catch (e) { log("bad line " + line.slice(0, 200)); continue; }
            try { this.onMessage(m); } catch (e) { Zotero.logError(e); }
          }
        }
      } catch (e) { Zotero.logError(e); }
    }
    async readErr(proc) {
      let err = "";
      try { while (true) { const s = await proc.stderr.readString(); if (!s) break; err = (err + s).slice(-4000); } } catch (e) {}
      return err;
    }

    onMessage(m) {
      if (m.type === "system" && m.subtype === "status" && m.status === "compacting") {
        if (!this.compactEntry) this.compactEntry = this.add({ kind: "status", divider: true, text: "Compacting the conversation…" });
        return;
      }
      if (m.type === "system" && m.subtype === "compact_boundary") {
        const md = m.compact_metadata || {};
        const n = (x) => (typeof x === "number" ? x.toLocaleString() : "?");
        const e = this.compactEntry || this.add({ kind: "status", divider: true, text: "" });
        e.text = `Compacted${md.trigger === "auto" ? " automatically" : ""}: ${n(md.pre_tokens)} → ${n(md.post_tokens)} tokens. Finch now works from a summary of the messages above.`;
        this.update(e);
        this.compactEntry = null;
        return;
      }
      if (m.type === "system" && m.subtype === "init") {
        if (this.forkFrom) this.forkFrom = null; // the fork now has its own session
        if (this.sessionId && m.session_id !== this.sessionId) this._oldId = this.sessionId;
        this.sessionId = m.session_id; this.model = m.model; emit({ type: "state", session: this }); return;
      }
      if (m.type === "stream_event") {
        const ev = m.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          if (!this.live) this.live = this.add({ kind: "assistant", text: "", streaming: true });
          this.live.text += ev.delta.text;
          this.update(this.live);
        }
        return;
      }
      if (m.type === "assistant") {
        if (m.uuid && !m.parent_tool_use_id) this.turnUuid = m.uuid; // not a subagent's message
        for (const b of m.message?.content || []) {
          if (b.type === "text") {
            if (this.live) { this.live.text = b.text; this.live.streaming = false; this.update(this.live); this.live = null; }
            else this.add({ kind: "assistant", text: b.text });
          } else if (b.type === "tool_use") {
            this.live = null;
            this.add({ kind: "tool", name: b.name, input: b.input, toolUseId: b.id });
          }
        }
        return;
      }
      if (m.type === "user") {
        for (const b of m.message?.content || []) {
          if (b.type === "tool_result" && b.is_error) {
            const t = this.entries.find((e) => e.kind === "tool" && e.toolUseId === b.tool_use_id);
            if (t) { t.error = typeof b.content === "string" ? b.content : JSON.stringify(b.content); this.update(t); }
          }
        }
        return;
      }
      if (m.type === "control_request") {
        const r = m.request || {};
        if (r.subtype === "can_use_tool") {
          const e = this.add({ kind: "permission", requestId: m.request_id, tool: r.tool_name, input: r.input, description: r.description, status: "pending" });
          this.pendingPerms.set(m.request_id, e);
          openChat({ focus: true });
        } else {
          this.write({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "Unsupported by Finch: " + r.subtype } });
        }
        return;
      }
      if (m.type === "result") {
        this.live = null;
        clearTimeout(this._killTimer);
        if (this._stopping) this.add({ kind: "status", text: "Stopped." });
        else if (m.is_error || m.subtype !== "success") this.add({ kind: "status", text: `Turn ended: ${m.subtype}${m.result ? " — " + String(m.result).slice(0, 300) : ""}` });
        this._stopping = false;
        this.markForkPoint();
        // The next queued message goes to this same process; otherwise let it exit.
        const next = this.queue.shift();
        if (next) {
          if (next.entry) { next.entry.queued = false; this.update(next.entry); }
          this.beginTurn(next.payload, next.entry);
        } else {
          this.turnDone = true;
          try { this.proc?.stdin.close(); } catch (e) {}
        }
      }
    }

    write(obj) { return this.proc?.stdin.write(JSON.stringify(obj) + "\n"); }

    // Write a user message to the running process as a new turn (`entry` is its chat entry; none for /compact).
    beginTurn(payload, entry) {
      this.turnUuid = null;
      this.turnStart = this.entries.length;
      this.turnNo = ++this.turnSeq;
      if (entry) { entry.turn = this.turnNo; this.scheduleSave(); }
      this.write(payload);
    }
    // At the end of a turn: its last reply (text, else a tool call) becomes a point the chat can be forked from.
    markForkPoint() {
      if (!this.turnUuid) return;
      const turn = this.entries.slice(this.turnStart);
      const e = turn.findLast((x) => x.kind === "assistant") || turn.findLast((x) => x.kind === "tool");
      if (e) { e.forkAt = this.turnUuid; e.forkTurn = this.turnNo; this.update(e); }
      this.turnUuid = null;
    }

    // Send now, or after the running turn if there is one.
    submit(payload, entry) {
      if (this.running) {
        if (entry) { entry.queued = true; this.update(entry); }
        this.queue.push({ payload, entry });
      } else {
        this.runTurn(payload, entry);
      }
    }

    send(text, ctx) {
      const contextBlock = `<zotero_context>\n${JSON.stringify(ctx, null, 1)}\n</zotero_context>\n\n`;
      const entry = this.add({ kind: "user", text, ctx });
      this.submit({ type: "user", message: { role: "user", content: [{ type: "text", text: contextBlock + text }] } }, entry);
    }

    // Claude Code's own /compact: summarise the conversation so far (optional focus instructions).
    compact(instructions) {
      this.compactEntry = this.add({ kind: "status", divider: true, text: "Compacting the conversation…" });
      const text = "/compact" + (instructions ? " " + instructions : "");
      this.submit({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    }

    // Queued messages that will not be sent after all (the turn was stopped or failed).
    dropQueue(why) {
      for (const q of this.queue.splice(0)) if (q.entry) { q.entry.queued = false; q.entry.unsent = why; this.update(q.entry); }
    }

    answerPermission(requestId, allow, message) {
      const e = this.pendingPerms.get(requestId);
      if (!e) return;
      this.pendingPerms.delete(requestId);
      e.status = allow ? "allowed" : "denied";
      this.update(e);
      const response = allow ? { behavior: "allow", updatedInput: e.input } : { behavior: "deny", message: message || "The user denied this action." };
      this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
    }
    expirePermission(requestId) {
      const e = this.pendingPerms.get(requestId);
      if (!e) return;
      this.pendingPerms.delete(requestId);
      e.status = "expired";
      this.update(e);
    }

    // Stop the running turn (and drop what was queued behind it). The process is killed if it doesn't end the turn.
    interrupt() {
      this.dropQueue("stopped");
      if (!this.proc) return;
      this._stopping = true;
      this.write({ type: "control_request", request_id: Zotero.Utilities.randomString(16), request: { subtype: "interrupt" } });
      const p = this.proc;
      clearTimeout(this._killTimer);
      this._killTimer = setTimeout(() => { if (this.proc === p) { try { p.kill(); } catch (e) {} } }, 5000);
    }

    // Closing the chat (new chat, workspace switch, shutdown): end any running turn and save.
    async stop() {
      for (const id of [...this.pendingPerms.keys()]) this.answerPermission(id, false, "Chat closed");
      this.interrupt();
      clearTimeout(this._saveTimer);
      await this.save().catch((e) => Zotero.logError(e));
    }
  }

  // ------------------------------------------------------------------ 5b. tabs: one chat + panel state per tab
  // Every Zotero tab (the library tab included) has a slot: its own chat plus the panel state shown for it
  // (open page, draft, attachments, scroll). Every Finch panel (library pane, reader pane, pop-out window)
  // shows the slot of the selected tab. What survives a restart is in ui-state.json next to changes.jsonl:
  //   tabs[slotId]   {workspaceId, sessionId, page, paper, lastActive}; a tab finds its slot again through
  //                  tab.data.finchSlot, which Zotero saves with its own tabs (session.json)
  //   papers[key]    the same for the most recently used tab of a closed paper, picked up when it is reopened
  // Drafts and attachments are kept in memory only.
  const LIBRARY_TAB = "zotero-pane";
  const slots = new Map(); // Zotero tab id -> slot
  let uiState = { tabs: {}, papers: {} };
  let lastSlot = null;

  function uiStateFile() { return PathUtils.join(workspaceRoot(), "ui-state.json"); }
  async function loadUiState() {
    try { const j = await IOUtils.readJSON(uiStateFile()); uiState = { tabs: j.tabs || {}, papers: j.papers || {} }; } catch (e) {}
  }
  function snapshot(slot) {
    const ses = slot.session;
    return { workspaceId: ses ? ses.workspace.id : slot.workspaceId, sessionId: ses ? ses.sessionId : slot.sessionId, page: slot.page || null, paper: slot.paper, lastActive: slot.lastActive };
  }
  let uiSaveTimer = null;
  function saveUiState(now = false) {
    clearTimeout(uiSaveTimer);
    const write = async () => {
      for (const slot of slots.values()) uiState.tabs[slot.id] = snapshot(slot);
      const newest = (o, n) => Object.fromEntries(Object.entries(o).sort((x, y) => (y[1].lastActive || 0) - (x[1].lastActive || 0)).slice(0, n));
      uiState = { tabs: newest(uiState.tabs, 100), papers: newest(uiState.papers, 200) };
      try { await ensureDir(workspaceRoot()); await IOUtils.writeJSON(uiStateFile(), uiState); } catch (e) { Zotero.logError(e); }
    };
    if (now) return write();
    uiSaveTimer = setTimeout(write, 500);
  }

  function mainTabs() { return Zotero.getMainWindow()?.Zotero_Tabs || null; }
  function tabInfo(tabID) { try { return mainTabs()?._getTab(tabID)?.tab || null; } catch (e) { return null; } }

  // The slot of a tab, created on first use: from its own saved slot (after a restart), else from the most
  // recently used open tab of the same paper (a duplicated tab shares its chat), else from the paper's last
  // closed tab, else a fresh chat in the default workspace.
  function slotFor(tabID) {
    let slot = slots.get(tabID);
    if (slot) return slot;
    const tab = tabInfo(tabID);
    const lib = tabID === LIBRARY_TAB;
    const item = !lib && tab?.data?.itemID ? Zotero.Items.get(tab.data.itemID) : null;
    const known = lib ? "library" : (tab?.data?.finchSlot || tab?.data?.[LEGACY.tabSlot]);
    slot = { id: known || Zotero.Utilities.randomString(10), tabID, paper: item ? item.key : null, workspaceId: null, sessionId: null, session: null,
      page: null, draft: "", attached: [], scroll: null, lastActive: 0 };
    const saved = known && uiState.tabs[known];
    const twin = !saved && slot.paper && [...slots.values()].filter((x) => x.paper === slot.paper).sort((x, y) => y.lastActive - x.lastActive)[0];
    if (twin) Object.assign(slot, snapshot(twin), { session: twin.session, lastActive: 0 });
    else if (saved || (slot.paper && uiState.papers[slot.paper])) {
      const from = saved || uiState.papers[slot.paper];
      Object.assign(slot, { workspaceId: from.workspaceId, sessionId: from.sessionId || null, page: from.page || null });
    }
    const ws = workspaces.get(slot.workspaceId);
    if (!ws || ws.archived) Object.assign(slot, { workspaceId: currentWorkspace()?.id, sessionId: null, session: null });
    slot.paper = slot.paper || null;
    slots.set(tabID, slot);
    if (!lib && !known && tab) { try { mainTabs().setTabData(tabID, { finchSlot: slot.id }); } catch (e) { Zotero.logError(e); } }
    saveUiState();
    return slot;
  }
  function currentSlot() { const tabs = mainTabs(); return slotFor(tabs?.selectedID || LIBRARY_TAB); }
  function slotWorkspace(slot) { return slot.session?.workspace || workspaces.get(slot.workspaceId) || currentWorkspace(); }

  // The chat open in some tab with this session id, if any.
  function findOpenChat(sessionId) {
    if (!sessionId) return null;
    for (const slot of slots.values()) if (slot.session?.sessionId === sessionId) return slot.session;
    return null;
  }
  // The slot's chat, loaded from its saved file on first use; null for a fresh chat that has no messages yet.
  async function slotSession(slot) {
    if (slot.session || !slot.sessionId) return slot.session;
    const sid = slot.sessionId;
    const s = findOpenChat(sid) || (await loadChat(workspaces.get(slot.workspaceId), sid));
    if (slot.sessionId === sid && !slot.session) {
      if (s) slot.session = s; else { slot.sessionId = null; saveUiState(); }
    }
    return slot.session;
  }
  function setSlotSession(slot, s) {
    const old = slot.session;
    Object.assign(slot, { session: s, sessionId: s?.sessionId || null, workspaceId: s ? s.workspace.id : slot.workspaceId });
    saveUiState();
    emit({ type: "slot", slot });
    if (old && old !== s) release(old);
  }
  // A fresh chat (no messages yet) in `workspaceId` for this tab.
  function resetSlot(slot, workspaceId) {
    const old = slot.session;
    Object.assign(slot, { session: null, sessionId: null, workspaceId });
    saveUiState();
    emit({ type: "slot", slot });
    if (old) release(old);
  }
  // A chat no tab shows any more is closed: a running turn is stopped and the transcript saved.
  function release(s) {
    if (s && ![...slots.values()].some((x) => x.session === s)) s.stop().catch((e) => Zotero.logError(e));
  }

  async function newSession(slot = currentSlot(), opts = {}) {
    const ws = opts.workspace || slotWorkspace(slot);
    ws.lastUsed = Date.now();
    writeWorkspace(ws).catch((e) => Zotero.logError(e));
    const s = new Session(ws, opts);
    setSlotSession(slot, s);
    return s;
  }
  // A new chat in the same workspace that continues `src` from the end of the turn that produced entry `entryId`
  // (from its end when null), shown in this tab; `src` stays saved and resumable. The new session id is chosen
  // here so the fork is saved at once; Claude Code makes the copy on its first turn (see runTurn), cut off at the
  // fork point, so neither the model nor the transcript sees anything said after it.
  async function forkChat(slot, src, entryId = null) {
    if (!src) throw new Error("Nothing to fork yet.");
    if (src.running) throw new Error("Wait for Finch to finish (or stop it) before forking.");
    // A fork that has not had its first turn yet has no session of its own: fork its source instead.
    const base = src.forkFrom || (src.sessionId && { from: src.sessionId, at: null });
    if (!base || !src.entries.some((e) => e.kind === "user" && !e.unsent)) throw new Error("Nothing to fork yet.");
    let upto = src.entries.length - 1, at = base.at, turn = Infinity;
    if (entryId !== null) {
      const e = src.entries[entryId];
      if (!e?.forkAt) throw new Error("This chat can't be forked from that message.");
      upto = entryId; at = e.forkAt; turn = e.forkTurn;
    }
    // Messages typed while that turn ran (queued, sent in a later turn) sit above its reply: leave them out.
    const entries = src.entries.slice(0, upto + 1)
      .filter((e) => !(e.kind === "user" && (e.unsent || e.queued || e.turn > turn)))
      .map(({ id, streaming, queued, ...e }) => e);
    const name = (src.title || "Chat").replace(/ \(fork\)$/, "");
    const s = new Session(src.workspace, { entries, title: name + " (fork)", sessionId: Services.uuid.generateUUID().toString().slice(1, -1), forkFrom: { from: base.from, at } });
    s.add({ kind: "status", divider: true, text: `Forked from “${name}”. Later messages there are not part of this chat.` });
    src.workspace.lastUsed = Date.now();
    writeWorkspace(src.workspace).catch((e) => Zotero.logError(e));
    setSlotSession(slot, s);
    await s.save();
    return s;
  }

  async function getSession(slot = currentSlot()) {
    return (await slotSession(slot)) || newSession(slot);
  }

  // The tab a chat's tool calls act on: the selected tab if it shows this chat, else the most recently used tab
  // showing it; null (= the selected tab) for callers that are not a Finch chat.
  function chatTab(key) {
    if (!key) return null;
    const mine = [...slots.values()].filter((x) => x.session?.key === key);
    const cur = mine.find((x) => x.tabID === mainTabs()?.selectedID);
    return (cur || mine.sort((x, y) => y.lastActive - x.lastActive)[0])?.tabID || null;
  }

  // Chats in other tabs that are waiting for the user (a permission prompt), for the "needs you" bar.
  function attention(slot) {
    const out = [], seen = new Set();
    for (const x of slots.values()) {
      const s = x.session;
      if (!s || s === slot?.session || seen.has(s) || !s.pendingPerms.size) continue;
      seen.add(s);
      out.push({ tabID: x.tabID, title: tabInfo(x.tabID)?.title || (x.tabID === LIBRARY_TAB ? "Library" : "another tab") });
    }
    return out;
  }

  const tabObserver = {
    notify(event, type, ids) {
      if (type !== "tab") return;
      ids = ids.flat();
      if (event === "select") {
        const slot = slotFor(ids[0]);
        if (lastSlot && lastSlot !== slot) lastSlot.lastActive = Date.now();
        slot.lastActive = Date.now();
        lastSlot = slot;
        saveUiState();
        emit({ type: "slot", slot, reason: "select" });
      } else if (event === "close") {
        // Zotero also "closes" a tab when it unloads it in the background, then re-adds it with the same id.
        setTimeout(() => ids.forEach(tabClosed), 0);
      }
    },
  };
  function tabClosed(tabID) {
    if (tabInfo(tabID)) return; // unloaded, not closed
    const slot = slots.get(tabID);
    if (!slot) return;
    slots.delete(tabID);
    delete uiState.tabs[slot.id];
    if (slot.paper && slot.lastActive >= (uiState.papers[slot.paper]?.lastActive || 0)) uiState.papers[slot.paper] = snapshot(slot);
    if (lastSlot === slot) lastSlot = null;
    release(slot.session);
    saveUiState();
  }

  // ------------------------------------------------------------------ 6. auto-processing of new items
  const autoQueue = [];
  let autoRunning = false;
  let annTimer = null;
  const autoObserver = {
    notify(event, type, ids) {
      // Any item change may be an annotation edit/deletion: let an open Explanations page redraw (debounced).
      if (type === "item" && listeners.size) { clearTimeout(annTimer); annTimer = setTimeout(() => emit({ type: "explanations" }), 300); }
      if (event !== "add" || type !== "item" || !getPref("autoProcess")) return;
      if (Zotero.Sync.Runner.syncInProgress) return;
      for (const id of ids) {
        const it = Zotero.Items.get(id);
        if (it && it.libraryID === LIB() && it.isRegularItem() && !it.deleted) {
          setTimeout(() => { autoQueue.push(it.key); runAuto(); }, (getPref("autoProcessDelaySec") || 45) * 1000);
        }
      }
    },
  };

  const AUTO_CLAUDE_MD = `# Inbox (auto-processing)

Instructions Claude follows when a new paper is added to Zotero. Edit to change the behaviour.

- File it into the 1–2 best-fitting EXISTING collections (never create collections; skip anything under "99-Archive").
- Tags: reuse the existing vocabulary — one or two kind:* tags plus up to 4 lowercase topic tags (acronyms upper-case).
- Summary: a child note starting "## Summary (Finch, <date>)" with 3 bullets — Problem / Approach / Results — then "_Auto-generated from the abstract/first pages; verify before citing._"
- If venue, year or DOI is clearly missing but visible in the PDF text, include one update_fields change.
`;

  async function runAuto() {
    if (autoRunning) return;
    autoRunning = true;
    try {
      while (autoQueue.length) {
        const key = autoQueue.shift();
        const it = Zotero.Items.getByLibraryAndKey(LIB(), key);
        if (!it || it.deleted) continue;
        const dir = inboxDir();
        await ensureDir(dir);
        const md = PathUtils.join(dir, "CLAUDE.md");
        if (!(await IOUtils.exists(md))) await IOUtils.writeUTF8(md, AUTO_CLAUDE_MD);
        const prompt = `A new item was added to Zotero: key ${key} ("${it.getDisplayTitle()}"). Today is ${today()}.
Read it (get_item, then get_fulltext with length 8000), read list_collections and list_tags, then call propose_changes ONCE with wait=false and title "New item: <short title>" following the conventions in CLAUDE.md. Then reply with one sentence.`;
        emit({ type: "auto", key, status: "running", title: it.getDisplayTitle() });
        const args = ["-p", prompt, "--output-format", "json", "--mcp-config", mcpConfig("auto"), "--strict-mcp-config", "--allowedTools", "mcp__zotero", "--permission-prompts", "none", ...modelArgs()];
        try {
          const out = await runClaude(args, dir);
          let res = {}; try { res = JSON.parse(out); } catch (e) { res = { result: out.slice(-500) }; }
          emit({ type: "auto", key, status: "done", title: it.getDisplayTitle(), result: res.result });
        } catch (e) { emit({ type: "auto", key, status: "failed", title: it.getDisplayTitle(), result: e.message }); }
      }
    } finally { autoRunning = false; }
  }

  // ------------------------------------------------------------------ windows, sidebar & menus
  // The chat lives in Zotero's right-hand pane: a "Finch" button next to "Notes" in the sidenav swaps the
  // whole pane (library item pane and reader context pane) for a full-height chat, like the Notes pane does.
  // Zotero has no plugin API for full-height panes, so we inject a sibling of the pane's deck and hide the
  // deck while Finch is shown. "Pop out" opens the same UI in its own window.
  const CHAT_URL = "chrome://finch/content/chat.html";
  const XHTML = "http://www.w3.org/1999/xhtml";
  const HOSTS = [
    { id: "library", deck: "#zotero-item-pane-content", sidenav: "#zotero-view-item-sidenav", pane: "#zotero-item-pane" },
    { id: "reader", deck: "#zotero-context-pane-deck", sidenav: "#zotero-context-pane-sidenav", pane: "#zotero-context-pane-inner" },
  ];
  let pendingPrefill = null;
  let sidebarOpen = !!getPref("sidebarOpen");
  const winHandles = new WeakMap();

  function chatWindow() { return Services.wm.getMostRecentWindow("zotero:finch"); }
  function currentHost(win) { return win?.Zotero_Tabs?.selectedType === "library" ? "library" : "reader"; }

  function openWindow() {
    const main = Zotero.getMainWindow();
    const features = "chrome,resizable,dialog=no,width=520,height=780";
    return main ? main.openDialog(CHAT_URL, "finch", features) : Services.ww.openWindow(null, CHAT_URL, "finch", features, null);
  }

  // Show the chat: the pop-out window if it is open, otherwise the sidebar of the current tab.
  function openChat({ focus = true, prefill, window: asWindow = false } = {}) {
    const main = Zotero.getMainWindow();
    let w = chatWindow();
    if (w) {
      if (prefill) emit({ type: "prefill", text: prefill, host: "window" });
      if (focus) w.focus();
      return w;
    }
    if (asWindow || !main || !winHandles.get(main)?.sidebar.length) {
      pendingPrefill = prefill ? { text: prefill, host: "window" } : null;
      setSidebar(false);
      return openWindow();
    }
    const host = currentHost(main);
    if (prefill) { pendingPrefill = { text: prefill, host }; emit({ type: "prefill", text: prefill, host }); }
    setSidebar(true);
    if (focus) emit({ type: "focus", host });
    return main;
  }

  function setSidebar(open) {
    const wasOpen = sidebarOpen;
    sidebarOpen = !!open;
    setPref("sidebarOpen", sidebarOpen);
    for (const win of Zotero.getMainWindows()) {
      const h = winHandles.get(win);
      if (!h) continue;
      for (const m of h.sidebar) {
        m.box.hidden = !sidebarOpen;
        m.deck.hidden = sidebarOpen;
        m.btn.classList.toggle("finch-active", sidebarOpen);
        m.btn.setAttribute("aria-selected", String(sidebarOpen));
      }
      if (sidebarOpen) {
        const pane = win.document.querySelector(HOSTS.find((x) => x.id === currentHost(win)).pane);
        try { if (pane && pane.collapsed) pane.collapsed = false; } catch (e) {}
      }
    }
    if (sidebarOpen && !wasOpen) emit({ type: "slot", reason: "show" }); // panels hidden until now may hold stale drafts
  }
  function toggleChat() {
    const w = chatWindow();
    if (w) return w.focus();
    if (sidebarOpen) setSidebar(false); else openChat();
  }
  function popOut() { setSidebar(false); return openWindow(); }
  function setPendingBadge(on) {
    for (const win of Zotero.getMainWindows()) for (const m of winHandles.get(win)?.sidebar || []) m.btn.classList.toggle("finch-pending", on);
  }

  function installSidebar(win) {
    const doc = win.document;
    const made = [];
    const style = doc.createElementNS(XHTML, "style");
    style.id = "finch-style";
    style.textContent = `
      item-pane-sidenav .btn.finch-btn { background-image: url("chrome://finch/content/icon20.svg"); fill: #5b5fc7; stroke: #5b5fc7; position: relative; }
      item-pane-sidenav .btn.finch-btn.finch-active { background-color: var(--fill-quarternary, rgba(0,0,0,.12)); }
      item-pane-sidenav .btn.finch-btn.finch-pending::after { content: ""; position: absolute; top: 3px; right: 3px; width: 7px; height: 7px; border-radius: 50%; background: #5b5fc7; }
      .finch-pane { min-width: 0; min-height: 0; }
      .finch-pane > iframe { border: 0; flex: 1; width: 100%; min-height: 0; }`;
    doc.documentElement.appendChild(style);
    for (const h of HOSTS) {
      const deck = doc.querySelector(h.deck), nav = doc.querySelector(h.sidenav);
      if (!deck || !nav) { log("sidebar host missing: " + h.id); continue; }
      const box = doc.createXULElement("vbox");
      box.className = "finch-pane";
      box.setAttribute("flex", "1");
      box.hidden = true;
      const frame = doc.createElementNS(XHTML, "iframe");
      frame.setAttribute("src", CHAT_URL);
      frame.dataset.host = h.id;
      box.appendChild(frame);
      deck.after(box);

      const wrap = doc.createElementNS(XHTML, "div");
      wrap.className = "pin-wrapper finch-wrap";
      const btn = doc.createElementNS(XHTML, "div");
      btn.className = "btn finch-btn";
      btn.setAttribute("role", "tab");
      btn.setAttribute("tabindex", "0");
      btn.setAttribute("title", shortcutLabel() ? `Finch (${shortcutLabel()})` : "Finch");
      btn.addEventListener("click", (e) => { e.stopPropagation(); if (e.button === 0) toggleChat(); });
      wrap.appendChild(btn);
      const notes = nav.querySelector('.btn[data-pane="context-notes"]')?.closest(".pin-wrapper");
      if (notes) notes.after(wrap); else nav.appendChild(wrap);
      // Any other sidenav button (Info, Abstract, Notes, …) returns to Zotero's own pane.
      const onNav = (e) => {
        const b = e.target.closest?.(".btn");
        if (b && b !== btn && !b.dataset.action && sidebarOpen) setSidebar(false);
      };
      nav.addEventListener("click", onNav, true);
      made.push({ h, deck, box, wrap, btn, nav, onNav });
    }
    return { made, style };
  }

  function mentionFor(items) { return items.map((i) => `@[${Zotero.Utilities.ellipsize(i.getDisplayTitle(), 50)}](${i.key})`).join(" ") + " "; }

  function onMainWindowLoad(win) {
    const doc = win.document;
    const added = [];
    const mk = (parentId, id, label, cmd) => {
      const parent = doc.getElementById(parentId);
      if (!parent) return;
      const mi = doc.createXULElement("menuitem");
      mi.id = id; mi.setAttribute("label", label);
      mi.addEventListener("command", cmd);
      parent.appendChild(mi);
      added.push(mi);
    };
    mk("menu_ToolsPopup", "finch-tools", shortcutLabel() ? `Finch  (${shortcutLabel()})` : "Finch", () => openChat());
    mk("menu_ToolsPopup", "finch-tools-window", "Finch in a Separate Window", () => popOut());
    mk("zotero-itemmenu", "finch-itemmenu", "Ask Finch about selected", () => {
      const items = win.ZoteroPane.getSelectedItems().filter((i) => i.libraryID === LIB());
      openChat({ prefill: mentionFor(items) });
    });
    const onKey = (e) => {
      if (matchesShortcut(e)) { e.preventDefault(); toggleChat(); }
    };
    win.addEventListener("keydown", onKey, true);
    let sb = { made: [], style: null };
    try { sb = installSidebar(win); } catch (e) { Zotero.logError(e); }
    winHandles.set(win, { added, onKey, sidebar: sb.made, style: sb.style });
    if (sidebarOpen) setSidebar(true);
  }
  function onMainWindowUnload(win) {
    const h = winHandles.get(win);
    if (!h) return;
    h.added.forEach((e) => e.remove());
    win.removeEventListener("keydown", h.onKey, true);
    for (const m of h.sidebar) {
      m.deck.hidden = false;
      m.nav.removeEventListener("click", m.onNav, true);
      m.box.remove();
      m.wrap.remove();
    }
    h.style?.remove();
    winHandles.delete(win);
  }

  // ------------------------------------------------------------------ lifecycle
  let notifierID = null, tabNotifierID = null;
  async function startup() {
    await migrateFromLyra();
    token();
    registerEndpoint();
    await loadWorkspaces().catch((e) => Zotero.logError(e));
    await loadUiState();
    tabNotifierID = Zotero.Notifier.registerObserver(tabObserver, ["tab"], "finch-tabs");
    Zotero.Reader.registerEventListener("renderTextSelectionPopup", onTextSelectionPopup, pluginID);
    notifierID = Zotero.Notifier.registerObserver(autoObserver, ["item"], "finch");
    log(`started v${version}; MCP at ${mcpURL()}`);
  }
  function shutdown() {
    delete Zotero.Server.Endpoints[MCP_PATH];
    delete Zotero.Server.Endpoints[LEGACY.mcpPath];
    if (notifierID) Zotero.Notifier.unregisterObserver(notifierID);
    if (tabNotifierID) Zotero.Notifier.unregisterObserver(tabNotifierID);
    saveUiState(true);
    for (const win of Zotero.getMainWindows()) onMainWindowUnload(win);
    chatWindow()?.close();
    for (const s of new Set([...slots.values()].map((x) => x.session).filter(Boolean))) s.stop();
    for (const p of proposals.values()) if (p.status === "pending") p._resolve?.("cancelled");
  }

  function terminalSetup() {
    return `claude mcp add --transport http --scope user zotero ${mcpURL()} --header "Authorization: Bearer ${token()}"`;
  }

  async function openZoteroURI(uri) {
    const m = uri.match(/^zotero:\/\/(select|open-pdf)\/library\/items\/([A-Z0-9]{8})(?:\?page=(\d+))?/i);
    if (!m) return Zotero.launchURL(uri);
    const win = Zotero.getMainWindow();
    win?.focus();
    return toolOpen({ key: m[2], page: m[1] === "open-pdf" && m[3] ? parseInt(m[3]) : undefined }).catch((e) => Zotero.logError(e));
  }

  function shortLabel(it) {
    if (!it.isRegularItem()) return Zotero.Utilities.ellipsize(it.getDisplayTitle(), 30);
    const c = it.getCreators()[0];
    const who = c ? (c.lastName || c.name) + (it.numCreators() > 1 ? " et al." : "") : Zotero.Utilities.ellipsize(it.getDisplayTitle(), 24);
    return [who, year(it)].filter(Boolean).join(" ");
  }
  function mentionOption(i, why) {
    return { kind: "item", key: i.key, label: i.getDisplayTitle(), short: shortLabel(i), sub: [why, brief(i).creators, year(i)].filter(Boolean).join(" · ") };
  }
  function collectionOption(c) { return { kind: "collection", key: c.key, label: c.name, short: c.name, sub: collPath(c) }; }

  // q < 2 chars: suggestions (open PDF, selected items, recently added); otherwise title/creator/year search + collections.
  async function mentionSearch(q) {
    q = (q || "").trim();
    if (q.length < 2) {
      const out = [], seen = new Set();
      const push = (i, why) => { if (i && !seen.has(i.key) && i.isRegularItem() && !i.deleted) { seen.add(i.key); out.push(mentionOption(i, why)); } };
      const ctx = getContext();
      if (ctx.openPDF?.parentKey) push(Zotero.Items.getByLibraryAndKey(LIB(), ctx.openPDF.parentKey), "open");
      for (const b of ctx.selectedItems || []) push(Zotero.Items.getByLibraryAndKey(LIB(), b.key), "selected");
      const s = new Zotero.Search();
      s.libraryID = LIB();
      s.addCondition("dateAdded", "isInTheLast", "60 days");
      const recent = Zotero.Items.get(await s.search()).filter((i) => i.isRegularItem() && !i.deleted)
        .sort((a, b) => (b.dateAdded > a.dateAdded ? 1 : -1)).slice(0, 6);
      recent.forEach((i) => push(i, "recent"));
      return out.slice(0, 10);
    }
    const s = new Zotero.Search();
    s.libraryID = LIB();
    s.addCondition("quicksearch-titleCreatorYear", "contains", q);
    const items = Zotero.Items.get(await s.search()).filter((i) => i.isRegularItem() && !i.deleted).slice(0, 8);
    const colls = allCollections().filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 4);
    return [...items.map((i) => mentionOption(i)), ...colls.map(collectionOption)];
  }

  function attachable(keyOrID) {
    const it = typeof keyOrID === "number" ? Zotero.Items.get(keyOrID) : Zotero.Items.getByLibraryAndKey(LIB(), keyOrID);
    if (it && it.libraryID === LIB()) {
      const top = it.isRegularItem() ? it : (it.parentItem?.isRegularItem() ? it.parentItem : null);
      if (top) return mentionOption(top);
    }
    const c = typeof keyOrID === "string" && Zotero.Collections.getByLibraryAndKey(LIB(), keyOrID);
    return c ? collectionOption(c) : null;
  }

  function resolveKeys(keys) {
    const out = [];
    for (const k of keys) {
      const it = Zotero.Items.getByLibraryAndKey(LIB(), k);
      if (it) { out.push(brief(it)); continue; }
      const c = Zotero.Collections.getByLibraryAndKey(LIB(), k);
      if (c) out.push({ key: c.key, kind: "collection", path: collPath(c) });
    }
    return out;
  }

  return {
    startup, shutdown, onMainWindowLoad, onMainWindowUnload,
    // UI API
    on: (fn) => listeners.add(fn), off: (fn) => listeners.delete(fn),
    getContext, getSession, newSession, forkChat, currentSlot, slotSession, slotWorkspace, attention,
    setSlotPage: (slot, page) => { slot.page = page || null; saveUiState(); },
    isChatOpen: (sessionId) => !!findOpenChat(sessionId), selectTab: (tabID) => mainTabs()?.select(tabID),
    listWorkspaces, currentWorkspace, createWorkspace, renameWorkspace, archiveWorkspace, switchWorkspace, listChats, resumeChat, deleteChat,
    proposals, decide, undoChange, changeLog, paperExplanations, explainCurrentSelection, showAnnotation, undoExplanation, terminalSetup, openZoteroURI, mentionSearch, resolveKeys, attachable, markdown: FinchMarkdown,
    librarySelection: () => { try { return Zotero.getMainWindow().ZoteroPane.getSelectedItems().filter((i) => i.libraryID === LIB() && i.isRegularItem()).slice(0, 20).map(brief); } catch (e) { return []; } },
    changesFile, clearSelection: () => { ctxState.selection = null; emit({ type: "context" }); },
    takePrefill: (host) => { const p = pendingPrefill; if (p && p.host === host) { pendingPrefill = null; return p.text; } return null; },
    popOut, toggleChat, setSidebar, matchesShortcut, shortcutLabel,
    autoEnabled: () => !!getPref("autoProcess"), setAuto: (v) => setPref("autoProcess", !!v),
    _test: { propose, locate, pdfFor, pageText, rpc, handleMcp, chatTab },
  };
})();
