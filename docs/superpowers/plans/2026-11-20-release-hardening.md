# Branchline Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take Branchline from "works on the author's Mac" to an open-source release: correct on macOS and Linux, Windows wired up for CI to judge, signed downloadable builds, and a tag-driven release pipeline.

**Architecture:** Branchline is an Electron app (main process shells out to the system `git`; a sandboxed React renderer talks to it over a typed `window.api` bridge). This plan removes macOS-only assumptions from the main process and UI, adds a "git is unusable" state, defines packaging for three platforms in `package.json`, and adds GitHub Actions for tests and releases.

**Tech Stack:** Electron 45, electron-vite 6, electron-builder 26, React 19, TypeScript 7, Vitest 5, Playwright-core (drives the built app in `tests/smoke.mjs`), GitHub Actions.

---

## Read this first

**Where things stand.** The repository is at `~/Projects/branchline`. Work happens on branch `release-prep`. Two commits exist:

- `65a7fe8` the whole app, renamed to Branchline, MIT licensed (on `main` and `release-prep`).
- `cb7fa8b` (only on `release-prep`) git discovery is per-platform, git 2.31+ is required, the rebase "editor" no longer uses `cp`, and the empty tree no longer needs `/dev/null`.
- `62c0b35` (only on `release-prep`) tests for that commit. Task 1 is therefore already done.

**Rules from the owner. These override defaults.**

- Do not create a GitHub repository, push, or publish anything. Stop and ask when a task reaches that point.
- Commit after each task, on `release-prep`. End every commit message with `Co-Authored-By:` for the model doing the work.
- The owner does not use keyboard shortcuts: every feature needs a visible, clickable control.
- "Done" means verified in the running app, not just typechecked. Say plainly what was not verified.
- A check that passes proves nothing until you have seen it fail on a broken input. Where a task says "control", do it.
- Never run anything that writes to the owner's other repositories. Tests build their own scratch repository.
- The shell cannot prompt for `sudo` or for interactive logins. Hand those commands to the owner.

**How to run things.**

```bash
npm run typecheck                 # tsc --noEmit; silent on success
npm test                          # vitest; expect "Tests  96 passed" at the start of this plan
npm run build && npm run smoke    # builds, then drives the real app; opens a window for ~1 min
```

`npm run smoke` prints one `ok  …` line per check and ends with `All checks passed`. On failure it saves `tests/.artifacts/shots/failure.png`; read that image. Screenshots of each stage are in the same folder.

Environment variables the app and tests understand: `BRANCHLINE_USER_DATA` (settings folder, so tests never touch real settings), `BRANCHLINE_OPEN` (a repository to open at launch), `SMOKE_APP` (path to a packaged binary to test instead of `out/`), `SMOKE_REPO` (an extra real repository to open read-only), `BRANCHLINE_REAL_REPOS` (colon-separated paths for `tests/real.test.ts`).

**Facts already established. Do not re-derive.**

- Docker is installed here (Linux, aarch64), so Linux can be verified locally.
- This Mac has a `Developer ID Application` certificate and `notarytool`. Notarization still needs credentials only the owner can create.
- All dependencies are permissively licensed. No personal details are in tracked files.
- Git on Windows prints paths with forward slashes, and runs editors and hooks through its own bundled `sh`.
- Branchline is installed at `/Applications/Branchline.app` and running, with settings in `~/Library/Application Support/Branchline/`. Task 8 installs the new build over it.

**File map.**

| File | Responsibility | Tasks |
|---|---|---|
| `src/main/git/exec.ts` | Find and run git | 3 |
| `src/main/git/repo.ts` | Repository queries and actions | (done) |
| `src/main/index.ts` | Window, menu, IPC | 2 |
| `src/preload/index.ts`, `src/shared/types.ts` | The `window.api` bridge | 2 |
| `src/renderer/src/App.tsx`, `main.tsx`, `styles.css`, `format.ts`, `menus.tsx` | UI | 3 |
| `tests/smoke.mjs` | End-to-end test | 3, 4 |
| `package.json` | Packaging config and scripts | 5 |
| `.github/workflows/ci.yml`, `release.yml` (new) | CI and releases | 6 |
| `README.md`, `CONTRIBUTING.md` (new), `docs/images/` (new), `docs/design.md` | Docs | 7 |

