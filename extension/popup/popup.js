/*
 * Group Tabs by URL — toolbar popup.
 *
 * Shows each rule with how many open tabs it would collect, lets the user
 * switch rules on/off, pick where groups go, and run or undo the grouping.
 *
 * The box at the top is a "quick group": a one-time rule that is never
 * saved. While it has text, the popup previews the tabs it matches and the
 * main button groups only those tabs, ignoring the saved rules.
 *
 * The grouping itself runs in the background script so it finishes even if
 * the popup closes.
 */
"use strict";

const { t, tn } = GTUi18n;
const R = GTURules;
const store = GTUSettings.createSettingsStore(browser.storage.local);
const engine = GTUGrouping.createEngine(browser); // read-only use here: counting

const $ = (id) => document.getElementById(id);

const PREVIEW_LIMIT = 8;
const DRAFT_KEY = "quickDraft";
const COLOR_NAME = {
  blue: "colorBlue",
  red: "colorRed",
  yellow: "colorYellow",
  green: "colorGreen",
  purple: "colorPurple",
  cyan: "colorCyan",
  orange: "colorOrange",
  pink: "colorPink",
  grey: "colorGrey",
};

const state = {
  settings: null,
  counts: {},
  windowId: null,
  activeTab: null,
  busy: false,
};

/** The one-time rule being typed in the quick-group box. */
const quick = {
  text: "",
  type: "contains",
  name: "",
  color: null, // null = derived from the text until the user picks one
  matches: [],
  error: null,
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
      const title = R.ruleTitle(rule);
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
  const site = state.activeTab && R.siteFromUrl(state.activeTab.url || "");
  const covered = site && R.findSiteRule(state.settings.rules, site);
  $("add-site").hidden = !site || !!covered;
  if (site) $("add-site-label").textContent = t("popupAddSite", [site]);
}

