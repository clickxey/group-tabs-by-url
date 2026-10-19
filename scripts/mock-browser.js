/*
 * A stand-in `browser` object so the popup and options pages can be opened
 * in an ordinary browser tab for design work and store screenshots
 * (see scripts/screenshots.mjs). It is NOT part of the add-on package.
 *
 * Expects window.__MOCK__ = { messages, tabs, settings?, undo?, dark? }.
 */
(function () {
  "use strict";
  const cfg = window.__MOCK__ || {};
  const listeners = [];
  const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });

  function area(initial) {
    let data = { ...initial };
    return {
      async get(key) {
        if (key == null) return JSON.parse(JSON.stringify(data));
        const out = {};
        for (const k of [].concat(key)) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) changes[k] = { oldValue: data[k], newValue: JSON.parse(JSON.stringify(v)) };
        data = { ...data, ...JSON.parse(JSON.stringify(obj)) };
        setTimeout(() => listeners.forEach((l) => l(changes, "local")), 0);
      },
      async remove(key) {
        for (const k of [].concat(key)) delete data[k];
      },
    };
  }

  const tabs = (cfg.tabs || []).map((url, i) => ({ id: i + 1, windowId: i % 3 === 2 ? 2 : 1, index: i, url, pinned: false, groupId: -1, incognito: false, active: i === 0 }));

  function getMessage(key, subs) {
    const entry = cfg.messages[key];
    if (!entry) return "";
    let msg = entry.message;
    const values = [].concat(subs == null ? [] : subs);
    if (entry.placeholders) {
      for (const [name, ph] of Object.entries(entry.placeholders)) {
        const idx = Number(ph.content.replace("$", "")) - 1;
        msg = msg.split("$" + name.toUpperCase() + "$").join(values[idx] ?? "");
      }
    }
    return msg;
  }

  window.browser = {
    i18n: { getMessage, getUILanguage: () => "en" },
    runtime: {
      id: "mock",
      getManifest: () => ({ version: "1.0.0" }),
      getURL: (p) => p,
      openOptionsPage() {},
      async sendMessage(msg) {
        if (msg.type === "getUndoInfo") return cfg.undo ? { createdAt: Date.now(), tabs: 12 } : null;
        if (msg.type === "groupNow") return { tabs: 17, groups: 4, results: [] };
        if (msg.type === "undo") return { restored: 17 };
        return null;
      },
      onMessage: event(),
    },
    storage: {
      local: area(cfg.settings ? { settings: cfg.settings } : {}),
      session: area({}),
      onChanged: { addListener: (l) => listeners.push(l), removeListener() {} },
    },
    tabs: {
      async query(q = {}) {
        if (q.active) return tabs.filter((t) => t.active);
        return tabs;
      },
      onCreated: event(),
      onRemoved: event(),
      onAttached: event(),
      onUpdated: event(),
    },
    tabGroups: { async query() { return []; } },
    windows: { async getCurrent() { return { id: 1 }; } },
    commands: {
      async getAll() {
        return [
          { name: "group-now", shortcut: "Alt+Shift+G" },
          { name: "undo-grouping", shortcut: "" },
        ];
      },
      async openShortcutSettings() {},
    },
  };
})();
