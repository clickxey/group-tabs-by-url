/*
 * Group Tabs by URL — settings page.
 *
 * A visual editor for the rules plus the behaviour switches. Every change is
 * saved automatically to browser.storage.local; the popup and the background
 * script pick it up from there.
 */
"use strict";

const { t, tn } = GTUi18n;
const R = GTURules;
const engine = GTUGrouping.createEngine(browser); // read-only use here: counting
const SETTINGS_KEY = "settings";

const $ = (id) => document.getElementById(id);

const HELP = { site: "typeSiteHelp", contains: "typeContainsHelp", prefix: "typePrefixHelp", regex: "typeRegexHelp" };
const PLACEHOLDER = { site: "placeholderSite", contains: "placeholderContains", prefix: "placeholderPrefix", regex: "placeholderRegex" };
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

let settings = null;
let counts = {};
let lastSavedJson = "";

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

let saveTimer = null;
let savedTimer = null;

function scheduleSave(delay = 350) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
  scheduleRecount();
}

async function saveNow() {
  clearTimeout(saveTimer);
  const clean = R.normalizeSettings(settings);
  lastSavedJson = JSON.stringify(clean);
  await browser.storage.local.set({ [SETTINGS_KEY]: clean });
  const badge = $("saved");
  badge.textContent = t("savedStatus");
  badge.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => badge.classList.remove("show"), 1400);
}

/* ------------------------------------------------------------------ */
/* Match counts                                                        */
/* ------------------------------------------------------------------ */

let recountTimer = null;
function scheduleRecount() {
  clearTimeout(recountTimer);
  recountTimer = setTimeout(recount, 250);
}

async function recount() {
  counts = await engine.countMatches(settings);
  for (const card of document.querySelectorAll(".rule-card")) {
    const rule = findRule(card.dataset.id);
    if (rule) updateCount(card, rule);
  }
}

function updateCount(card, rule) {
  const chip = card.querySelector(".r-count");
  const n = counts[rule.id] || 0;
  chip.className = "chip r-count " + (rule.enabled ? (n ? "has-matches" : "zero") : "off");
  chip.textContent = rule.enabled ? tn("ruleMatches", n) : t("ruleMatchesOff");
}

/* ------------------------------------------------------------------ */
/* Rule cards                                                          */
/* ------------------------------------------------------------------ */

const findRule = (id) => settings.rules.find((r) => r.id === id);
const ruleIndex = (id) => settings.rules.findIndex((r) => r.id === id);

function renderRules(focus) {
  const list = $("rule-list");
  list.replaceChildren(...settings.rules.map((rule, i) => buildCard(rule, i)));
  if (focus) {
    const card = list.querySelector(`[data-id="${CSS.escape(focus.id)}"]`);
    const target = card && card.querySelector(focus.selector);
    if (target) target.focus();
  }
  scheduleRecount();
}

function buildCard(rule, index) {
  const card = $("rule-template").content.firstElementChild.cloneNode(true);
  GTUi18n.apply(card);
  card.dataset.id = rule.id;

  const enabled = card.querySelector(".r-enabled");
  const name = card.querySelector(".r-name");
  const type = card.querySelector(".r-type");
  const patterns = card.querySelector(".r-patterns");
  const swatches = card.querySelector(".r-swatches");

  enabled.checked = rule.enabled;
  name.value = rule.name;
  type.value = rule.type;
  patterns.value = rule.patterns.join("\n");
  swatches.setAttribute("aria-label", t("ruleColorLabel"));

  for (const color of R.COLORS) {
    const label = document.createElement("label");
    label.className = "swatch";
    label.dataset.color = color;
    label.title = t(COLOR_NAME[color]);
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "color-" + rule.id;
    input.value = color;
    input.checked = rule.color === color;
    input.setAttribute("aria-label", t(COLOR_NAME[color]));
    input.addEventListener("change", () => {
      findRule(rule.id).color = color;
      updateCardLook(card, findRule(rule.id));
      scheduleSave();
    });
    const dot = document.createElement("span");
    label.append(input, dot);
    swatches.append(label);
  }

  enabled.addEventListener("change", () => {
    const r = findRule(rule.id);
    r.enabled = enabled.checked;
    updateCardLook(card, r);
    updateCount(card, r);
    scheduleSave(0);
  });
  name.addEventListener("input", () => {
    findRule(rule.id).name = name.value;
    scheduleSave();
  });
  type.addEventListener("change", () => {
    const r = findRule(rule.id);
    r.type = type.value;
    updateCardLook(card, r);
    scheduleSave(0);
  });
  patterns.addEventListener("input", () => {
    const r = findRule(rule.id);
    r.patterns = patterns.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    updateCardLook(card, r);
    scheduleSave();
  });

  const up = card.querySelector(".r-up");
  const down = card.querySelector(".r-down");
  up.disabled = index === 0;
  down.disabled = index === settings.rules.length - 1;
  up.addEventListener("click", () => moveRule(rule.id, -1));
  down.addEventListener("click", () => moveRule(rule.id, +1));
  card.querySelector(".r-delete").addEventListener("click", () => deleteRule(rule.id));

  updateCardLook(card, rule);
  updateCount(card, rule);
  return card;
}