---

### Task 1: Tests for the platform-neutral git layer — DONE

Already committed as `62c0b35`: `tests/exec.test.ts` (version parsing, minimum version, a usable git is found) and a test in `tests/operations.test.ts` that a reworded message is kept verbatim, including lines starting with `#`. The control was run: without `commit.cleanup=whitespace` that test fails. Nothing to do here; start at Task 2.

---

### Task 2: Main process without macOS assumptions

**Files:**
- Modify: `src/main/index.ts`, `src/preload/index.ts`, `src/shared/types.ts`

- [ ] **Step 1: Extend the bridge types**

In `src/shared/types.ts`, inside `interface Api`, add after `getState(): Promise<AppState>`:

```ts
  /** 'darwin', 'win32' or 'linux'. */
  platform: string
  /** Whether git can be run at all, so the app can say so before anything is opened. */
  gitInfo(): Promise<{ ok: true; version: string } | { ok: false; error: string }>
```

In `src/preload/index.ts`, add to the `api` object after `getState`:

```ts
  platform: process.platform,
  gitInfo: () => call('app:gitInfo'),
```

- [ ] **Step 2: Make `requireRepo` resolve on demand**

A tab restored while git could not run has no `RepoInfo` yet. In `src/main/index.ts` replace the whole `requireRepo` function with:

```ts
async function requireRepo(path: unknown): Promise<RepoInfo> {
  if (typeof path !== 'string' || !store.data.tabs.includes(path)) throw new Error('That repository is not open.')
  let repo = repos.get(path)
  if (!repo) {
    // A tab restored while git could not run: resolve it now that someone is asking.
    repo = await resolveRepo(path)
    register(repo)
  }
  return repo
}
```

Every call site is inside `registerIpc`. Change each `requireRepo(repo)` to `await requireRepo(repo)` and make that handler's arrow function `async`. For example:

```ts
  handle('repo:diff', async (repo: string, spec: DiffSpec) => diff(await requireRepo(repo), spec))
```

Run `grep -n "requireRepo(" src/main/index.ts` afterwards: every match except the function definition must be preceded by `await`.

- [ ] **Step 3: Keep tabs when git is the problem**

Add to the imports at the top of `src/main/index.ts`:

```ts
import { GitUnavailableError, gitInfo } from './git/exec'
```

In `restoreTabs`, replace the `catch { … }` block with:

```ts
    } catch (e) {
      // git itself cannot run: keep the tab, it resolves on demand once git works again.
      // Otherwise the folder is gone or is no longer a repository; it stays in recents.
      if (e instanceof GitUnavailableError) kept.push(path)
    }
```

In `registerIpc`, add:

```ts
  handle('app:gitInfo', () => gitInfo())
```

- [ ] **Step 4: Platform-specific window and menu**

Near the top of `src/main/index.ts`, after the imports:

```ts
const isMac = process.platform === 'darwin'
```

In `createWindow`, replace the two lines `titleBarStyle: 'hiddenInset',` and `trafficLightPosition: { x: 14, y: 12 },` with:

```ts
    // Only macOS draws its window buttons over the page; elsewhere keep the native frame.
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 12 } } : {}),
```

In `buildMenu`, replace `{ role: 'appMenu' },` with `...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),` and, in the File submenu, replace `{ role: 'close' }` with `isMac ? { role: 'close' } : { role: 'quit' }`.

- [ ] **Step 5: Reveal with a native path**

Change the `node:path` import to `import { dirname, join, normalize } from 'node:path'`. In the `app:showInFinder` handler, change `shell.showItemInFolder(path)` to `shell.showItemInFolder(normalize(path))` (git gives forward slashes; Windows Explorer wants backslashes).

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test && npm run build && npm run smoke`
Expected: typecheck silent, `96 passed`, `All checks passed`.

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts src/preload/index.ts src/shared/types.ts
git commit -m "Remove macOS assumptions from the main process"
```

---

### Task 3: UI without macOS assumptions, and a "git is unusable" banner

