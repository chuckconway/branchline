# Contributing to Branchline

## Prerequisites

- Node 24
- git 2.31 or newer

```sh
npm install
npx install-electron      # fetches the Electron binary if the install step did not
```

On Linux, Electron also needs GTK 3 (`libgtk-3-0` on Debian and Ubuntu). To run the smoke
test without a display, install `xvfb` and run it as
`SMOKE_NO_SANDBOX=1 SMOKE_NO_GPU=1 xvfb-run -a npm run smoke`. `SMOKE_NO_GPU` turns off the GPU,
which fails to start on virtual displays with no GPU device, such as GitHub's runners.

## Running things

```sh
npm run dev                       # run with hot reload
npm run typecheck                 # tsc --noEmit; silent on success
npm test                          # vitest
npm run build && npm run smoke    # builds, then drives the real app; opens a window for ~1 min
```

What each one proves:

- `npm run typecheck`: the main process, the preload bridge and the UI agree on their types.
  It says nothing about behaviour.
- `npm test`: git output is parsed correctly, the graph lanes are laid out correctly, and
  every action does what it claims to a repository. The tests build their own scratch
  repository and never touch any other.
- `npm run smoke`: the built app works end to end. It launches Electron on a scripted
  repository, clicks through the real UI, prints one `ok  …` line per check, and ends with
  `All checks passed`. Screenshots of each stage are saved in `tests/.artifacts/shots`; on a
  failure, read `failure.png` there.

To package the app for the machine you are on:

```sh
npm run dist:local                # macOS: builds release/mac-arm64/Branchline.app (unsigned)
npm run dist                      # signed packages for the current platform, into release/
```

## Environment variables

| Variable | What it does |
|---|---|
| `BRANCHLINE_USER_DATA` | Folder for settings, so tests never touch real settings. |
| `BRANCHLINE_OPEN` | A repository to open at launch. |
| `BRANCHLINE_GIT` | The one git to use, for machines with several installed and for tests. |
| `BRANCHLINE_REAL_REPOS` | Colon-separated repositories for `tests/real.test.ts` (read-only). |
| `SMOKE_APP` | Path to a packaged binary for the smoke test to drive instead of `out/`. |
| `SMOKE_REPO` | An extra real repository for the smoke test to open, read-only. |
| `SMOKE_NO_SANDBOX` | Launch with `--no-sandbox`; needed in containers and on CI under Linux. |

Two optional checks against real repositories, both read-only:

```sh
BRANCHLINE_REAL_REPOS=/path/a:/path/b npx vitest run tests/real.test.ts
SMOKE_REPO=/path/a npm run smoke
```

To smoke-test a packaged app:

```sh
SMOKE_APP="$PWD/release/mac-arm64/Branchline.app/Contents/MacOS/Branchline" npm run smoke
```

## Rules for changes

- A change that touches git behaviour needs a unit test in `tests/`.
- A change to the UI needs a line in `tests/smoke.mjs`.
- Before trusting a new check, break the thing it checks and watch it fail.
- Every feature needs a visible, clickable control. A keyboard shortcut is never the only way in.

Two product rules every change must keep:

- **All or nothing.** There is no conflict-resolution screen. An operation that cannot apply
  cleanly is aborted and the repository is left exactly as it was. An operation that something
  else started is never aborted on its behalf.
- **Confirm before anything is lost.** Anything that can discard commits or uncommitted work
  asks first, and says what will be lost.

The design notes are in `docs/design.md`.

## The website

`docs/` is the website, served by GitHub Pages from `main` at
https://chuckconway.github.io/branchline/. `docs/_config.yml` keeps the developer docs
(`design.md`, `superpowers/`) out of it. The download buttons link to
`releases/latest/download/<file>`, so package names carry no version number and the page needs
no change for a new release.

`npm run shots` rebuilds the app and regenerates the screenshots in `docs/images`, light and
dark, from the same scripted repository the smoke test uses. It needs a Retina display for the
2x images the site expects.