/** Everything about a card that depends on the rule but isn't an input value. */
function updateCardLook(card, rule) {
  card.dataset.color = rule.color;
  card.classList.toggle("off", !rule.enabled);
  card.querySelector(".r-dot").dataset.color = rule.color;
  card.querySelector(".r-help").textContent = t(HELP[rule.type]);

  const patterns = card.querySelector(".r-patterns");
  patterns.placeholder = t(PLACEHOLDER[rule.type]);
  patterns.rows = Math.min(12, Math.max(3, patterns.value.split("\n").length + 1));

  const { errors } = R.compileRule(rule);
  const list = card.querySelector(".r-errors");
  const items = errors.map((e) => {
    const li = document.createElement("li");
    li.textContent = t(e.error, [String(e.line), e.pattern]);
    return li;
  });
  if (!rule.patterns.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = t("ruleNoPatterns");
    items.push(li);
  }
  list.replaceChildren(...items);
  patterns.classList.toggle("invalid", errors.length > 0);
  patterns.setAttribute("aria-invalid", errors.length > 0 ? "true" : "false");
}

function moveRule(id, delta) {
  const from = ruleIndex(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= settings.rules.length) return;
  const [rule] = settings.rules.splice(from, 1);
  settings.rules.splice(to, 0, rule);
  const selector = delta < 0 ? ".r-up" : ".r-down";
  renderRules({ id, selector: to === 0 || to === settings.rules.length - 1 ? ".r-name" : selector });
  scheduleSave(0);
}

function deleteRule(id) {
  const index = ruleIndex(id);
  if (index < 0) return;
  const [removed] = settings.rules.splice(index, 1);
  renderRules();
  scheduleSave(0);
  toast(t("ruleDeleted", [R.ruleTitle(removed)]), t("undoDelete"), () => {
    settings.rules.splice(Math.min(index, settings.rules.length), 0, removed);
    renderRules({ id: removed.id, selector: ".r-name" });
    scheduleSave(0);
  });
}

function addRule() {
  const rule = R.makeRule({ name: "", type: "site", patterns: [] }, settings.rules);
  settings.rules.push(rule);
  renderRules({ id: rule.id, selector: ".r-name" });
  scheduleSave(0);
}

/* ------------------------------------------------------------------ */
/* Behaviour switches                                                  */
/* ------------------------------------------------------------------ */

const FLAGS = ["collapse", "includePinned", "skipGrouped", "autoGroup"];

function renderBehavior() {
  for (const radio of document.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === settings.mode;
  for (const flag of FLAGS) $(flag).checked = !!settings[flag];
}

function wireBehavior() {
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener("change", () => {
      settings.mode = radio.value;
      scheduleSave(0);
    });
  }
  for (const flag of FLAGS) {
    $(flag).addEventListener("change", () => {
      settings[flag] = $(flag).checked;
      scheduleSave(0);
    });
  }
}

/* ------------------------------------------------------------------ */
/* Shortcuts                                                           */
/* ------------------------------------------------------------------ */

