# Releasing

Versions follow [semantic versioning](https://semver.org): **MAJOR.MINOR.PATCH**.

| Change | Bump | Example |
|---|---|---|
| Bug fix, wording, translation | PATCH | 1.1.0 → 1.1.1 |
| New feature that doesn't break anything | MINOR | 1.1.1 → 1.2.0 |
| Something users must adapt to (removed feature, changed rule format) | MAJOR | 1.2.0 → 2.0.0 |

addons.mozilla.org only accepts a version **higher** than the last one you uploaded, and never the same number twice.

## What the automation does

- **CI** (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`. It runs the tests, Mozilla's add-on linter, and makes a test build. To try a PR in Firefox, open the PR → **Checks** → **CI** → **Summary** → *Artifacts* → `group-tabs-by-url-test-build`. Unzip it and load the inner zip through `about:debugging`.
- **Release** (`.github/workflows/release.yml`) runs when you push a tag like `v1.2.0`. It checks that the tag, `extension/manifest.json`, `package.json` and `CHANGELOG.md` all agree. Then it runs the tests and linter, builds `group-tabs-by-url-1.2.0.zip`, and publishes a GitHub release with that zip attached and the changelog section as its notes.

## Making a release

1. **Prepare it on a branch.**
   ```sh
   git switch main && git pull
   git switch -c release/1.2.0
   npm run version:set -- 1.2.0
   ```
   This updates `extension/manifest.json` and `package.json`. Then add a section to the top of `CHANGELOG.md`:
   ```md
   ## 1.2.0 — 2026-12-01

   - What changed, in words a user understands.
   ```
   Check that everything agrees with `npm run version:check -- 1.2.0`.

2. **Open a pull request**, wait for CI to pass, and merge it.

3. **Tag the merged commit and push the tag.**
   ```sh
   git switch main && git pull
   git tag -a v1.2.0 -m "Version 1.2.0"
   git push origin v1.2.0
   ```
   You can also go to GitHub → **Releases** → **Draft a new release** → *Choose a tag* → type `v1.2.0` → *Create new tag on publish* (target `main`) → **Publish**. The workflow then attaches the zip to the release you created.

4. **Wait about a minute.** The release appears under **Releases** with the zip attached. If it doesn't, open the **Actions** tab to see which check failed. A version mismatch is the usual cause: fix it, delete the tag (`git push origin :refs/tags/v1.2.0` and `git tag -d v1.2.0`), and tag again.

5. **Upload the zip to addons.mozilla.org**: Developer Hub → your add-on → **Upload New Version**. Paste the same changelog lines into "Release notes".

## Tags for releases made before this automation

The workflow uses the files from the tagged commit, so a tag on a commit made before the workflow existed doesn't trigger it. For those releases (1.0.0), create the tag and the release by hand once:

```sh
git tag -a v1.0.0 <commit> -m "Version 1.0.0"
git push origin v1.0.0
```

Then go to GitHub → **Releases** → **Draft a new release** → choose `v1.0.0`, paste its notes, attach the zip you uploaded to addons.mozilla.org, and publish.