function renderMode() {
  const mode = state.settings.mode;
  for (const radio of document.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === mode;
  $("mode-hint").textContent = t(mode === "collect" ? "modeCollectHint" : "modePerWindowHint");
}

function quickActive() {
  return quick.text.trim().length > 0;
}

function renderQuick() {
  const active = quickActive();
  $("quick-clear").hidden = !active;
  $("quick-panel").hidden = !active;
  $("rules-section").hidden = active;
  if (!active) return;

  const rule = quickRule();
  const dot = $("quick-dot");
  dot.dataset.color = rule.color;
  const colorLabel = t("quickColor", [t(COLOR_NAME[rule.color])]);
  $("quick-color").title = colorLabel;
  $("quick-color").setAttribute("aria-label", colorLabel);
  $("quick-name").placeholder = t("quickNamePlaceholder", [quick.text.trim()]);
  $("quick-type").value = quick.type;

  const error = $("quick-error");
  error.hidden = !quick.error;
  error.textContent = quick.error ? t(quick.error === "errorInvalidRegex" ? "quickInvalidRegex" : "quickInvalidSite") : "";
  $("quick-save").disabled = !!quick.error;

  const n = quick.matches.length;
  $("quick-count").textContent = quick.error ? "" : tn("quickMatches", n);

  const items = quick.matches.slice(0, PREVIEW_LIMIT).map((tab) =>
    el("li", { title: tab.url || "" }, [
      el("span", { class: "tab-title", textContent: tab.title || tab.url || "" }),
      el("span", { class: "tab-url", textContent: tab.url || "" }),
    ])
  );
  if (n > PREVIEW_LIMIT) items.push(el("li", { class: "more", textContent: t("quickMore", [String(n - PREVIEW_LIMIT)]) }));
  $("quick-preview").replaceChildren(...items);
}

function totalMatches() {
  if (quickActive()) return quick.matches.length;
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
  renderQuick();
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
  await recountQuick();
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
/* Quick group                                                         */
/* ------------------------------------------------------------------ */

function quickRule() {
  const text = quick.text.trim();
  return R.normalizeRule({
    id: "quick",
    name: quick.name.trim(),
    type: quick.type,
    patterns: [text],
    color: quick.color || R.colorForText(text),
    enabled: true,
  });
}

async function recountQuick() {
  if (!quickActive()) {
    quick.matches = [];
    quick.error = null;
    return;
  }
  const rule = quickRule();
  const { errors } = R.compileRule(rule);
  quick.error = errors.length ? errors[0].error : null;
  if (quick.error) {
    quick.matches = [];
    return;
  }
  const { buckets } = await engine.plan(state.settings, { rules: [rule] });
  quick.matches = buckets[0] ? buckets[0].tabs : [];
}

let quickTimer = null;
function quickChanged() {
  renderQuick(); // show/hide the panel immediately
  renderButton();
  clearTimeout(quickTimer);
  quickTimer = setTimeout(async () => {
    await recountQuick();
    renderQuick();
    renderButton();
    saveDraft();
  }, 120);
}

function clearQuick() {
  Object.assign(quick, { text: "", type: "contains", name: "", color: null, matches: [], error: null });
  $("quick-text").value = "";
  $("quick-name").value = "";
  saveDraft();
  render();
}

function cycleQuickColor() {
  const current = quickRule().color;
  quick.color = R.COLORS[(R.COLORS.indexOf(current) + 1) % R.COLORS.length];
  renderQuick();
  saveDraft();
}

async function saveQuickAsRule() {
  if (!quickActive() || quick.error) return;
  const rule = quickRule();
  await saveSettings((s) => {
    s.rules.push(R.makeRule({ name: rule.name, color: rule.color, type: rule.type, patterns: rule.patterns }, s.rules));
  });
  const title = R.ruleTitle(rule);
  clearQuick();
  showStatus(t("quickSaved", [title]));
}

// The popup closes whenever you click outside it, so keep what was typed
// for the rest of the browser session. Session storage is cleared when
// Firefox closes.
async function saveDraft() {
  try {
    if (quickActive()) {
      const { text, type, name, color } = quick;
      await browser.storage.session.set({ [DRAFT_KEY]: { text, type, name, color } });
    } else {
      await browser.storage.session.remove(DRAFT_KEY);
    }
  } catch (_) {
    /* drafts are a convenience */
  }
}

async function loadDraft() {
  try {
    const { [DRAFT_KEY]: draft } = await browser.storage.session.get(DRAFT_KEY);
    if (!draft || typeof draft.text !== "string") return;
    quick.text = draft.text;
    quick.type = R.MATCH_TYPES.includes(draft.type) ? draft.type : "contains";
    quick.name = typeof draft.name === "string" ? draft.name : "";
    quick.color = R.COLORS.includes(draft.color) ? draft.color : null;
    $("quick-text").value = quick.text;
    $("quick-name").value = quick.name;
  } catch (_) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function groupNow() {
  if (state.busy || totalMatches() === 0) return;
  const usingQuick = quickActive() && !quick.error;
  const message = { type: "groupNow", windowId: state.windowId };
  if (usingQuick) message.rules = [quickRule()];

  state.busy = true;
  renderButton();
  try {
    const result = await browser.runtime.sendMessage(message);
    const failed = result.results.find((r) => r.error);
    if (failed) {
      showStatus(t("popupError", [failed.error]), { error: true });
    } else {
      showStatus(tn("popupDone", result.tabs), { undo: result.tabs > 0 });
      if (usingQuick) clearQuick(); // one-time: nothing is kept
    }
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
  const site = R.siteFromUrl(state.activeTab.url || "");
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

function wireQuick() {
  const text = $("quick-text");
  text.addEventListener("input", () => {
    quick.text = text.value;
    quickChanged();
  });
  $("quick-name").addEventListener("input", (e) => {
    quick.name = e.target.value;
    quickChanged();
  });
  $("quick-type").addEventListener("change", (e) => {
    quick.type = e.target.value;
    quickChanged();
  });
  for (const input of [text, $("quick-name")]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        groupNow();
      }
    });
  }
  $("quick-color").addEventListener("click", cycleQuickColor);
  $("quick-save").addEventListener("click", saveQuickAsRule);
  $("quick-clear").addEventListener("click", () => {
    clearQuick();
    text.focus();
  });
}

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
  await loadDraft();

  $("settings").addEventListener("click", openSettings);
  $("empty-add").addEventListener("click", openSettings);
  $("add-site").addEventListener("click", addSiteRule);
  $("go").addEventListener("click", groupNow);
  $("status-undo").addEventListener("click", undo);
  $("undo").addEventListener("click", undo);
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener("change", () => saveSettings((s) => void (s.mode = radio.value)));
  }
  wireQuick();

  render();
  await Promise.all([recount(), refreshUndoLink(), refreshShortcut()]);
  // Ready to type straight away. Firefox needs the popup to finish opening first.
  setTimeout(() => $("quick-text").focus(), 50);
}

init().catch((e) => showStatus(t("popupError", [String(e && e.message ? e.message : e)]), { error: true }));