async function renderShortcuts() {
  let commands = [];
  try {
    commands = await browser.commands.getAll();
  } catch (_) {
    /* ignore */
  }
  const show = (id, name) => {
    const cmd = commands.find((c) => c.name === name);
    const kbd = $(id);
    kbd.textContent = cmd && cmd.shortcut ? cmd.shortcut : t("shortcutNone");
    kbd.classList.toggle("none", !(cmd && cmd.shortcut));
  };
  show("key-group", "group-now");
  show("key-undo", "undo-grouping");

  const group = commands.find((c) => c.name === "group-now");
  $("welcome-step2").textContent = group && group.shortcut ? t("welcomeStep2", [group.shortcut]) : t("welcomeStep2NoKeys");

  const change = $("change-shortcuts");
  if (typeof browser.commands.openShortcutSettings === "function") {
    change.addEventListener("click", () => browser.commands.openShortcutSettings());
  } else {
    change.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* Backup                                                              */
/* ------------------------------------------------------------------ */

function exportRules() {
  const blob = new Blob([R.exportRules(R.normalizeSettings(settings))], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `group-tabs-by-url-rules-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function importRules(file) {
  try {
    const text = await file.text();
    const imported = R.parseImport(text);
    const ids = new Set(settings.rules.map((r) => r.id));
    for (const rule of imported) {
      while (ids.has(rule.id)) rule.id = R.newId();
      ids.add(rule.id);
      settings.rules.push(rule);
    }
    renderRules();
    await saveNow();
    toast(tn("importDone", imported.length));
  } catch (e) {
    toast(t(e && e.message && e.message.startsWith("error") ? e.message : "errorImportInvalid"));
  }
}

async function resetRules() {
  if (!window.confirm(t("resetConfirm"))) return;
  settings.rules = R.normalizeRules(R.DEFAULT_RULES);
  renderRules();
  await saveNow();
  toast(t("resetDone"));
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function toast(text, actionLabel, action) {
  const box = $("toast");
  const button = $("toast-action");
  $("toast-text").textContent = text;
  button.hidden = !action;
  button.textContent = actionLabel || "";
  button.onclick = action
    ? () => {
        box.hidden = true;
        action();
      }
    : null;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), action ? 8000 : 4000);
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

function handleLocation() {
  const params = new URLSearchParams(location.search);
  if (params.get("welcome") === "1") $("welcome").hidden = false;

  const match = /^#rule=(.+)$/.exec(location.hash);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const card = document.querySelector(`.rule-card[data-id="${CSS.escape(id)}"]`);
    if (card) {
      card.scrollIntoView({ block: "center" });
      card.classList.add("flash");
      card.querySelector(".r-name").focus({ preventScroll: true });
    }
  }
}

async function init() {
  GTUi18n.apply();
  document.title = t("optionsTitle");
  $("version").textContent = t("footerVersion", [browser.runtime.getManifest().version]);

  const stored = await browser.storage.local.get(SETTINGS_KEY);
  settings = R.normalizeSettings(stored[SETTINGS_KEY]);
  lastSavedJson = JSON.stringify(settings);

  renderBehavior();
  wireBehavior();
  renderRules();
  await recount();
  await renderShortcuts();

  $("add-rule").addEventListener("click", addRule);
  $("export").addEventListener("click", exportRules);
  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importRules(file);
    e.target.value = "";
  });
  $("reset").addEventListener("click", resetRules);
  $("welcome-dismiss").addEventListener("click", () => {
    $("welcome").hidden = true;
    history.replaceState(null, "", location.pathname);
  });

  // Changes made elsewhere (popup toggles, "Add a rule" from a tab menu).
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    const incoming = R.normalizeSettings(changes[SETTINGS_KEY].newValue);
    const json = JSON.stringify(incoming);
    if (json === lastSavedJson) return;
    lastSavedJson = json;
    settings = incoming;
    renderBehavior();
    renderRules();
  });

  // Keep the "N open tabs" chips current.
  for (const ev of [browser.tabs.onCreated, browser.tabs.onRemoved, browser.tabs.onAttached]) ev.addListener(scheduleRecount);
  try {
    browser.tabs.onUpdated.addListener(scheduleRecount, { properties: ["url", "pinned", "groupId"] });
  } catch (_) {
    browser.tabs.onUpdated.addListener(scheduleRecount, { properties: ["url", "pinned"] });
  }

  window.addEventListener("hashchange", handleLocation);
  handleLocation();
}

init();
