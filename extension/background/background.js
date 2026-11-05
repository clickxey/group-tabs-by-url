/*
 * Group Tabs by URL — background script (non-persistent event page).
 *
 * Wires the engine to: popup messages, keyboard shortcuts, the tab and
 * toolbar-button context menus, and the optional automatic grouping.
 * Loaded after shared/rules.js, shared/settings.js and shared/grouping.js.
 */
"use strict";

const store = GTUSettings.createSettingsStore(browser.storage.local);
const engine = GTUGrouping.createEngine(browser);
const t = (key, subs) => browser.i18n.getMessage(key, subs) || key;

/* ------------------------------------------------------------------ */
/* Settings cache                                                      */
/* ------------------------------------------------------------------ */

let settingsPromise = null;
function getSettings() {
  if (!settingsPromise) settingsPromise = store.load();
  return settingsPromise;
}
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[store.KEY]) settingsPromise = null;
});

/* ------------------------------------------------------------------ */
/* Messages from the popup and options page                            */
/* ------------------------------------------------------------------ */

/** Engine options for a one-time grouping, or {} to use the saved rules. */
function oneTimeRules(rules) {
  if (!Array.isArray(rules) || !rules.length) return {};
  return { rules: GTURules.normalizeRules(rules).map((r) => ({ ...r, enabled: true })) };
}

browser.runtime.onMessage.addListener((message, sender) => {
  // Only our own pages can reach this listener (no externally_connectable),
  // but check anyway that the message comes from this extension.
  if (!message || sender.id !== browser.runtime.id) return undefined;
  switch (message.type) {
    case "groupNow":
      // `rules` is set for a one-time "quick group" from the popup: those
      // rules are used instead of the saved ones and are never stored.
      return getSettings().then((s) => engine.groupNow(s, message.windowId, oneTimeRules(message.rules)));
    case "undo":
      return engine.undo();
    case "getUndoInfo":
      return engine.getUndoInfo();
    default:
      return undefined;
  }
});

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts                                                  */
/* ------------------------------------------------------------------ */

browser.commands.onCommand.addListener(async (command) => {
  if (command === "group-now") {
    const win = await browser.windows.getLastFocused();
    await engine.groupNow(await getSettings(), win.id);
  } else if (command === "undo-grouping") {
    await engine.undo();
  }
});

/* ------------------------------------------------------------------ */
/* Context menus                                                       */
/* ------------------------------------------------------------------ */

const MENU = {
  groupSite: "group-site",
  groupBase: "group-base-domain",
  separator: "tab-separator",
  addRule: "add-site-rule",
  addBaseRule: "add-base-domain-rule",
  undo: "undo",
  editRules: "edit-rules",
};

async function createMenus() {
  await browser.menus.removeAll();
  browser.menus.create({ id: MENU.groupSite, title: t("menuGroupSiteGeneric"), contexts: ["tab"] });
  browser.menus.create({ id: MENU.groupBase, title: t("menuGroupSiteGeneric"), contexts: ["tab"], visible: false });
  browser.menus.create({ id: MENU.separator, type: "separator", contexts: ["tab"] });
  browser.menus.create({ id: MENU.addRule, title: t("menuAddRuleGeneric"), contexts: ["tab"] });
  browser.menus.create({ id: MENU.addBaseRule, title: t("menuAddRuleGeneric"), contexts: ["tab"], visible: false });
  browser.menus.create({ id: MENU.undo, title: t("menuUndo"), contexts: ["action"] });
  browser.menus.create({ id: MENU.editRules, title: t("menuEditRules"), contexts: ["action"] });
}

browser.runtime.onInstalled.addListener(async (details) => {
  await createMenus();
  if (details.reason === "install") {
    await browser.tabs.create({ url: browser.runtime.getURL("options/options.html?welcome=1") });
  }
});
browser.runtime.onStartup.addListener(createMenus);

/**
 * The sites a tab's menu offers: the tab's own site ("en.wikipedia.org")
 * and, when that is a subdomain, its main domain ("wikipedia.org").
 */
function sitesOf(tab) {
  const site = tab ? GTURules.siteFromUrl(tab.url || "") : null;
  return { site, base: site ? GTURules.baseDomain(site) : null };
}

// Show the site names in the tab menu, e.g. "Group all tabs from en.wikipedia.org"
// and "Group all tabs from wikipedia.org and its subdomains".
browser.menus.onShown.addListener(async (info, tab) => {
  if (info.contexts.includes("tab")) {
    const { site, base } = sitesOf(tab);
    await browser.menus.update(MENU.groupSite, {
      title: site ? t("menuGroupSite", [site]) : t("menuGroupSiteGeneric"),
      enabled: !!site,
    });
    await browser.menus.update(MENU.addRule, {
      title: site ? t("menuAddRule", [site]) : t("menuAddRuleGeneric"),
      enabled: !!site,
    });
    await browser.menus.update(MENU.groupBase, {
      title: base ? t("menuGroupBase", [base]) : t("menuGroupSiteGeneric"),
      visible: !!base,
    });
    await browser.menus.update(MENU.addBaseRule, {
      title: base ? t("menuAddBaseRule", [base]) : t("menuAddRuleGeneric"),
      visible: !!base,
    });
  }
  if (info.contexts.includes("action")) {
    await browser.menus.update(MENU.undo, { enabled: !!(await engine.getUndoInfo()) });
  }
  browser.menus.refresh();
});

async function addRuleAndShow(site) {
  if (!site) return;
  const { rule } = await store.addSiteRule(site);
  await browser.tabs.create({ url: browser.runtime.getURL("options/options.html#rule=" + encodeURIComponent(rule.id)) });
}

browser.menus.onClicked.addListener(async (info, tab) => {
  switch (info.menuItemId) {
    case MENU.groupSite:
      if (tab) await engine.groupSite(sitesOf(tab).site, await getSettings(), tab.windowId);
      break;
    case MENU.groupBase:
      if (tab) await engine.groupSite(sitesOf(tab).base, await getSettings(), tab.windowId);
      break;
    case MENU.addRule:
      await addRuleAndShow(sitesOf(tab).site);
      break;
    case MENU.addBaseRule:
      await addRuleAndShow(sitesOf(tab).base);
      break;
    case MENU.undo:
      await engine.undo();
      break;
    case MENU.editRules:
      await browser.runtime.openOptionsPage();
      break;
  }
});

/* ------------------------------------------------------------------ */
/* Automatic grouping (off unless enabled in the options)              */
/* ------------------------------------------------------------------ */

const pending = new Map();
const AUTO_DELAY_MS = 600;

browser.tabs.onUpdated.addListener(
  (tabId, changeInfo) => {
    if (changeInfo.url === undefined && changeInfo.status !== "complete") return;
    clearTimeout(pending.get(tabId));
    pending.set(
      tabId,
      setTimeout(async () => {
        pending.delete(tabId);
        const settings = await getSettings();
        if (!settings.autoGroup) return;
        try {
          await engine.autoGroupTab(tabId, settings);
        } catch (e) {
          console.warn("Group Tabs by URL: auto-group failed", e);
        }
      }, AUTO_DELAY_MS)
    );
  },
  { properties: ["url", "status"] }
);

browser.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(pending.get(tabId));
  pending.delete(tabId);
});
