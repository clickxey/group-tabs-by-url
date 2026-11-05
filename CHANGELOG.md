# Changelog

All notable changes to Group Tabs by URL. Versions follow [semantic versioning](https://semver.org); see [docs/RELEASING.md](docs/RELEASING.md).

## 1.1.1 — 2026-11-05

- The add-on's icon now shows in Firefox's add-ons manager (about:addons) instead of the generic puzzle piece.

## 1.1.0 — 2026-11-05

- **Group once, without a rule.** Type part of an address in the new box at the top of the popup (for example `rsna-knee`), see which tabs match, and group them. Your saved rules are ignored for that run and nothing is saved. Changed your mind? "Save as a rule" keeps it.
- **Group a whole site, subdomains included.** Right-clicking a tab on a subdomain such as `en.wikipedia.org` now also offers *Group all tabs from wikipedia.org and its subdomains* and *Add a rule for wikipedia.org and its subdomains*.

## 1.0.0 — first public release

- Rules that group matching tabs from every window into named, coloured tab groups, with one click or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>.
- Four match types: Website (a site and its subdomains, optionally narrowed by a path), Address contains, Address starts with, and Regular expression.
- Popup with a live count of matching tabs per rule and on/off switches; settings page with a visual rule editor.
- Group into the current window or inside each window; optional collapsing; pinned tabs and tabs already in your own groups can be left alone.
- Undo puts every tab back in its old window, position and group.
- Tab context menu: *Group all tabs from this site* and *Add a rule for this site*.
- Optional automatic grouping as you browse.
- Import and export of rules; light and dark themes; no data collection.