**Files:**
- Modify: `src/main/git/exec.ts`, `src/renderer/src/main.tsx`, `App.tsx`, `styles.css`, `format.ts`, `menus.tsx`, `tests/smoke.mjs`

- [ ] **Step 1: Let a specific git be chosen (also the test hook)**

In `src/main/git/exec.ts` replace the line `const CANDIDATES = isMac ? ['git', CLT_GIT] : ['git']` with:

```ts
// BRANCHLINE_GIT names one git to use, for people with several installed and for tests.
const CANDIDATES = process.env.BRANCHLINE_GIT ? [process.env.BRANCHLINE_GIT] : isMac ? ['git', CLT_GIT] : ['git']
```

- [ ] **Step 2: Tell the page which platform it is on**

In `src/renderer/src/main.tsx`, before the `createRoot(…)` line:

```ts
document.documentElement.dataset.platform = window.api.platform
```

- [ ] **Step 3: Platform-aware CSS**

In `src/renderer/src/styles.css`:

1. In the first `:root { … }` block replace the `--mono:` line with:

```css
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, 'Helvetica Neue', Arial, sans-serif;
  --mono: ui-monospace, 'SF Mono', Menlo, Consolas, 'Cascadia Mono', 'DejaVu Sans Mono', 'Liberation Mono', monospace;
```

2. In `body { … }` replace the `font:` line with `font: 12.5px/1.4 var(--sans);`.
3. Replace both occurrences of `font-family: -apple-system, BlinkMacSystemFont, sans-serif;` with `font-family: var(--sans);`.
4. In `.tabbar { … }` delete the lines `padding-left: 84px;` and `-webkit-app-region: drag;`, then add after that block:

```css
/* macOS draws its window buttons over the tab bar, which also serves as the title bar. */
:root[data-platform='darwin'] .tabbar {
  padding-left: 84px;
  -webkit-app-region: drag;
}
```

- [ ] **Step 4: Platform-aware menu label**

Append to `src/renderer/src/format.ts`:

```ts
/** What each platform calls "show this in the file manager". */
export function revealLabel(platform: string): string {
  return platform === 'darwin' ? 'Reveal in Finder' : platform === 'win32' ? 'Show in Explorer' : 'Show in file manager'
}
```

In `src/renderer/src/menus.tsx`, add `revealLabel` to the `./format` import and replace both `label: 'Reveal in Finder'` with `label: revealLabel(window.api.platform)`.

- [ ] **Step 5: The banner**

In `src/renderer/src/App.tsx`, next to the other `useState` calls in `App`:

```tsx
  const [gitProblem, setGitProblem] = useState<string | null>(null)
  const checkGit = useCallback(() => void window.api.gitInfo().then((info) => setGitProblem(info.ok ? null : info.error)), [])
  useEffect(checkGit, [checkGit])
```

Immediately after the closing `</div>` of `<div className="tabbar">`:

```tsx
      {gitProblem && (
        <div className="notice error" role="alert" data-git-problem>
          <pre>{gitProblem}</pre>
          <button className="btn small" onClick={checkGit}>
            Check again
          </button>
        </div>
      )}
```

- [ ] **Step 6: Smoke checks for the banner**

In `tests/smoke.mjs`:

1. Change `const launch = () =>` to `const launch = (extra = {}) =>` and its env line to `env: { ...appEnv, BRANCHLINE_USER_DATA: join(artifacts, 'userdata'), BRANCHLINE_OPEN: repo, ...extra }`.
2. Change the `args` in `launch` to add `--no-sandbox` when asked (needed in containers and CI): replace `{ args: [root] }` with `{ args: [root, ...(process.env.SMOKE_NO_SANDBOX ? ['--no-sandbox'] : [])] }` and `{ executablePath: process.env.SMOKE_APP, args: [] }` with `{ executablePath: process.env.SMOKE_APP, args: process.env.SMOKE_NO_SANDBOX ? ['--no-sandbox'] : [] }`.
3. Near the top, after `const gitIn = …`, add:

```js
const reveal = process.platform === 'darwin' ? 'Reveal in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Show in file manager'
```

and replace `item('Reveal in Finder')` with `item(reveal)`.
4. Add `chmodSync` to the `node:fs` import. After the final check (`'clicking the percentage returns to normal size'`), add:

