// Small helpers for releasing. No dependencies.
//
//   node scripts/release-tools.mjs set-version 1.2.0    update manifest.json + package.json
//   node scripts/release-tools.mjs check-version 1.2.0  fail unless both files and CHANGELOG.md agree
//   node scripts/release-tools.mjs notes 1.2.0          print that version's CHANGELOG section
//
// `npm run version:set -- 1.2.0` is a shortcut for the first one.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  manifest: path.join(root, "extension", "manifest.json"),
  package: path.join(root, "package.json"),
  changelog: path.join(root, "CHANGELOG.md"),
};

const [command, rawVersion] = process.argv.slice(2);
const version = (rawVersion || "").replace(/^v/, "");

function fail(message) {
  console.error("✖ " + message);
  process.exit(1);
}

// Firefox accepts 1–4 dot-separated numbers; we use plain x.y.z.
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Expected a version like 1.2.0, got "${rawVersion ?? ""}".`);

const readVersion = (file) => JSON.parse(readFileSync(file, "utf8")).version;

/** Replace the top-level "version" value without reformatting the file. */
function writeVersion(file) {
  const text = readFileSync(file, "utf8");
  const updated = text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
  if (updated === text && readVersion(file) !== version) fail(`Couldn't find "version" in ${path.relative(root, file)}.`);
  writeFileSync(file, updated);
}

/** The body of "## <version>" in CHANGELOG.md, up to the next "## " heading. */
function changelogSection() {
  const lines = readFileSync(files.changelog, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+v?${version.replace(/\./g, "\\.")}(\\s|$)`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

switch (command) {
  case "set-version":
    writeVersion(files.manifest);
    writeVersion(files.package);
    console.log(`✔ Version set to ${version} in extension/manifest.json and package.json.`);
    if (changelogSection() === null) console.log(`  Next: add a "## ${version}" section to CHANGELOG.md.`);
    break;

  case "check-version": {
    const problems = [];
    const m = readVersion(files.manifest);
    const p = readVersion(files.package);
    if (m !== version) problems.push(`extension/manifest.json says ${m}`);
    if (p !== version) problems.push(`package.json says ${p}`);
    const notes = changelogSection();
    if (notes === null) problems.push(`CHANGELOG.md has no "## ${version}" section`);
    else if (!notes) problems.push(`the "## ${version}" section of CHANGELOG.md is empty`);
    if (problems.length) fail(`Version ${version} doesn't match: ${problems.join("; ")}.\n  Fix with: npm run version:set -- ${version}  (and update CHANGELOG.md)`);
    console.log(`✔ manifest.json, package.json and CHANGELOG.md all say ${version}.`);
    break;
  }

  case "notes": {
    const notes = changelogSection();
    if (!notes) fail(`No notes for ${version} in CHANGELOG.md.`);
    process.stdout.write(notes + "\n");
    break;
  }

  default:
    fail(`Unknown command "${command ?? ""}". Use set-version, check-version or notes.`);
}
