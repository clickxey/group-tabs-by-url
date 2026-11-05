"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../extension/shared/rules.js");
const { createEngine } = require("../extension/shared/grouping.js");
const { createSettingsStore } = require("../extension/shared/settings.js");
const { createFakeBrowser } = require("./fake-browser.js");

const RULES = [
  { id: "x", name: "X", color: "blue", type: "site", patterns: ["x.com"] },
  { id: "s", name: "Search", color: "yellow", type: "site", patterns: ["google.com/search"] },
  { id: "n", name: "New tabs", color: "grey", type: "prefix", patterns: ["about:newtab"] },
];
const settings = (extra = {}) => R.normalizeSettings({ rules: RULES, ...extra });

function setup(windows) {
  const browser = createFakeBrowser({ windows });
  const before = browser._snapshotUrls();
  const engine = createEngine(browser);
  const check = () => {
    browser._checkInvariants();
    assert.deepEqual(browser._snapshotUrls(), before, "no tab changed address or loaded state");
    assert.equal(browser._calls.reload, 0, "no reloads");
    assert.equal(browser._calls.create + browser._calls.remove, 0, "no tabs created or closed");
  };
  return { browser, engine, check };
}

const u = (s) => ({ url: s.includes(":") ? s : "https://" + s });

test("collect mode pulls matching tabs from every window into the current one", async () => {
  const { browser, engine, check } = setup([
    { id: 1, tabs: [u("a.com"), u("x.com/1"), u("netflix.com"), u("about:newtab")] },
    { id: 2, tabs: [u("x.com/2"), u("www.google.com/search?q=1"), u("b.com")] },
  ]);
  const res = await engine.groupNow(settings(), 1);
  assert.equal(res.tabs, 4);
  assert.equal(res.groups, 3);
  assert.equal(browser._layout(1), "a.com [X: x.com/1 x.com/2 ] netflix.com [New tabs: about:newtab ] [Search: google.com/search?q=1 ]");
  assert.equal(browser._layout(2), "b.com");
  const groups = await browser.tabGroups.query({});
  assert.deepEqual(groups.map((g) => [g.title, g.color]).sort(), [["New tabs", "grey"], ["Search", "yellow"], ["X", "blue"]]);
  check();
});

test("perWindow mode groups inside each window without moving tabs between windows", async () => {
  const { browser, engine, check } = setup([
    { id: 1, tabs: [u("x.com/1"), u("a.com"), u("x.com/3")] },
    { id: 2, tabs: [u("x.com/2"), u("b.com")] },
  ]);
  await engine.groupNow(settings({ mode: "perWindow" }), 1);
  assert.equal(browser._layout(1), "[X: x.com/1 x.com/3 ] a.com");
  assert.equal(browser._layout(2), "[X: x.com/2 ] b.com");
  check();
});

test("running again reuses the existing group instead of making a duplicate", async () => {
  const { browser, engine, check } = setup([{ id: 1, tabs: [u("x.com/1"), u("a.com"), u("x.com/2")] }]);
  await engine.groupNow(settings(), 1);
  await browser.tabs.move(2, { windowId: 1, index: -1 }); // nothing else changes
  const extra = await browser.tabs.query({});
  assert.equal(extra.length, 3);
  await engine.groupNow(settings(), 1);
  const groups = await browser.tabGroups.query({});
  assert.equal(groups.length, 1);
  check();
});

test("private-window tabs are grouped in their own window when they can't move", async () => {
  const { browser, engine, check } = setup([
    { id: 1, tabs: [u("x.com/1")] },
    { id: 2, incognito: true, tabs: [u("x.com/private"), u("a.com")] },
  ]);
  const res = await engine.groupNow(settings(), 1);
  assert.equal(res.results.find((r) => r.ruleId === "x").error, null);
  assert.equal(browser._layout(1), "[X: x.com/1 ]");
  assert.equal(browser._layout(2), "[X: x.com/private ] a.com");
  check();
});

