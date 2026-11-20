# Branchline

A local git graph viewer for macOS. No account, no subscription, no network calls other than
your own `git fetch`, `pull` and `push`.

It is built for looking at a repository that something else (you, or a coding agent) is
changing: the view refreshes on its own when commits, branches, stashes or working files
change, and it never takes git's index lock while it reads.

## What it does

- Commit graph with lanes, branch and tag labels, stashes, and a row for uncommitted changes.
- Sidebar of local branches, remotes, worktrees, stashes and tags, with a filter.
- Commit details and per-file diffs, unified or side by side, with syntax colouring.
- File history (following renames) and blame for any changed file.
- Stage, unstage and commit; fetch, pull (fast-forward only), push or publish; check out a
  branch or commit; create a branch; stash and pop.
- Right-click a commit (or use the More button) to cherry-pick, revert, rebase onto it, reset
  to it, edit its message, drop it, move it, create a worktree from it, copy its SHA or its
  link on the remote, save it as a patch, or tag it (optionally annotated, optionally pushed).
- Right-click a branch, in the sidebar or on its label in the graph, to check it out, copy
  its name, or delete it locally, on the remote, or both.
- One tab per repository. A linked worktree opens as its own tab.
- Text size: the controls at the right of the tab bar zoom the whole window from 80% to 200%,
  and the level is remembered. Columns and button labels give way as space runs out.
- Worktrees show how many uncommitted changes each holds. Right-click one to open it, reveal
  it in Finder, copy its path, or remove it (with its branch, if you ask). Worktrees whose
  folder has gone are flagged, and one click prunes them.

Two rules shape the operations that change history:

- **All or nothing.** There is no conflict-resolution screen. A cherry-pick, revert, rebase,
  drop or move that cannot apply cleanly is aborted, and the repository is left exactly as it
  was. An operation that something else started is never aborted on its behalf.
- **Ask before losing anything.** Reset, drop, rebase and delete confirm first. A hard reset
  says how many uncommitted files it will discard, editing a commit that is already pushed
  warns that the branch will need a force-push (which this app does not do), and deleting a
  branch says how many commits exist on no other branch or tag.

Deleting a branch never follows its upstream: "also delete on the remote" means the remote
branch of the same name, so a branch cut from `dev` cannot take `origin/dev` with it. The
checked-out branch, a branch held by another worktree, and a remote's default branch cannot
be deleted from here.

A worktree is only ever removed when it is clean; there is no force option. A worktree whose
folder is gone still holds its branch until it is pruned, which is why pruning is what makes
those branches deletable.

Still deliberately missing: discarding file changes, force-push, deleting tags.

## Use

```sh
npm install
npm run dist:local                 # builds release/mac-arm64/Branchline.app (unsigned)
open -a "Branchline" /path/to/repo
```

Opening works from the Open button, by dropping a folder on the window or the Dock icon, or
from a terminal with `open -a` as above.

## Develop

```sh
npm run dev        # run with hot reload
npm test           # unit tests: git parsing, graph layout, every action (uses a scripted repo)
npm run build && npm run smoke     # drives the real app end to end, saves screenshots
```

Two optional checks against real repositories, both read-only:

```sh
BRANCHLINE_REAL_REPOS=/path/a:/path/b npx vitest run tests/real.test.ts
SMOKE_REPO=/path/a npm run smoke
```

To smoke-test the packaged app instead of the dev build, set
`SMOKE_APP="release/mac-arm64/Branchline.app/Contents/MacOS/Branchline"`.

## Layout

```
src/shared/    types, graph lane layout, diff and git-output parsers (pure)
src/main/      git execution, repository queries and actions, file watcher, window
src/preload/   the typed bridge exposed to the UI as window.api
src/renderer/  React UI
tests/         unit tests, fixture-repository builder, end-to-end smoke test
```

The design notes are in `docs/design.md`.
