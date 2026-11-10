/* Finch: bootstrap. Loads content/core.js and wires window hooks. */
var Finch, chromeHandle;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
  chromeHandle = aomStartup.registerChrome(Services.io.newURI(rootURI + "manifest.json"),
    [["content", "finch", rootURI + "content/"]]);
  const ctx = { Zotero, Services, Cc, Ci, ChromeUtils, IOUtils, PathUtils, rootURI, pluginID: id, version };
  Services.scriptloader.loadSubScript(rootURI + "content/markdown.js", ctx);
  Services.scriptloader.loadSubScript(rootURI + "content/core.js", ctx);
  Finch = ctx.Finch;
  Zotero.Finch = Finch;
  await Finch.startup();
  for (const win of Zotero.getMainWindows()) Finch.onMainWindowLoad(win);
}

function onMainWindowLoad({ window }) { Finch?.onMainWindowLoad(window); }
function onMainWindowUnload({ window }) { Finch?.onMainWindowUnload(window); }

function shutdown() {
  try { Finch?.shutdown(); } catch (e) { Zotero.logError(e); }
  delete Zotero.Finch;
  Finch = null;
  chromeHandle?.destruct();
  chromeHandle = null;
  Services.obs.notifyObservers(null, "startupcache-invalidate");
}