test("pinned tabs are left alone unless enabled", async () => {
  const win = () => [{ id: 1, tabs: [{ ...u("x.com/pinned"), pinned: true }, u("x.com/1")] }];
  let t = setup(win());
  await t.engine.groupNow(settings(), 1);
  assert.equal(t.browser._layout(1), "📌x.com/pinned [X: x.com/1 ]");
  t.check();

  t = setup(win());
  await t.engine.groupNow(settings({ includePinned: true }), 1);
  assert.equal(t.browser._layout(1), "[X: x.com/pinned x.com/1 ]");
  t.check();
});

test("skipGrouped leaves tabs in the user's own groups alone", async () => {
  const win = () => [{ id: 1, tabs: [{ ...u("x.com/research"), group: "Work" }, u("a.com"), u("x.com/1")] }];
  let t = setup(win());
  await t.engine.groupNow(settings({ skipGrouped: true }), 1);
  assert.equal(t.browser._layout(1), "[Work: x.com/research ] a.com [X: x.com/1 ]");
  t.check();

  t = setup(win());
  await t.engine.groupNow(settings(), 1);
  assert.equal(t.browser._layout(1), "[X: x.com/research x.com/1 ] a.com");
  t.check();
});

test("collapse option collapses the new groups", async () => {
  const { browser, engine } = setup([{ id: 1, tabs: [u("x.com/1"), u("a.com")] }]);
  await engine.groupNow(settings({ collapse: true }), 1);
  const [g] = await browser.tabGroups.query({});
  assert.equal(g.collapsed, true);
});

test("one-time rule: groups only its own matches, ignores saved rules, and can be undone", async () => {
  const { browser, engine, check } = setup([
    { id: 1, tabs: [u("kaggle.com/competitions/rsna-knee/data"), u("x.com/1"), u("kaggle.com/code")] },
    { id: 2, tabs: [u("kaggle.com/competitions/rsna-knee/leaderboard"), u("x.com/2")] },
  ]);
  const before = { 1: browser._layout(1), 2: browser._layout(2) };
  const quick = R.normalizeRule({ id: "quick", name: "", color: "green", type: "contains", patterns: ["RSNA-knee"] });

  const res = await engine.groupNow(settings(), 1, { rules: [quick] });
  assert.equal(res.tabs, 2);
  assert.equal(res.groups, 1);
  assert.equal(browser._layout(1), "[RSNA-knee: kaggle.com/competitions/rsna-knee/data kaggle.com/competitions/rsna-knee/leaderboard ] x.com/1 kaggle.com/code");
  assert.equal(browser._layout(2), "x.com/2", "tabs matching saved rules are left alone");
  const [g] = await browser.tabGroups.query({});
  assert.deepEqual([g.title, g.color], ["RSNA-knee", "green"], "untitled one-time rule uses the typed text");
  check();

  await engine.undo();
  assert.equal(browser._layout(1), before[1]);
  assert.equal(browser._layout(2), before[2]);
  check();
});

test("one-time rule respects the behaviour settings", async () => {
  const { browser, engine } = setup([{ id: 1, tabs: [{ ...u("kaggle.com/c/a"), group: "Mine" }, u("kaggle.com/c/b"), { ...u("kaggle.com/c/p"), pinned: true }].reverse() }]);
  const quick = R.normalizeRule({ id: "quick", name: "Comp", type: "site", patterns: ["kaggle.com"] });
  await engine.groupNow(settings({ skipGrouped: true, collapse: true }), 1, { rules: [quick] });
  assert.equal(browser._layout(1), "📌kaggle.com/c/p [Comp: kaggle.com/c/b ] [Mine: kaggle.com/c/a ]");
  assert.equal((await browser.tabGroups.query({})).find((g) => g.title === "Comp").collapsed, true);
});

test("nothing to do: no changes and no undo snapshot", async () => {
  const { browser, engine, check } = setup([{ id: 1, tabs: [u("a.com")] }]);
  const res = await engine.groupNow(settings(), 1);
  assert.equal(res.tabs, 0);
  assert.equal(await engine.getUndoInfo(), null);
  assert.equal(browser._layout(1), "a.com");
  check();
});