```js
  // --- git missing or too old: say so, and keep the tabs for when it is fixed
  await app.close()
  app = await launch({ BRANCHLINE_GIT: join(artifacts, 'no-such-git') })
  const noGit = await app.firstWindow()
  await noGit.waitForSelector('[data-git-problem]')
  check((await noGit.locator('[data-git-problem]').textContent()).includes('git was not found'), 'a missing git is reported in plain words')
  check((await noGit.locator('.tab').count()) === 1, 'and the open tab is kept')

  const oldGit = join(artifacts, 'old-git')
  writeFileSync(oldGit, '#!/bin/sh\necho "git version 2.20.1"\n')
  chmodSync(oldGit, 0o755)
  await app.close()
  app = await launch({ BRANCHLINE_GIT: oldGit })
  const tooOld = await app.firstWindow()
  await tooOld.waitForSelector('[data-git-problem]')
  check((await tooOld.locator('[data-git-problem]').textContent()).includes('needs git 2.31 or newer'), 'a git that is too old is reported with the version needed')

  await app.close()
  app = await launch()
  const healthy = await app.firstWindow()
  await healthy.locator('.row[data-sha]').first().waitFor()
  check((await healthy.locator('[data-git-problem]').count()) === 0, 'with a working git there is no warning and the tab loads')
```

(The shell-script fake git is POSIX-only. When Task 6 runs this on Windows, guard the "too old" block with `if (process.platform !== 'win32')`.)

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test && npm run build && npm run smoke`
Expected: `All checks passed`, including the four new lines. Read `tests/.artifacts/shots/01-graph-wip.png` and confirm the macOS layout is unchanged (tab bar still clears the window buttons).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Platform-aware UI, and a banner when git cannot be used"
```

---

### Task 4: Verify on Linux in Docker

Nothing has run on Linux yet. Expect surprises here and fix what you find; each fix gets its own commit.

**Files:** whatever the run shows needs fixing.

- [ ] **Step 1: Export the tree and run the unit tests**

`node_modules` holds macOS binaries, so the container gets a clean copy.

```bash
mkdir -p /tmp/branchline-linux && git archive HEAD | tar -x -C /tmp/branchline-linux
docker run --rm -v /tmp/branchline-linux:/work -w /work node:24-bookworm bash -lc '
  git --version &&
  git config --global user.name CI && git config --global user.email ci@example.com &&
  npm ci 2>&1 | tail -2 && npm run typecheck && npm test 2>&1 | tail -15'
```

Expected: git ≥ 2.31 (bookworm ships 2.39) and all unit tests pass. If a test fails, read it: a path or locale assumption is the likely cause. Fix in `src/` or the test, commit, re-export, rerun.

- [ ] **Step 2: Run the app under a virtual display**

```bash
docker run --rm -v /tmp/branchline-linux:/work -w /work node:24-bookworm bash -lc '
  apt-get update -qq && apt-get install -y -qq xvfb >/dev/null &&
  npx --yes playwright-core install-deps chromium >/dev/null 2>&1 ;
  npm ci 2>&1 | tail -1 && npx install-electron && npm run build 2>&1 | tail -2 &&
  SMOKE_NO_SANDBOX=1 xvfb-run -a node tests/smoke.mjs 2>&1 | tail -40'
```

If Electron fails to start on a missing shared library, install the package it names with `apt-get` and note it for the README. Copy the screenshots out (`/tmp/branchline-linux/tests/.artifacts/shots/`) and read `01-graph-wip.png`: the tab bar must start at the left edge (no 84px gap) and text must render in a real font.

Known differences to accept rather than fight: the "Create patch" check stubs a native dialog and should work; the fake old-git script works on Linux; fonts differ.

- [ ] **Step 3: Record the outcome**

