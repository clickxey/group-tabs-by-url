"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../extension/shared/rules.js");

const rule = (type, patterns, extra = {}) => R.normalizeRule({ type, patterns, ...extra });
const matches = (r, url) => R.compileRule(r).test(url);

test("site: matches the domain and its subdomains only", () => {
  const r = rule("site", ["x.com"]);
  assert.ok(matches(r, "https://x.com/home"));
  assert.ok(matches(r, "https://www.x.com/"));
  assert.ok(matches(r, "https://mobile.x.com/i/status/1"));
  assert.ok(matches(r, "http://X.COM"));
  assert.ok(!matches(r, "https://netflix.com/"), "lookalike suffix");
  assert.ok(!matches(r, "https://x.com.evil.example/"), "domain used as subdomain elsewhere");
  assert.ok(!matches(r, "https://example.com/?ref=x.com"), "domain in query string");
  assert.ok(!matches(r, "about:newtab"));
});

test("site: optional path narrows the match", () => {
  const r = rule("site", ["google.com/search"]);
  assert.ok(matches(r, "https://www.google.com/search?q=firefox"));
  assert.ok(!matches(r, "https://www.google.com/maps"));
  assert.ok(!matches(r, "https://www.google.ca/search?q=x"));
});

test("site: tolerant of how people type sites", () => {
  for (const p of ["https://www.github.com/", "GitHub.com", "*.github.com", "github.com:443", "github.com."]) {
    assert.deepEqual(R.parseSitePattern(p), { host: "github.com", path: "" }, p);
  }
  assert.deepEqual(R.parseSitePattern("github.com/Mozilla"), { host: "github.com", path: "/mozilla" });
  assert.equal(R.parseSitePattern("about:newtab"), null);
  assert.equal(R.parseSitePattern("not a site"), null);
  assert.equal(R.parseSitePattern(""), null);
});

test("site: internationalised domain names", () => {
  assert.ok(matches(rule("site", ["bücher.de"]), "https://xn--bcher-kva.de/katalog"));
});

test("contains / prefix / regex", () => {
  assert.ok(matches(rule("contains", ["/search"]), "https://duckduckgo.com/search?q=1"));
  assert.ok(matches(rule("contains", ["GitHub"]), "https://github.com"), "case-insensitive");
  assert.ok(matches(rule("prefix", ["about:newtab"]), "about:newtab"));
  assert.ok(!matches(rule("prefix", ["about:newtab"]), "https://x.com/about:newtab"));
  assert.ok(matches(rule("regex", ["^https://(www\\.)?google\\.[a-z.]+/search"]), "https://www.google.co.uk/search?q=a"));
  assert.ok(!matches(rule("regex", ["^https://(www\\.)?google\\.[a-z.]+/search"]), "https://www.google.com/maps"));
});

test("invalid patterns are reported and skipped, valid ones still work", () => {
  const c = R.compileRule(rule("regex", ["(", "example"]));
  assert.deepEqual(c.errors, [{ line: 1, pattern: "(", error: "errorInvalidRegex" }]);
  assert.ok(c.test("https://example.com"));
  assert.equal(R.compileRule(rule("site", ["about:home"])).errors[0].error, "errorInvalidSite");
});

test("first enabled rule wins; disabled rules are ignored", () => {
  const rules = R.normalizeRules([
    { name: "Off", type: "site", patterns: ["github.com"], enabled: false },
    { name: "Code", type: "contains", patterns: ["github"] },
    { name: "Later", type: "site", patterns: ["github.com"] },
  ]);
  const hit = R.findMatch(R.compileEnabled(rules), "https://github.com/mozilla");
  assert.equal(hit.title, "Code");
  assert.equal(R.findMatch(R.compileEnabled(rules), "https://example.com"), null);
});

test("ruleTitle falls back to the first pattern", () => {
  assert.equal(R.ruleTitle(rule("site", ["x.com"], { name: "  " })), "x.com");
  assert.equal(R.ruleTitle(rule("site", ["x.com"], { name: " X " })), "X");
  assert.equal(R.ruleTitle(rule("site", [])), "Group");
});

test("normalizeSettings: defaults, cleanup and 1.0 migration", () => {
  const d = R.normalizeSettings(undefined);
  assert.equal(d.rules.length, R.DEFAULT_RULES.length);
  assert.equal(d.mode, "collect");

  const cleaned = R.normalizeSettings({
    mode: "bogus",
    collapse: 1,
    rules: [{ id: "a", type: "nope", color: "rainbow", patterns: " a \n\n b " }, { id: "a", patterns: ["c"] }, null],
  });
  assert.equal(cleaned.mode, "collect");
  assert.equal(cleaned.collapse, true);
  assert.equal(cleaned.rules[0].type, "contains");
  assert.ok(R.COLORS.includes(cleaned.rules[0].color));
  assert.deepEqual(cleaned.rules[0].patterns, ["a", "b"]);
  assert.notEqual(cleaned.rules[0].id, cleaned.rules[1].id, "duplicate ids are fixed");
  assert.deepEqual(cleaned.rules[2].patterns, []);

  const legacy = R.normalizeSettings({ rules: "X | x.com, twitter.com\n# comment\ngoogle.com/search", mode: "perWindow" });
  assert.equal(legacy.mode, "perWindow");
  assert.deepEqual(
    legacy.rules.map((r) => [r.name, r.type, r.patterns]),
    [["X", "contains", ["x.com", "twitter.com"]], ["", "contains", ["google.com/search"]]]
  );
});

test("import: our export round-trips, plus arrays and 1.0 text", () => {
  const s = R.normalizeSettings(undefined);
  const back = R.parseImport(R.exportRules(s));
  assert.deepEqual(
    back.map(({ name, type, patterns, color, enabled }) => ({ name, type, patterns, color, enabled })),
    s.rules.map(({ name, type, patterns, color, enabled }) => ({ name, type, patterns, color, enabled }))
  );
  assert.ok(back.every((r, i) => r.id !== s.rules[i].id), "imported rules get fresh ids");
  assert.equal(R.parseImport('[{"type":"site","patterns":["a.com"]}]')[0].patterns[0], "a.com");
  assert.equal(R.parseImport("News | bbc.co.uk")[0].name, "News");
  assert.throws(() => R.parseImport("{not json"), /errorImportInvalid/);
  assert.throws(() => R.parseImport('{"foo":1}'), /errorImportInvalid/);
  assert.throws(() => R.parseImport("# only a comment"), /errorImportEmpty/);
});

test("siteFromUrl and findSiteRule", () => {
  assert.equal(R.siteFromUrl("https://www.github.com/a"), "github.com");
  assert.equal(R.siteFromUrl("about:newtab"), null);
  assert.equal(R.siteFromUrl("moz-extension://abc/page.html"), null);
  const rules = R.normalizeRules([{ type: "site", patterns: ["github.com/mozilla"] }, { id: "gh", type: "site", patterns: ["www.github.com"] }]);
  assert.equal(R.findSiteRule(rules, "github.com").id, "gh");
  assert.equal(R.findSiteRule(rules, "gitlab.com"), null);
});

test("makeRule picks an unused colour", () => {
  const rules = R.normalizeRules([{ color: "blue" }, { color: "red" }]);
  assert.equal(R.makeRule({ patterns: ["a.com"] }, rules).color, "yellow");
});
