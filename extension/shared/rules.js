/*
 * Group Tabs by URL — rule model and URL matching.
 *
 * Pure functions only: nothing in this file touches a browser API, so it is
 * shared by the background script, the popup, the options page and the unit
 * tests (which load it with Node's `require`).
 *
 * A rule looks like:
 *   {
 *     id:       "r-lx3k9a2b",          // stable identifier
 *     name:     "X",                   // tab group title ("" → first pattern)
 *     color:    "blue",                // one of COLORS (Firefox group colours)
 *     type:     "site",                // one of MATCH_TYPES
 *     patterns: ["x.com", "twitter.com"],
 *     enabled:  true
 *   }
 *
 * A tab belongs to the FIRST enabled rule with any matching pattern.
 */
(function (root) {
  "use strict";

  const SCHEMA_VERSION = 2;

  /** Colours accepted by tabGroups.update(), in the order new rules use them. */
  const COLORS = ["blue", "red", "yellow", "green", "purple", "cyan", "orange", "pink", "grey"];

  /**
   * site     – a website and its subdomains, optionally narrowed by a path
   *            ("x.com" matches x.com and mobile.x.com but not netflix.com).
   * contains – the address contains the text anywhere.
   * prefix   – the address starts with the text (good for about: pages).
   * regex    – a JavaScript regular expression, case-insensitive.
   */
  const MATCH_TYPES = ["site", "contains", "prefix", "regex"];

  const MODES = ["collect", "perWindow"];

  const LIMITS = { rules: 200, patternsPerRule: 200, nameLength: 100, patternLength: 2000 };

  const DEFAULT_RULES = [
    { id: "default-x", name: "X", color: "blue", type: "site", patterns: ["x.com", "twitter.com"], enabled: true },
    { id: "default-youtube", name: "YouTube", color: "red", type: "site", patterns: ["youtube.com", "youtu.be"], enabled: true },
    { id: "default-search", name: "Google Search", color: "yellow", type: "site", patterns: ["google.com/search"], enabled: true },
    { id: "default-newtab", name: "New tabs", color: "grey", type: "prefix", patterns: ["about:newtab", "about:home", "about:blank"], enabled: true },
  ];

  const DEFAULT_SETTINGS = {
    schema: SCHEMA_VERSION,
    rules: DEFAULT_RULES,
    mode: "collect",       // "collect": bring matches into the current window; "perWindow": group inside each window
    collapse: false,       // collapse the groups after grouping
    includePinned: false,  // grouping unpins a tab, so pinned tabs are left alone by default
    skipGrouped: false,    // leave tabs that already sit in a group of their own alone
    autoGroup: false,      // keep grouping as tabs open / navigate (same window only)
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));

  function newId() {
    return "r-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ------------------------------------------------------------------ */
  /* Normalisation — everything read from storage or an import passes   */
  /* through here, so the rest of the code can trust the shape.          */
  /* ------------------------------------------------------------------ */

  function splitPatterns(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return value.split(/\r?\n/);
    return [];
  }

  function normalizeRule(raw, index = 0, usedIds = new Set()) {
    const r = raw && typeof raw === "object" ? raw : {};
    const patterns = splitPatterns(r.patterns)
      .map((p) => String(p).trim().slice(0, LIMITS.patternLength))
      .filter(Boolean)
      .slice(0, LIMITS.patternsPerRule);

    let id = typeof r.id === "string" && r.id ? r.id.slice(0, 64) : newId();
    while (usedIds.has(id)) id = newId();
    usedIds.add(id);

    return {
      id,
      name: typeof r.name === "string" ? r.name.slice(0, LIMITS.nameLength) : "",
      color: COLORS.includes(r.color) ? r.color : COLORS[index % COLORS.length],
      type: MATCH_TYPES.includes(r.type) ? r.type : "contains",
      patterns,
      enabled: r.enabled !== false,
    };
  }

  function normalizeRules(list) {
    const used = new Set();
    return (Array.isArray(list) ? list : []).slice(0, LIMITS.rules).map((r, i) => normalizeRule(r, i, used));
  }

  function normalizeSettings(raw) {
    if (!raw || typeof raw !== "object") return clone(DEFAULT_SETTINGS);
    let rules;
    if (Array.isArray(raw.rules)) rules = normalizeRules(raw.rules);
    else if (typeof raw.rules === "string") rules = parseLegacyText(raw.rules); // version 1.0 stored plain text
    else rules = clone(DEFAULT_RULES);

    return {
      schema: SCHEMA_VERSION,
      rules,
      mode: MODES.includes(raw.mode) ? raw.mode : DEFAULT_SETTINGS.mode,
      collapse: !!raw.collapse,
      includePinned: !!raw.includePinned,
      skipGrouped: !!raw.skipGrouped,
      autoGroup: !!raw.autoGroup,
    };
  }

  /** Display title of a rule, also used as the tab group's title. */
  function ruleTitle(rule) {
    const name = (rule.name || "").trim();
    return name || rule.patterns[0] || "Group";
  }

  /** The colour used least so far, so new rules look distinct. */
  function nextColor(rules) {
    const used = new Map(COLORS.map((c) => [c, 0]));
    for (const r of rules) if (used.has(r.color)) used.set(r.color, used.get(r.color) + 1);
    let best = COLORS[0];
    for (const c of COLORS) if (used.get(c) < used.get(best)) best = c;
    return best;
  }

  /** Stable colour for an ad-hoc group (e.g. "group all tabs from this site"). */
  function colorForText(text) {
    let h = 0;
    for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  function makeRule(fields, existingRules = []) {
    return normalizeRule(
      { id: newId(), color: nextColor(existingRules), type: "site", enabled: true, ...fields },
      existingRules.length,
      new Set(existingRules.map((r) => r.id))
    );
  }

  /* ------------------------------------------------------------------ */
  /* Matching                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * "https://www.Example.com/Path?q" → { host: "example.com", path: "/path?q" }
   * Returns null when the text cannot be a host name.
   */
  function parseSitePattern(pattern) {
    let s = String(pattern).trim().toLowerCase();
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // drop "https://"
    s = s.replace(/^\*\./, "").replace(/^www\./, "");
    const slash = s.search(/[/?#]/);
    let host = slash < 0 ? s : s.slice(0, slash);
    let path = slash < 0 ? "" : s.slice(slash);
    host = host.replace(/:\d+$/, "").replace(/\.$/, "");
    if (!host || /[\s@:*]/.test(host)) return null;
    try {
      host = new URL("http://" + host + "/").hostname; // punycode for internationalised names
    } catch (_) {
      return null;
    }
    if (path === "/") path = "";
    if (path && path[0] !== "/") path = "/" + path;
    return { host, path };
  }

  function hostAndPath(url) {
    try {
      const u = new URL(url);
      if (!u.hostname) return null;
      return { host: u.hostname.toLowerCase().replace(/\.$/, ""), path: (u.pathname + u.search).toLowerCase() };
    } catch (_) {
      return null;
    }
  }

  /**
   * Compile one pattern. Returns { test(url) } or { error } where error is an
   * i18n message key explaining what is wrong.
   */
  function compilePattern(type, pattern) {
    const text = String(pattern).trim();
    switch (type) {
      case "site": {
        const site = parseSitePattern(text);
        if (!site) return { error: "errorInvalidSite" };
        return {
          test(url) {
            const u = hostAndPath(url);
            if (!u) return false;
            if (u.host !== site.host && !u.host.endsWith("." + site.host)) return false;
            return !site.path || u.path.startsWith(site.path);
          },
        };
      }
      case "contains": {
        const needle = text.toLowerCase();
        return { test: (url) => url.toLowerCase().includes(needle) };
      }
      case "prefix": {
        const needle = text.toLowerCase();
        return { test: (url) => url.toLowerCase().startsWith(needle) };
      }
      case "regex": {
        let re;
        try {
          re = new RegExp(text, "i");
        } catch (_) {
          return { error: "errorInvalidRegex" };
        }
        return { test: (url) => re.test(url) };
      }
      default:
        return { error: "errorInvalidType" };
    }
  }

  /**
   * Compile a rule. `errors` lists patterns that could not be compiled
   * ({ line, pattern, error }); valid patterns still work.
   */
  function compileRule(rule) {
    const tests = [];
    const errors = [];
    rule.patterns.forEach((pattern, i) => {
      const c = compilePattern(rule.type, pattern);
      if (c.error) errors.push({ line: i + 1, pattern, error: c.error });
      else tests.push(c.test);
    });
    return {
      rule,
      title: ruleTitle(rule),
      errors,
      test: (url) => tests.some((t) => t(url || "")),
    };
  }

  /** Compile all enabled rules, in priority order. */
  function compileEnabled(rules) {
    return rules.filter((r) => r.enabled).map(compileRule);
  }

  /** First compiled rule that matches the URL, or null. */
  function findMatch(compiled, url) {
    for (const c of compiled) if (c.test(url)) return c;
    return null;
  }

  /** "https://www.github.com/x" → "github.com"; null for non-web pages. */
  function siteFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.hostname.replace(/^www\./, "") || null;
    } catch (_) {
      return null;
    }
  }

  /*
   * Endings under which every name belongs to someone different, so the
   * part before them is the "main" domain: bbc.co.uk, not co.uk;
   * someone.github.io, not github.io. This is a short, hand-picked list of
   * common entries from the Public Suffix List (publicsuffix.org), not the
   * whole list. Unknown endings are treated as one label (".com", ".org").
   */
  const MULTI_PART_SUFFIXES = new Set([
    // Country domains with a second level
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "nhs.uk",
    "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
    "co.nz", "net.nz", "org.nz", "ac.nz", "govt.nz",
    "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "gr.jp", "ed.jp", "lg.jp",
    "co.kr", "or.kr", "ne.kr", "ac.kr", "go.kr",
    "com.cn", "net.cn", "org.cn", "edu.cn", "gov.cn",
    "com.hk", "org.hk", "edu.hk", "gov.hk", "com.tw", "org.tw", "edu.tw", "gov.tw",
    "com.sg", "edu.sg", "gov.sg", "com.my", "com.ph", "com.vn", "co.th", "ac.th", "co.id", "ac.id", "go.id",
    "co.in", "net.in", "org.in", "ac.in", "edu.in", "gov.in",
    "com.pk", "gov.pk", "com.bd", "com.sa", "gov.sa", "co.il", "org.il", "ac.il", "gov.il",
    "com.tr", "org.tr", "edu.tr", "gov.tr", "com.ua", "org.ua", "gov.ua", "com.pl", "net.pl", "org.pl", "gov.pl",
    "co.at", "or.at", "ac.at", "gv.at", "com.es", "org.es", "gob.es", "com.pt", "com.gr", "co.hu", "com.cy",
    "com.br", "net.br", "org.br", "edu.br", "gov.br", "com.mx", "org.mx", "edu.mx", "gob.mx",
    "com.ar", "gob.ar", "com.co", "gov.co", "com.pe", "gob.pe", "gob.cl", "com.uy", "com.ec", "com.ve",
    "co.za", "org.za", "ac.za", "gov.za", "co.ke", "or.ke", "co.tz", "co.ug", "com.ng", "gov.ng", "com.eg", "gov.eg",
    // Hosting where each subdomain is a different person's site
    "github.io", "gitlab.io", "netlify.app", "vercel.app", "pages.dev", "workers.dev", "web.app",
    "firebaseapp.com", "appspot.com", "herokuapp.com", "azurewebsites.net", "cloudfront.net", "s3.amazonaws.com",
  ]);

  /**
   * The main domain of a host, when the host is a subdomain of it:
   *   "en.wikipedia.org" → "wikipedia.org", "news.bbc.co.uk" → "bbc.co.uk".
   * Returns null when there is nothing shorter to offer ("wikipedia.org",
   * "bbc.co.uk", "me.github.io", "localhost", IP addresses).
   */
  function baseDomain(host) {
    const h = String(host || "").toLowerCase().replace(/\.$/, "");
    if (!h || h.includes(":") || /^\d+(\.\d+){3}$/.test(h)) return null;
    const labels = h.split(".");
    if (labels.some((l) => !l)) return null;
    let suffixLabels = 1;
    for (let n = labels.length - 1; n >= 2; n--) {
      if (MULTI_PART_SUFFIXES.has(labels.slice(-n).join("."))) {
        suffixLabels = n;
        break;
      }
    }
    if (labels.length <= suffixLabels + 1) return null;
    return labels.slice(-(suffixLabels + 1)).join(".");
  }

  /** True if an existing "site" rule already covers exactly this site. */
  function findSiteRule(rules, site) {
    return (
      rules.find(
        (r) => r.type === "site" && r.patterns.some((p) => {
          const parsed = parseSitePattern(p);
          return parsed && !parsed.path && parsed.host === site;
        })
      ) || null
    );
  }

  /* ------------------------------------------------------------------ */
  /* Import / export                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Version 1.0 text format, one rule per line:
   *   pattern
   *   Title | pattern1, pattern2
   *   # comment
   * Imported as "contains" rules, which is how 1.0 matched.
   */
  function parseLegacyText(text) {
    const rules = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const bar = line.indexOf("|");
      const title = bar >= 0 ? line.slice(0, bar).trim() : "";
      const patterns = (bar >= 0 ? line.slice(bar + 1) : line).split(",").map((s) => s.trim()).filter(Boolean);
      if (patterns.length) rules.push({ name: title, type: "contains", patterns });
    }
    return normalizeRules(rules);
  }

  const EXPORT_FORMAT = "group-tabs-by-url";

  function exportRules(settings) {
    return JSON.stringify(
      {
        format: EXPORT_FORMAT,
        schema: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        rules: settings.rules.map(({ name, color, type, patterns, enabled }) => ({ name, color, type, patterns, enabled })),
      },
      null,
      2
    );
  }

  /**
   * Accepts our JSON export, a bare JSON array of rules, a settings object,
   * or the 1.0 text format. Returns normalised rules (fresh ids) or throws.
   */
  function parseImport(text) {
    let list = null;
    const trimmed = String(text || "").trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let data;
      try {
        data = JSON.parse(trimmed);
      } catch (_) {
        throw new Error("errorImportInvalid");
      }
      list = Array.isArray(data) ? data : Array.isArray(data && data.rules) ? data.rules : null;
      if (!list) throw new Error("errorImportInvalid");
      list = list.map((r) => ({ ...r, id: undefined }));
      list = normalizeRules(list);
    } else {
      list = parseLegacyText(trimmed);
    }
    list = list.filter((r) => r.patterns.length);
    if (!list.length) throw new Error("errorImportEmpty");
    return list;
  }

  const api = {
    SCHEMA_VERSION,
    COLORS,
    MATCH_TYPES,
    MODES,
    LIMITS,
    DEFAULT_RULES,
    DEFAULT_SETTINGS,
    newId,
    normalizeRule,
    normalizeRules,
    normalizeSettings,
    ruleTitle,
    nextColor,
    colorForText,
    makeRule,
    parseSitePattern,
    compilePattern,
    compileRule,
    compileEnabled,
    findMatch,
    siteFromUrl,
    baseDomain,
    findSiteRule,
    parseLegacyText,
    exportRules,
    parseImport,
  };

  root.GTURules = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
