/*
 * Group Tabs by URL — tiny i18n helpers for the extension pages.
 *
 * In HTML, mark text with attributes and call GTUi18n.apply():
 *   data-i18n="key"              → textContent
 *   data-i18n-placeholder="key"  → placeholder
 *   data-i18n-title="key"        → title
 *   data-i18n-aria-label="key"   → aria-label
 */
(function (root) {
  "use strict";

  function t(key, substitutions) {
    const subs = substitutions == null ? undefined : [].concat(substitutions).map(String);
    return browser.i18n.getMessage(key, subs) || key;
  }

  /** Plural helper: uses `key_one` for 1 and `key_other` otherwise. */
  function tn(key, count, extra = []) {
    return t(count === 1 ? key + "_one" : key + "_other", [String(count), ...extra]);
  }

  function apply(scope = document) {
    for (const el of scope.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const el of scope.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of scope.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
    for (const el of scope.querySelectorAll("[data-i18n-aria-label]")) el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
    if (scope === document) {
      document.documentElement.lang = browser.i18n.getUILanguage();
      document.documentElement.dir = browser.i18n.getMessage("@@bidi_dir") || "ltr";
    }
  }

  root.GTUi18n = { t, tn, apply };
})(globalThis);
