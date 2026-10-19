/*
 * Group Tabs by URL — settings storage.
 *
 * Settings live in browser.storage.local under the single key "settings".
 * Nothing is synced or sent anywhere. Every read is normalised, so older or
 * hand-edited data can never break the add-on.
 */
(function (root) {
  "use strict";

  const Rules = root.GTURules || (typeof require === "function" ? require("./rules.js") : null);
  const KEY = "settings";

  function createSettingsStore(storageArea) {
    async function load() {
      const stored = await storageArea.get(KEY);
      return Rules.normalizeSettings(stored[KEY]);
    }

    async function save(settings) {
      const clean = Rules.normalizeSettings(settings);
      await storageArea.set({ [KEY]: clean });
      return clean;
    }

    /** Load, let `mutate` change the object (or return a new one), save. */
    async function update(mutate) {
      const current = await load();
      const next = (await mutate(current)) || current;
      return save(next);
    }

    /**
     * Add a "site" rule for `site` unless one already covers it.
     * Resolves to { rule, created }.
     */
    async function addSiteRule(site) {
      let result = null;
      await update((s) => {
        const existing = Rules.findSiteRule(s.rules, site);
        if (existing) {
          result = { rule: existing, created: false };
          return s;
        }
        const rule = Rules.makeRule({ name: site, type: "site", patterns: [site] }, s.rules);
        s.rules.push(rule);
        result = { rule, created: true };
        return s;
      });
      return result;
    }

    return { KEY, load, save, update, addSiteRule };
  }

  const api = { createSettingsStore };
  root.GTUSettings = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