Expected end state: `All checks passed` on Linux. If a check cannot pass for a reason specific to containers (not to Linux), skip only that check under an explicit `process.env.SMOKE_NO_SANDBOX` guard with a comment saying why, and say so in the final report.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "Fix <what> on Linux"
```

---

### Task 5: Packaging for macOS, Linux and Windows

**Files:**
- Modify: `package.json`, `README.md` (the build command), `.gitignore` (already ignores `release`)

- [ ] **Step 1: Confirm the config keys for the installed electron-builder**

Do not trust memory for these. Run:

```bash
node -e "const s=require('./node_modules/app-builder-lib/scheme.json');const m=s.definitions.MacConfiguration.properties;console.log('notarize' in m, 'hardenedRuntime' in m, 'electronFuses' in s.properties)"
```

If `electronFuses` is `false`, skip the fuses block in Step 2 and say so in the final report.

- [ ] **Step 2: Replace the `scripts.dist` entry and the `build` block in `package.json`**

Scripts (replace `dist`, add `dist:local`):

```json
    "dist": "electron-vite build && electron-builder",
    "dist:local": "electron-vite build && electron-builder --mac dir --arm64 -c.mac.identity=null -c.mac.notarize=false && codesign --force --deep --sign - release/mac-arm64/Branchline.app"
```

Build block:

```json
  "build": {
    "appId": "app.branchline.desktop",
    "productName": "Branchline",
    "artifactName": "${productName}-${version}-${os}-${arch}.${ext}",
    "files": ["out/**/*", "package.json"],
    "directories": { "output": "release" },
    "electronFuses": {
      "runAsNode": false,
      "enableNodeOptionsEnvironmentVariable": false,
      "onlyLoadAppFromAsar": true
    },
    "mac": {
      "category": "public.app-category.developer-tools",
      "icon": "build/icon.icns",
      "hardenedRuntime": true,
      "notarize": true,
      "target": [
        { "target": "dmg", "arch": ["arm64", "x64"] },
        { "target": "zip", "arch": ["arm64", "x64"] }
      ],
      "extendInfo": {
        "CFBundleDocumentTypes": [
          { "CFBundleTypeName": "Folder", "CFBundleTypeRole": "Viewer", "LSHandlerRank": "Alternate", "LSItemContentTypes": ["public.folder"] }
        ]
      }
    },
    "linux": {
      "category": "Development",
      "icon": "build/icon.png",
      "target": [{ "target": "AppImage", "arch": ["x64", "arm64"] }]
    },
    "win": {
      "icon": "build/icon.png",
      "target": [{ "target": "nsis", "arch": ["x64"] }]
    },
    "nsis": { "oneClick": false, "perMachine": false }
  },
