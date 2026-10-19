/*
 * Group Tabs by URL — the grouping engine.
 *
 * Only these browser calls change anything:
 *   tabs.group()        – put tabs into a (new or existing) group; moves them if needed
 *   tabs.ungroup()      – take a tab out of its group (auto-group and undo only)
 *   tabs.move()         – put a tab back where it was (undo only)
 *   tabGroups.update()  – set the title / colour / collapsed state of a group
 *
 * Tabs are never created, closed, reloaded or navigated, so their content,
 * back/forward history and unloaded ("discarded") state are left as they are.
 *
 * The engine receives the WebExtension API object (`browser`) as a parameter
 * so the tests can drive it with an in-memory fake.
 */
(function (root) {
  "use strict";

  const Rules = root.GTURules || (typeof require === "function" ? require("./rules.js") : null);

  const NO_GROUP = -1;
  const UNDO_KEY = "undoSnapshot";

  const inGroup = (tab) => tab.groupId != null && tab.groupId !== NO_GROUP;
  const errorText = (e) => String((e && e.message) || e);

  function createEngine(api) {
    /* -------------------------------------------------------------- */
    /* Helpers                                                         */
    /* -------------------------------------------------------------- */

    async function queryGroups(filter = {}) {
      try {
        return await api.tabGroups.query(filter);
      } catch (_) {
        return [];
      }
    }

    async function findGroupByTitle(windowId, title) {
      const groups = await queryGroups({ windowId });
      return groups.find((g) => g.title === title) || null;
    }

    /** Add tabs to the window's group called `title`, creating it if needed. */
    async function addToGroup(windowId, title, color, tabIds) {
      const existing = await findGroupByTitle(windowId, title);
      if (existing) return api.tabs.group({ groupId: existing.id, tabIds });
      const groupId = await api.tabs.group({ tabIds, createProperties: { windowId } });
      await api.tabGroups.update(groupId, { title, color });
      return groupId;
    }

    /* -------------------------------------------------------------- */
    /* Planning — which tab goes to which rule (read-only)             */
    /* -------------------------------------------------------------- */

    /**
     * Returns { buckets: [{ rule, title, tabs }], tabs, groups }.
     * `options.rules` overrides the saved rules (used for one-off grouping).
     */
    async function plan(settings, options = {}) {
      const compiled = Rules.compileEnabled(options.rules || settings.rules);
      const [tabs, groups] = await Promise.all([api.tabs.query({}), queryGroups()]);
      const groupTitle = new Map(groups.map((g) => [g.id, g.title]));
      const buckets = compiled.map((c) => ({ rule: c.rule, title: c.title, tabs: [] }));

      for (const tab of tabs) {
        if (tab.pinned && !settings.includePinned) continue;
        const index = compiled.findIndex((c) => c.test(tab.url || ""));
        if (index < 0) continue;
        const bucket = buckets[index];
        // "Leave grouped tabs alone": skip tabs in some other group, but keep
        // tabs already in this rule's own group so counts stay meaningful.
        if (settings.skipGrouped && inGroup(tab) && groupTitle.get(tab.groupId) !== bucket.title) continue;
        bucket.tabs.push(tab);
      }
      return { buckets, tabs, groups };
    }

    /** { ruleId: number of tabs it would collect } for enabled rules. */
    async function countMatches(settings) {
      const { buckets } = await plan(settings);
      const counts = {};
      for (const b of buckets) counts[b.rule.id] = b.tabs.length;
      return counts;
    }

    /* -------------------------------------------------------------- */
    /* Group now                                                       */
    /* -------------------------------------------------------------- */

    /**
     * Group every matching tab.
     * - mode "collect": tabs are brought into `targetWindowId`. Tabs that
     *   cannot move there (private ↔ normal window) are grouped in their own
     *   window instead.
     * - mode "perWindow": each window gets its own groups.
     *
     * Resolves to { tabs, groups, results: [{ ruleId, title, color, tabs, groups, error }] }.
     */
    async function groupNow(settings, targetWindowId, options = {}) {
      const { buckets, tabs, groups } = await plan(settings, options);
      let target = null;
      if (settings.mode === "collect" && targetWindowId != null) {
        try {
          target = await api.windows.get(targetWindowId);
        } catch (_) {
          target = null;
        }
      }

      const affected = new Set();
      for (const b of buckets) for (const t of b.tabs) affected.add(t.id);
      if (!affected.size) return { tabs: 0, groups: 0, results: buckets.map((b) => summary(b)) };

      await saveUndo(tabs.filter((t) => affected.has(t.id)), groups);

      const results = [];
      let groupCount = 0;
      for (const bucket of buckets) {
        const result = summary(bucket);
        results.push(result);
        if (!bucket.tabs.length) continue;

        const byWindow = new Map();
        for (const tab of bucket.tabs) {
          const windowId = target && tab.incognito === target.incognito ? target.id : tab.windowId;
          if (!byWindow.has(windowId)) byWindow.set(windowId, []);
          byWindow.get(windowId).push(tab.id);
        }

        for (const [windowId, tabIds] of byWindow) {
          try {
            const groupId = await addToGroup(windowId, bucket.title, bucket.rule.color, tabIds);
            result.groups++;
            groupCount++;
            if (settings.collapse) {
              try {
                await api.tabGroups.update(groupId, { collapsed: true });
              } catch (_) {
                /* Firefox may refuse to collapse the group holding the active tab. */
              }
            }
          } catch (e) {
            result.error = errorText(e);
          }
        }
      }
      return { tabs: affected.size, groups: groupCount, results };
    }

    function summary(bucket) {
      return { ruleId: bucket.rule.id, title: bucket.title, color: bucket.rule.color, tabs: bucket.tabs.length, groups: 0, error: null };
    }

    /** One-off: group every tab from the site of `tab`, without saving a rule. */
    async function groupSiteOf(tab, settings, targetWindowId) {
      const site = Rules.siteFromUrl(tab.url || "");
      if (!site) return { tabs: 0, groups: 0, results: [] };
      const existing = Rules.findSiteRule(settings.rules, site);
      const rule = Rules.normalizeRule({
        id: "adhoc",
        name: existing ? Rules.ruleTitle(existing) : site,
        color: existing ? existing.color : Rules.colorForText(site),
        type: "site",
        patterns: [site],
      });
      return groupNow(settings, targetWindowId, { rules: [rule] });
    }

    /* -------------------------------------------------------------- */
    /* Undo                                                            */
    /* -------------------------------------------------------------- */

    async function saveUndo(tabs, groups) {
      const snapshot = {
        createdAt: Date.now(),
        tabs: tabs.map((t) => ({ tabId: t.id, windowId: t.windowId, index: t.index, groupId: inGroup(t) ? t.groupId : NO_GROUP, pinned: !!t.pinned })),
        groups: groups.map((g) => ({ id: g.id, windowId: g.windowId, title: g.title, color: g.color, collapsed: !!g.collapsed })),
      };
      try {
        await api.storage.session.set({ [UNDO_KEY]: snapshot });
      } catch (_) {
        /* Undo is a convenience; never block grouping on it. */
      }
    }

    async function getUndoInfo() {
      try {
        const { [UNDO_KEY]: snap } = await api.storage.session.get(UNDO_KEY);
        return snap ? { createdAt: snap.createdAt, tabs: snap.tabs.length } : null;
      } catch (_) {
        return null;
      }
    }

    /**
     * Put the tabs from the last "group now" back where they were (window,
     * position, and original group — recreated if it has since disappeared).
     * Best effort: tabs closed in the meantime are skipped.
     */
    async function undo() {
      let snap;
      try {
        ({ [UNDO_KEY]: snap } = await api.storage.session.get(UNDO_KEY));
      } catch (_) {
        snap = null;
      }
      if (!snap) return { restored: 0 };

      const groupMeta = new Map(snap.groups.map((g) => [g.id, g]));
      const recreated = new Map();
      const ordered = [...snap.tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index);
      let restored = 0;

      for (const rec of ordered) {
        try {
          await api.tabs.get(rec.tabId);
        } catch (_) {
          continue; // closed since
        }
        try {
          try {
            await api.tabs.move(rec.tabId, { windowId: rec.windowId, index: rec.index });
          } catch (_) {
            await api.tabs.move(rec.tabId, { windowId: rec.windowId, index: -1 });
          }

          if (rec.groupId === NO_GROUP) {
            const now = await api.tabs.get(rec.tabId);
            if (inGroup(now)) await api.tabs.ungroup(rec.tabId);
            if (rec.pinned) await api.tabs.update(rec.tabId, { pinned: true });
          } else {
            let groupId = null;
            try {
              const g = await api.tabGroups.get(rec.groupId);
              if (g && g.windowId === rec.windowId) groupId = g.id;
            } catch (_) {
              /* group no longer exists */
            }
            if (groupId == null && recreated.has(rec.groupId)) groupId = recreated.get(rec.groupId);
            if (groupId != null) {
              await api.tabs.group({ groupId, tabIds: [rec.tabId] });
              // Joining a group appends at its end; nudge the tab back to its
              // old slot, and re-join if that move took it out of the group.
              try {
                await api.tabs.move(rec.tabId, { windowId: rec.windowId, index: rec.index });
                const now = await api.tabs.get(rec.tabId);
                if (now.groupId !== groupId) await api.tabs.group({ groupId, tabIds: [rec.tabId] });
              } catch (_) {
                /* keep it at the end of the group */
              }
            } else {
              const newId = await api.tabs.group({ tabIds: [rec.tabId], createProperties: { windowId: rec.windowId } });
              const meta = groupMeta.get(rec.groupId);
              if (meta) await api.tabGroups.update(newId, { title: meta.title, color: meta.color });
              recreated.set(rec.groupId, newId);
            }
          }
          restored++;
        } catch (_) {
          /* window closed or tab not movable — skip it */
        }
      }

      for (const [oldId, newId] of recreated) {
        const meta = groupMeta.get(oldId);
        if (meta && meta.collapsed) {
          try {
            await api.tabGroups.update(newId, { collapsed: true });
          } catch (_) {
            /* ignore */
          }
        }
      }

      try {
        await api.storage.session.remove(UNDO_KEY);
      } catch (_) {
        /* ignore */
      }
      return { restored };
    }

    /* -------------------------------------------------------------- */
    /* Automatic grouping (opt-in)                                     */
    /* -------------------------------------------------------------- */

    /**
     * Called when a tab's address changes. Only ever works inside the tab's
     * own window and only touches:
     *   - tabs that are not in any group, and
     *   - tabs in a group named after one of the rules (the add-on's groups).
     * Groups the user made themselves are left alone.
     * Resolves to "grouped", "ungrouped" or null (nothing done).
     */
    async function autoGroupTab(tabId, settings) {
      let tab;
      try {
        tab = await api.tabs.get(tabId);
      } catch (_) {
        return null;
      }
      if (tab.pinned) return null;

      const compiled = Rules.compileEnabled(settings.rules);
      const match = Rules.findMatch(compiled, tab.url || "");

      if (inGroup(tab)) {
        let currentTitle = null;
        try {
          currentTitle = (await api.tabGroups.get(tab.groupId)).title;
        } catch (_) {
          return null;
        }
        const ruleTitles = new Set(compiled.map((c) => c.title));
        if (!ruleTitles.has(currentTitle)) return null; // the user's own group
        if (match && match.title === currentTitle) return null; // already right
        if (!match) {
          await api.tabs.ungroup(tab.id);
          return "ungrouped";
        }
      }
      if (!match) return null;
      await addToGroup(tab.windowId, match.title, match.rule.color, [tab.id]);
      return "grouped";
    }

    return { plan, countMatches, groupNow, groupSiteOf, undo, getUndoInfo, autoGroupTab };
  }

  const api = { createEngine, NO_GROUP };
  root.GTUGrouping = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
