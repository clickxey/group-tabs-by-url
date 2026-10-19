/*
 * Group Tabs by URL — toolbar popup.
 *
 * Shows each rule with how many open tabs it would collect, lets the user
 * switch rules on/off, pick where groups go, and run or undo the grouping.
 * The grouping itself runs in the background script so it finishes even if
 * the popup closes.
 */
"use strict";

const { t, tn } = GTUi18n;
const store = GTUSettings.createSettingsStore(browser.storage.local);
const engine = GTUGrouping.createEngine(browser); // read-only use here: counting

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  counts: {},
  windowId: null,
  activeTab: null,
  busy: false,
};

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) node.append(c);
  return node;
}

function renderRules() {
  const { rules } = state.settings;
  const list = $("rules");
  list.replaceChildren(
    ...rules.map((rule) => {
      const count = state.counts[rule.id] || 0;
      const title = GTURules.ruleTitle(rule);
      const toggle = el("input", { type: "checkbox", checked: rule.enabled, role: "switch", "aria-label": t("popupToggleRule", [title]) });
      toggle.addEventListener("change", () => setRuleEnabled(rule.id, toggle.checked));
      return el(
        "li",
        { class: "rule-row" + (rule.enabled ? (count ? " has-matches" : " zero") : " off") },
        [
          el("span", { class: "dot", dataset: { color: rule.color } }),
          el("div", { class: "rule-text" }, [
            el("span", { class: "rule-name", textContent: title }),
            el("span", { class: "rule-pats", textContent: rule.patterns.join(", ") }),
          ]),
          el("span", { class: "count", textContent: rule.enabled ? String(count) : t("popupRuleOff"), title: rule.enabled ? tn("tabCount", count) : "" }),
          el("label", { class: "switch" }, [toggle, el("span", { class: "track" })]),
        ]
      );
    })
  );
  $("empty").hidden = rules.length > 0;
}

function renderAddSite() {
  const site = state.activeTab && GTURules.siteFromUrl(state.activeTab.url || "");
  const covered = site && GTURules.findSiteRule(state.settings.rules, site);
  $("add-site").hidden = !site || !!covered;
  if (site) $("add-site-label").textContent = t("popupAddSite", [site]);
}

function renderMode() {
  const mode = state.settings.mode;
  for (const radio of document.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === mode;
  $("mode-hint").textContent = t(mode === "collect" ? "modeCollectHint" : "modePerWindowHint");
}

function totalMatches() {
  return state.settings.rules.filter((r) => r.enabled).reduce((sum, r) => sum + (state.counts[r.id] || 0), 0);
}

function renderButton() {
  const go = $("go");
  if (state.busy) {
    go.textContent = t("popupWorking");
    go.disabled = true;
    return;
  }
  const total = totalMatches();
  go.textContent = total ? tn("popupGroupButton", total) : t("popupNothingToGroup");
  go.disabled = total === 0;
}

function render() {
  renderRules();
  renderAddSite();
  renderMode();
  renderButton();
}

function showStatus(text, { undo = false, error = false } = {}) {
  $("status").hidden = false;
  $("status").classList.toggle("error", error);
  $("status-text").textContent = text;
  $("status-undo").hidden = !undo;
}

async function refreshUndoLink() {
  const info = await browser.runtime.sendMessage({ type: "getUndoInfo" });
  // The inline "Undo" in the status line takes over right after a run.
  $("undo").hidden = !info || !$("status-undo").hidden;
}

async function refreshShortcut() {
  try {
    const commands = await browser.commands.getAll();
    const cmd = commands.find((c) => c.name === "group-now");
    $("shortcut").textContent = cmd && cmd.shortcut ? t("popupShortcut", [cmd.shortcut]) : "";
  } catch (_) {
    $("shortcut").textContent = "";
  }
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

async function recount() {
  state.counts = await engine.countMatches(state.settings);
  render();
}

async function saveSettings(mutate) {
  state.settings = await store.update(mutate);
  await recount();
}

function setRuleEnabled(id, enabled) {
  return saveSettings((s) => {
    const rule = s.rules.find((r) => r.id === id);
    if (rule) rule.enabled = enabled;
  });
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function groupNow() {
  state.busy = true;
  renderButton();
  try {
    const result = await browser.runtime.sendMessage({ type: "groupNow", windowId: state.windowId });
    const failed = result.results.find((r) => r.error);
    if (failed) showStatus(t("popupError", [failed.error]), { error: true });
    else showStatus(tn("popupDone", result.tabs), { undo: result.tabs > 0 });
  } catch (e) {
    showStatus(t("popupError", [String(e && e.message ? e.message : e)]), { error: true });
  } finally {
    state.busy = false;
    await recount();
    await refreshUndoLink();
  }
}

async function undo() {
  try {
    const { restored } = await browser.runtime.sendMessage({ type: "undo" });
    showStatus(restored ? tn("popupUndone", restored) : t("popupNothingToUndo"));
  } catch (e) {
    showStatus(t("popupError", [String(e && e.message ? e.message : e)]), { error: true });
  }
  await recount();
  await refreshUndoLink();
}

async function addSiteRule() {
  const site = GTURules.siteFromUrl(state.activeTab.url || "");
  if (!site) return;
  await store.addSiteRule(site);
  state.settings = await store.load();
  await recount();
}

function openSettings() {
  browser.runtime.openOptionsPage();
  window.close();
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

async function init() {
  GTUi18n.apply();

  const [settings, win, tabs] = await Promise.all([
    store.load(),
    browser.windows.getCurrent(),
    browser.tabs.query({ active: true, currentWindow: true }),
  ]);
  state.settings = settings;
  state.windowId = win.id;
  state.activeTab = tabs[0] || null;

  $("settings").addEventListener("click", openSettings);
  $("empty-add").addEventListener("click", openSettings);
  $("add-site").addEventListener("click", addSiteRule);
  $("go").addEventListener("click", groupNow);
  $("status-undo").addEventListener("click", undo);
  $("undo").addEventListener("click", undo);
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener("change", () => saveSettings((s) => void (s.mode = radio.value)));
  }

  render();
  await Promise.all([recount(), refreshUndoLink(), refreshShortcut()]);
}

init().catch((e) => showStatus(t("popupError", [String(e && e.message ? e.message : e)]), { error: true }));
