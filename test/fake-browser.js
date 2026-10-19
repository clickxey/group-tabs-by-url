/*
 * A small in-memory model of Firefox's windows, tabs and tab groups, with the
 * subset of the WebExtension API the engine uses. It enforces the same
 * invariants as Firefox (pinned tabs first and never grouped, a group's tabs
 * are adjacent, empty groups disappear) so the tests can check the engine
 * leaves the tab strip in a valid state.
 */
"use strict";

const NO_GROUP = -1;

function createFakeBrowser(spec) {
  let nextTabId = 1;
  let nextGroupId = 1000;
  const windows = new Map(); // id → { id, incognito, order: [tabId] }
  const tabs = new Map(); // id → { id, windowId, url, pinned, groupId, discarded }
  const groups = new Map(); // id → { id, windowId, title, color, collapsed }
  const calls = { reload: 0, update: [], create: 0, remove: 0 };

  for (const w of spec.windows) {
    const win = { id: w.id, incognito: !!w.incognito, order: [] };
    windows.set(w.id, win);
    for (const t of w.tabs) {
      const tab = { id: nextTabId++, windowId: w.id, url: t.url, pinned: !!t.pinned, groupId: NO_GROUP, discarded: !!t.discarded };
      tabs.set(tab.id, tab);
      win.order.push(tab.id);
      if (t.group) {
        let g = [...groups.values()].find((x) => x.windowId === w.id && x.title === t.group);
        if (!g) {
          g = { id: nextGroupId++, windowId: w.id, title: t.group, color: "pink", collapsed: false };
          groups.set(g.id, g);
        }
        tab.groupId = g.id;
      }
    }
  }

  const err = (m) => Promise.reject(new Error(m));
  const tabView = (tab) => {
    const win = windows.get(tab.windowId);
    return { ...tab, index: win.order.indexOf(tab.id), incognito: win.incognito };
  };

  function cleanupGroups() {
    for (const g of [...groups.values()]) {
      if (![...tabs.values()].some((t) => t.groupId === g.id)) groups.delete(g.id);
    }
  }

  function detach(tabId) {
    const tab = tabs.get(tabId);
    const win = windows.get(tab.windowId);
    win.order.splice(win.order.indexOf(tabId), 1);
  }

  // Index just after the last pinned tab.
  const firstUnpinned = (win) => win.order.filter((id) => tabs.get(id).pinned).length;

  // If `index` lands strictly inside a group, push it to just after that group.
  function outsideGroups(win, index, exceptGroup) {
    const left = win.order[index - 1];
    const right = win.order[index];
    if (left == null || right == null) return index;
    const lg = tabs.get(left).groupId;
    if (lg !== NO_GROUP && lg !== exceptGroup && lg === tabs.get(right).groupId) {
      let i = index;
      while (i < win.order.length && tabs.get(win.order[i]).groupId === lg) i++;
      return i;
    }
    return index;
  }

  const api = {
    _calls: calls,
    _state: { windows, tabs, groups },

    windows: {
      async get(id) {
        const w = windows.get(id);
        if (!w) throw new Error("Invalid window ID: " + id);
        return { id: w.id, incognito: w.incognito };
      },
      async getLastFocused() {
        const w = [...windows.values()][0];
        return { id: w.id, incognito: w.incognito };
      },
    },

    tabs: {
      async query() {
        const out = [];
        for (const w of windows.values()) for (const id of w.order) out.push(tabView(tabs.get(id)));
        return out;
      },
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error("Invalid tab ID: " + id);
        return tabView(t);
      },
      async reload() {
        calls.reload++;
      },
      async create() {
        calls.create++;
      },
      async remove() {
        calls.remove++;
      },
      async update(id, props) {
        calls.update.push({ id, props });
        if (Object.keys(props).some((k) => k !== "pinned")) throw new Error("only pinned supported in fake");
        const tab = tabs.get(id);
        const win = windows.get(tab.windowId);
        if (props.pinned && !tab.pinned) {
          detach(id);
          tab.pinned = true;
          tab.groupId = NO_GROUP;
          win.order.splice(firstUnpinned(win), 0, id);
          cleanupGroups();
        }
        return tabView(tab);
      },
      async move(id, { windowId, index }) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("Invalid tab ID");
        const dest = windows.get(windowId);
        if (!dest) throw new Error("Invalid window ID");
        if (dest.incognito !== windows.get(tab.windowId).incognito) throw new Error("Can't move tabs between private and non-private windows");
        const oldGroup = tab.groupId;
        detach(id);
        tab.windowId = windowId;
        let i = index < 0 || index > dest.order.length ? dest.order.length : index;
        if (!tab.pinned) i = Math.max(i, firstUnpinned(dest));
        dest.order.splice(i, 0, id);
        // Group membership follows the neighbours, like Firefox.
        const left = dest.order[i - 1] != null ? tabs.get(dest.order[i - 1]).groupId : NO_GROUP;
        const right = dest.order[i + 1] != null ? tabs.get(dest.order[i + 1]).groupId : NO_GROUP;
        if (left !== NO_GROUP && left === right) tab.groupId = left;
        else if (oldGroup !== NO_GROUP && groups.get(oldGroup)?.windowId === windowId && (left === oldGroup || right === oldGroup)) tab.groupId = oldGroup;
        else tab.groupId = NO_GROUP;
        cleanupGroups();
        return [tabView(tab)];
      },
      async group({ tabIds, groupId, createProperties }) {
        const ids = [].concat(tabIds);
        if (!ids.length) return err("tabIds must not be empty");
        for (const id of ids) if (!tabs.has(id)) return err("Invalid tab ID: " + id);
        let g;
        let win;
        let insertAt;
        if (groupId != null) {
          g = groups.get(groupId);
          if (!g) return err("No group with id: " + groupId);
          win = windows.get(g.windowId);
        } else {
          const windowId = (createProperties && createProperties.windowId) ?? tabs.get(ids[0]).windowId;
          win = windows.get(windowId);
          if (!win) return err("Invalid window ID");
          g = { id: nextGroupId++, windowId: win.id, title: "", color: "grey", collapsed: false };
        }
        for (const id of ids) {
          if (windows.get(tabs.get(id).windowId).incognito !== win.incognito) return err("Can't move tabs between private and non-private windows");
        }
        if (groupId == null) {
          groups.set(g.id, g);
          const first = tabs.get(ids[0]);
          insertAt =
            first.windowId === win.id && !first.pinned
              ? win.order.slice(0, win.order.indexOf(first.id)).filter((x) => !ids.includes(x)).length
              : Infinity;
        }
        for (const id of ids) detach(id);
        if (groupId != null) {
          const members = win.order.filter((x) => tabs.get(x).groupId === g.id);
          insertAt = win.order.indexOf(members[members.length - 1]) + 1;
        } else {
          insertAt = Math.min(insertAt, win.order.length);
          insertAt = Math.max(insertAt, firstUnpinned(win));
          insertAt = outsideGroups(win, insertAt, g.id);
        }
        for (const id of ids) {
          const tab = tabs.get(id);
          tab.windowId = win.id;
          tab.pinned = false;
          tab.groupId = g.id;
        }
        win.order.splice(insertAt, 0, ...ids);
        cleanupGroups();
        return g.id;
      },
      async ungroup(tabIds) {
        for (const id of [].concat(tabIds)) {
          const tab = tabs.get(id);
          if (!tab || tab.groupId === NO_GROUP) continue;
          const win = windows.get(tab.windowId);
          const gid = tab.groupId;
          detach(id);
          const members = win.order.filter((x) => tabs.get(x).groupId === gid);
          const at = members.length ? win.order.indexOf(members[members.length - 1]) + 1 : win.order.length;
          win.order.splice(at, 0, id);
          tab.groupId = NO_GROUP;
        }
        cleanupGroups();
      },
    },

    tabGroups: {
      async query(filter = {}) {
        return [...groups.values()].filter((g) => filter.windowId == null || g.windowId === filter.windowId).map((g) => ({ ...g }));
      },
      async get(id) {
        const g = groups.get(id);
        if (!g) throw new Error("No group with id: " + id);
        return { ...g };
      },
      async update(id, props) {
        const g = groups.get(id);
        if (!g) throw new Error("No group with id: " + id);
        Object.assign(g, props);
        return { ...g };
      },
    },

    storage: {
      session: memoryArea(),
      local: memoryArea(),
    },
  };

  /** Throws if the strip violates a Firefox invariant. */
  api._checkInvariants = function () {
    for (const w of windows.values()) {
      let seenUnpinned = false;
      const closed = new Set();
      let prev = NO_GROUP;
      for (const id of w.order) {
        const t = tabs.get(id);
        if (t.windowId !== w.id) throw new Error(`tab ${id} windowId mismatch`);
        if (t.pinned) {
          if (seenUnpinned) throw new Error(`pinned tab ${id} after unpinned`);
          if (t.groupId !== NO_GROUP) throw new Error(`pinned tab ${id} in a group`);
        } else seenUnpinned = true;
        if (t.groupId !== NO_GROUP) {
          const g = groups.get(t.groupId);
          if (!g) throw new Error(`tab ${id} in missing group`);
          if (g.windowId !== w.id) throw new Error(`tab ${id} group in other window`);
          if (closed.has(t.groupId)) throw new Error(`group ${t.groupId} not contiguous`);
        }
        if (prev !== t.groupId && prev !== NO_GROUP) closed.add(prev);
        prev = t.groupId;
      }
    }
  };

  /** Compact text picture of a window, e.g. "a.com [X: x.com x.com] b.com". */
  api._layout = function (windowId) {
    const w = windows.get(windowId);
    const out = [];
    let open = null;
    for (const id of w.order) {
      const t = tabs.get(id);
      if (t.groupId !== open) {
        if (open !== null && open !== NO_GROUP) out.push("]");
        if (t.groupId !== NO_GROUP) out.push(`[${groups.get(t.groupId).title}:`);
        open = t.groupId;
      }
      out.push((t.pinned ? "📌" : "") + t.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""));
    }
    if (open !== null && open !== NO_GROUP) out.push("]");
    return out.join(" ");
  };

  api._snapshotUrls = () => new Map([...tabs.values()].map((t) => [t.id, t.url + "|" + t.discarded]));

  return api;
}

function memoryArea() {
  let data = {};
  return {
    async get(key) {
      if (key == null) return { ...data };
      const keys = [].concat(key);
      const out = {};
      for (const k of keys) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
      return out;
    },
    async set(obj) {
      data = { ...data, ...JSON.parse(JSON.stringify(obj)) };
    },
    async remove(key) {
      for (const k of [].concat(key)) delete data[k];
    },
  };
}

module.exports = { createFakeBrowser, NO_GROUP };