```

Notes that explain choices: the "inspect arguments" fuse is deliberately left on, because `tests/smoke.mjs` attaches to the packaged app through it. A `.deb` target is left out because it requires a maintainer email and homepage, which do not exist until the owner picks where the project lives.

- [ ] **Step 3: Local unsigned build still works and still passes**

```bash
rm -rf release && npm run dist:local
SMOKE_APP="$PWD/release/mac-arm64/Branchline.app/Contents/MacOS/Branchline" npm run smoke
```

Expected: `All checks passed`. This also proves the fuses did not break the app (the history-edit checks exercise the rebase editor).

- [ ] **Step 4: Signed build with the Developer ID certificate**

```bash
rm -rf release && npx electron-vite build && npx electron-builder --mac dmg --arm64 -c.mac.notarize=false
codesign -dv --verbose=2 release/mac-arm64/Branchline.app 2>&1 | grep -E "Authority|TeamIdentifier"
```

Expected: `Authority=Developer ID Application: …`. macOS may show a keychain permission dialog on the owner's screen; if the command waits more than two minutes, stop, and tell the owner a keychain prompt needs answering. Do not retry in a loop.

- [ ] **Step 5: Hand notarization to the owner**

Notarization uploads the app to Apple and needs credentials. Do not attempt it. Put this in the final report for the owner to run once:

```
xcrun notarytool store-credentials branchline-notary --apple-id <their Apple ID> --team-id <their team id>
APPLE_KEYCHAIN_PROFILE=branchline-notary npm run dist -- --mac
spctl -a -vv release/mac-arm64/Branchline.app     # expect: accepted, source=Notarized Developer ID
```

- [ ] **Step 6: Linux package builds in Docker**

```bash
docker run --rm -v /tmp/branchline-linux:/work -w /work node:24-bookworm bash -lc '
  npm ci 2>&1 | tail -1 && npx install-electron && npx electron-vite build 2>&1 | tail -1 &&
  npx electron-builder --linux AppImage --arm64 2>&1 | tail -5 && ls -la release/*.AppImage'
```

(Re-export the tree first so the container has the new `package.json`.) Expected: one `.AppImage` listed. Running it is not required here; Task 6's CI smoke covers Linux runtime.

- [ ] **Step 7: Update the README build line and commit**

In `README.md` change `npm run dist                       # builds release/mac-arm64/Branchline.app` to `npm run dist:local                 # builds release/mac-arm64/Branchline.app (unsigned)`.

```bash
git add -A && git commit -m "Package for macOS, Linux and Windows"
```

---

### Task 6: CI and release workflows

These cannot run until the repository is on GitHub. Lint them locally and say clearly in the final report that they are unexecuted.

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

- [ ] **Step 1: `ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  test:
    name: Test (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    # Windows is not supported yet; its results are information, not a gate.
    continue-on-error: ${{ matrix.os == 'windows-latest' }}
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, ubuntu-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npx install-electron
      - run: git config --global user.name CI && git config --global user.email ci@example.com
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - name: Smoke test (Linux)
        if: runner.os == 'Linux'
        run: xvfb-run -a npm run smoke
        env:
          SMOKE_NO_SANDBOX: '1'
      - name: Smoke test (macOS, Windows)
        if: runner.os != 'Linux'
        run: npm run smoke
      - name: Keep screenshots when something fails
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: screenshots-${{ matrix.os }}
          path: tests/.artifacts/shots
```

- [ ] **Step 2: `release.yml`**

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  build:
    name: Build (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            args: --mac
          - os: ubuntu-latest
            args: --linux
          - os: windows-latest
            args: --win
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npx install-electron
      - run: npx electron-vite build
      - name: Package
        run: npx electron-builder ${{ matrix.args }} --publish never
        env:
          # macOS signing and notarization. Without these secrets the Mac build is unsigned.
          CSC_LINK: ${{ secrets.MAC_CERTIFICATE_P12_BASE64 }}
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CERTIFICATE_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
      - uses: actions/upload-artifact@v4
        with:
          name: packages-${{ matrix.os }}
          path: |
            release/*.dmg
            release/*.zip
            release/*.AppImage
            release/*.exe
          if-no-files-found: error

  publish:
    name: Draft release
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: packages
          merge-multiple: true
      - name: Create a draft release with every package attached
        run: gh release create "$GITHUB_REF_NAME" packages/* --repo "$GITHUB_REPOSITORY" --draft --generate-notes --title "Branchline $GITHUB_REF_NAME"
        env:
          GH_TOKEN: ${{ github.token }}
```

The release is a **draft** on purpose: a person looks at it and presses Publish.

- [ ] **Step 3: Check the action versions and lint**

Action major versions move. For each of `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`, check the current major (`gh api repos/actions/checkout/releases/latest --jq .tag_name`, which is a read of public data) and update the `@vN` if it is newer. Then:

```bash
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest -color
```

Expected: no output and exit code 0. Control: temporarily change `runs-on:` to `runs-onn:` in `ci.yml`, rerun, expect an error, then restore.

- [ ] **Step 4: Commit**

```bash
git add .github && git commit -m "Add CI and a tag-driven draft release workflow"
```

---

### Task 7: User-facing README and contributor notes

**Files:**
- Modify: `README.md` (rewrite), `docs/design.md` (add a section)
- Create: `CONTRIBUTING.md`, `docs/images/graph.png`, `diff.png`, `blame.png`, `menu.png`

- [ ] **Step 1: Screenshots**

Run `npm run build && npm run smoke`, then copy from `tests/.artifacts/shots/`: the file ending `-graph-wip.png` → `docs/images/graph.png`, `-diff-split.png` → `diff.png`, `-blame.png` → `blame.png`, `-commit-menu.png` → `menu.png`. Read each to confirm it shows what its name says. They show the scripted test repository (invented names), so they are safe to publish.

- [ ] **Step 2: Rewrite `README.md` for someone deciding whether to install**

Keep the existing "Develop" and "Layout" sections (move the development commands into `CONTRIBUTING.md`, leaving a one-line pointer). The new top of the file, in this order:

1. `# Branchline` and one sentence: a local git graph viewer and history tool; no account, no subscription, no telemetry.
2. `![The commit graph](docs/images/graph.png)`
3. **Install**: macOS (download the `.dmg` for Apple Silicon or Intel from Releases), Linux (the `.AppImage`; `chmod +x` then run), Windows ("not supported yet; builds are experimental"). Requires git 2.31 or newer. Leave the Releases link as plain text `Releases page` until the repository URL exists, and list "add the Releases URL" in the final report.
4. **What it does**: the existing feature list, with `diff.png`, `blame.png` and `menu.png` placed beside the features they show.
5. **What it will and will not do to your repository**: the existing "all or nothing" and "ask before losing anything" paragraphs, the branch-delete and worktree rules, and the list of things it never does (discard file changes, force-push, delete tags).
6. **Built for watching agents work**: the view refreshes on its own, reads never take git's index lock, worktrees show uncommitted counts.
7. **Open from a terminal**: `open -a Branchline /path/to/repo` (macOS), or pass a folder as the first argument.
8. **License**: MIT.

Write it in plain sentences. No marketing adjectives.

- [ ] **Step 3: `CONTRIBUTING.md`**

Contents: prerequisites (Node 24, git 2.31+); `npm install` then `npx install-electron`; the three commands from "How to run things" above with what each proves; the environment variables table; the rule that a change touching git behaviour needs a unit test in `tests/` and a UI change needs a line in `tests/smoke.mjs`; and the two product rules contributors must keep (all-or-nothing operations, confirm before anything is lost).

- [ ] **Step 4: Design notes**

Append to `docs/design.md`, before `## Errors`, a section `## Platforms` stating: git is found per platform and must be 2.31+; the rebase editor is a shell-builtin function because git runs editors through a shell everywhere; the page learns its platform from `window.api.platform` and CSS keys off `data-platform`; Windows is built but unsupported until CI passes there.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Write the README for users; add contributor notes"
```

---

### Task 8: Install the new build on this machine

The owner is running the installed copy. Settings live in `~/Library/Application Support/Branchline/` and are left alone.

- [ ] **Step 1: Build**

```bash
rm -rf release && npm run dist:local
```

- [ ] **Step 2: Swap**

```bash
osascript -e 'tell application id "app.branchline.desktop" to quit'; sleep 2
ditto release/mac-arm64/Branchline.app /Applications/Branchline.app
codesign --verify --deep /Applications/Branchline.app && echo "signature ok"
```

- [ ] **Step 3: Verify the installed copy, then launch it**

```bash
SMOKE_APP=/Applications/Branchline.app/Contents/MacOS/Branchline npm run smoke
rm -rf release
open /Applications/Branchline.app; sleep 4
pgrep -fl "/Applications/Branchline.app/Contents/MacOS/Branchline"
python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/Library/Application Support/Branchline/state.json'))); print('tabs:', len(d['tabs']))"
```

Expected: `All checks passed`, a running process, and the same number of tabs the owner had open before. Delete `release/` before launching: macOS otherwise may open that copy instead of the installed one.

---

### Task 9: Final verification and report

- [ ] **Step 1: Everything, once more**

```bash
npm run typecheck && npm test && npm run build && npm run smoke
git status --short        # expect nothing
git log --oneline main..release-prep
```

- [ ] **Step 2: Report to the owner.** Lead with what is done and verified. Then list, plainly:

- What was verified on Linux, and how (Docker), and anything skipped there.
- That Windows is untested and the workflows are linted but have never run.
- The decisions and steps that are theirs:
  1. Where the repository lives (account or organisation), and the go-ahead to create it and push. Then the README Releases link and a `.deb` target can be added.
  2. The notarization commands from Task 5 Step 5, and the five repository secrets `release.yml` reads.
  3. The bundle id (now `com.cconway.branchline`). Settings live under the product name, not the id, but macOS permissions, the Windows taskbar identity and the installer's upgrade key all follow the id, so it must not change after the first public release.
  4. The LICENSE names the owner.
  5. Whether to merge `release-prep` into `main`.
- Not in this plan: in-app update checks, a Homebrew cask, a real Windows port.