test("undo puts tabs back: window, position, pinned state and original groups", async () => {
  const windows = [
    { id: 1, tabs: [{ ...u("x.com/pin"), pinned: true }, u("a.com"), u("x.com/1"), { ...u("x.com/w"), group: "Work" }, { ...u("w.com"), group: "Work" }, u("b.com")] },
    { id: 2, tabs: [u("c.com"), { ...u("x.com/solo"), group: "Solo" }, u("x.com/2"), u("d.com")] },
  ];
  const { browser, engine, check } = setup(windows);
  const before = { 1: browser._layout(1), 2: browser._layout(2) };

  await engine.groupNow(settings({ includePinned: true }), 1);
  assert.notEqual(browser._layout(1), before[1]);
  assert.deepEqual(await engine.getUndoInfo().then((i) => i.tabs), 5);
  check();

  const res = await engine.undo();
  assert.equal(res.restored, 5);
  assert.equal(browser._layout(1), before[1]);
  assert.equal(browser._layout(2), before[2]);
  const solo = (await browser.tabGroups.query({ windowId: 2 }))[0];
  assert.equal(solo.title, "Solo", "a group emptied by grouping is recreated");
  assert.equal(await engine.getUndoInfo(), null, "undo is one-shot");
  check();
});

test("undo skips tabs closed in the meantime", async () => {
  const { browser, engine } = setup([{ id: 1, tabs: [u("x.com/1"), u("a.com"), u("x.com/2")] }]);
  await engine.groupNow(settings(), 1);
  browser._state.windows.get(1).order = browser._state.windows.get(1).order.filter((id) => id !== 3);
  browser._state.tabs.delete(3);
  const res = await engine.undo();
  assert.equal(res.restored, 1);
  assert.equal(browser._layout(1), "x.com/1 a.com");
});

test("one-off 'group this site' uses the matching rule's name and colour", async () => {
  const { browser, engine, check } = setup([{ id: 1, tabs: [u("github.com/a"), u("x.com/1"), u("gist.github.com/b"), u("x.com/2")] }]);
  await engine.groupSiteOf({ url: "https://github.com/a" }, settings(), 1);
  assert.equal(browser._layout(1), "[github.com: github.com/a gist.github.com/b ] x.com/1 x.com/2");
  await engine.groupSiteOf({ url: "https://x.com/1" }, settings(), 1);
  const groups = await browser.tabGroups.query({});
  assert.ok(groups.some((g) => g.title === "X" && g.color === "blue"));
  check();
});

test("auto-group: adds new matches, releases tabs that stop matching, ignores user groups", async () => {
  const { browser, engine, check } = setup([
    { id: 1, tabs: [u("a.com"), { ...u("x.com/mine"), group: "Mine" }, u("x.com/1")] },
  ]);
  const s = settings({ autoGroup: true });

  assert.equal(await engine.autoGroupTab(3, s), "grouped");
  assert.equal(browser._layout(1), "a.com [Mine: x.com/mine ] [X: x.com/1 ]");

  assert.equal(await engine.autoGroupTab(2, s), null, "user's own group is untouched");
  assert.equal(await engine.autoGroupTab(3, s), null, "already in the right group");

  browser._state.tabs.get(3).url = "https://example.com/"; // the tab navigated away
  assert.equal(await engine.autoGroupTab(3, s), "ungrouped");
  assert.equal(browser._layout(1), "a.com [Mine: x.com/mine ] example.com");

  browser._state.tabs.get(1).url = "about:newtab";
  assert.equal(await engine.autoGroupTab(1, s), "grouped");
  assert.equal(await engine.autoGroupTab(999, s), null, "closed tab");
  browser._checkInvariants();
});

test("settings store: addSiteRule doesn't duplicate", async () => {
  const browser = createFakeBrowser({ windows: [] });
  const store = createSettingsStore(browser.storage.local);
  const first = await store.addSiteRule("github.com");
  const again = await store.addSiteRule("github.com");
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.rule.id, first.rule.id);
  const s = await store.load();
  assert.equal(s.rules.filter((r) => r.name === "github.com").length, 1);
});
