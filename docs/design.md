# Branchline — design

## Original intent

A local desktop git viewer with the ease of use of GitKraken's graph UI, without the
subscription and without the features that go unused (issue tracking, PR review, cloud
accounts). Coding agents do the day-to-day git work; this app is for looking at what they
did.

## Non-goals

- Issue trackers, PR review, hosting-provider integrations, accounts, telemetry, any network
  call other than the user's own `git fetch/pull/push`.
- Discarding file changes, force-push, tag delete.
- Merge-conflict resolution UI and a full interactive-rebase editor.
- Windows/Linux packaging. macOS arm64 only for now.

## Stack

Electron + React + TypeScript, built with electron-vite. All git access shells out to the
system `git` binary; no libgit2. Read commands run with `GIT_OPTIONAL_LOCKS=0` so the viewer
never takes `index.lock` out from under an agent that is committing.

## Layout

```
src/shared/   types, graph lane layout, diff parser, git output parsers   (pure, unit-tested)
src/main/     git exec, repo queries + actions, .git watcher, persisted state, IPC, window
src/preload/  typed `window.api` bridge
src/renderer/ React UI
tests/        vitest unit tests + fixture-repo builder; Playwright-driven Electron smoke test
```

The renderer never touches the filesystem or spawns processes. Everything goes through
`window.api`, and every IPC handler validates that its `repoPath` is an opened repository.

## UI

- **Tab bar:** one tab per open repository, `+` opens a picker with recent repositories.
- **Toolbar:** Fetch, Pull, Push, Branch, Stash, Pop, Refresh, search box, theme toggle.
- **Left sidebar:** Local branches (folder tree on `/`), Remotes, Tags, Stashes, Worktrees.
  Filter box. Click jumps the graph to that ref; double-click checks out a local branch.
- **Center graph:** virtualized rows — ref pills, lane graph, message, author, date, short SHA.
  Top row is the uncommitted-changes (WIP) node when the tree is dirty. Stashes appear as
  nodes.
- **Right panel:** for a commit — message, author/committer, parents, changed files with
  +/- counts. For WIP — unstaged and staged lists with stage/unstage, message box, Commit.
- **Diff view:** replaces the graph when a file is clicked. Unified or split, syntax
  highlighted, previous/next file buttons, close returns to the graph.

Every action has a visible, clickable control. No feature is reachable only by keyboard chord.

## Data flow

`loadSnapshot(repo, limit)` returns commits, refs, HEAD, status, stashes and worktrees in one
round trip. The renderer runs the lane layout over the commit list and renders visible rows
only. Commit details and patches are fetched on selection.

A watcher on the repo's git directory (debounced) plus a light status poll while the window
is focused pushes `repo:changed`; the renderer reloads the snapshot and keeps the selection.

## Lane layout

Single pass over commits in `--date-order`. `lanes[i]` holds the SHA that lane is waiting
for. A commit takes the leftmost lane waiting for it (or the first free lane if it is a tip);
other lanes waiting for it merge in and free up. Its first parent inherits the lane; other
parents join an existing lane waiting for them or open a new one. Lanes never shift sideways,
so pass-through edges are straight verticals and each row can be drawn independently.

## Commit and file menus (added after v1)

Right-clicking a commit offers checkout, create worktree, create branch, cherry-pick, rebase
onto, reset (soft/mixed/hard), revert, edit message, drop, move up/down, copy SHA, copy link
on the remote, and create patch. Right-clicking a changed file offers diff, file history,
blame, stage/unstage, copy path and reveal in Finder. Every menu is also reachable from a
visible button (More on the commit panel, the row's "…" button, tabs on the file view).

- **All or nothing.** With no conflict UI, an operation that stops midway is aborted
  (`allOrNothing` in `src/main/git/repo.ts`), so it either applies cleanly or changes nothing.
  It refuses to start while another operation is in progress, and so never aborts one it did
  not start.
- **History edits** (edit message, drop, move) run `git rebase -i` with a prepared to-do list:
  the sequence "editor" is `cp <prepared file>`. They are limited to the straight-line stretch
  from HEAD back to its most recent merge, which the renderer computes as `linear`.
- **Confirmation.** Reset, drop and rebase always confirm. Edit message and move confirm only
  when the commit is already on the upstream, where they would force a force-push.

## Branch menus and tags (added after v1)

Right-clicking a branch (sidebar row, or its label in the graph) offers checkout, copy name
and delete. The commit menu gained "Create tag here…": a message makes the tag annotated, and
a checkbox pushes it.

- **Delete always confirms**, and the dialog reports `uniqueCommits`: commits reachable from
  the doomed refs and from no other branch, remote branch, tag or HEAD. Because the dialog has
  said what is lost, the delete uses `git branch -D` rather than git's narrower merged check.
- **"Also delete on the remote" means the same-named remote branch**, never the upstream;
  the backend rejects any other pairing. Remote deletion runs first, so a network failure
  leaves the local branch in place.
- **Refused:** the checked-out branch, a branch held by another worktree, and the branch a
  remote's `HEAD` points at (`Ref.isDefault`).

## Worktree actions (added after v1)

Right-clicking a worktree offers open in a tab, reveal in Finder, copy path and remove; the
section shows a Prune control whenever a worktree's folder is missing.

- **Remove is never forced.** The backend counts the worktree's uncommitted changes and
  refuses if there are any, then runs plain `git worktree remove`. The main working tree, the
  one being viewed and locked ones are refused. "Also delete its branch" reuses
  `uniqueCommits` to say what that would orphan.
- **Change counts are kept out of the snapshot.** Each costs a `git status` in another
  folder, so `worktreeChanges` is a separate call the sidebar makes only while the Worktrees
  section is open and visible: every ten seconds, on focus, and when a ref moves.
- **A tab on a worktree that disappears is closed**, since it could only show an error.

## Text size (added after v1)

Text size is window zoom (`webContents.setZoomFactor`), stepped through the levels in
`src/shared/zoom.ts`, saved in `state.json` and re-applied on every page load. macOS offers no
system text-size setting an Electron app can follow, and zoom keeps the graph's fixed row
geometry in proportion with its text. The tab-bar control and the View menu items both go
through `changeZoom` in the main process; the built-in zoom menu roles are not used because
they bypass the saved setting.

Zooming in makes the window narrower in CSS pixels, so the layout adapts by width: side
panels are capped as a share of the window, toolbar buttons drop their labels, and the graph
drops its SHA, author and date columns in that order (container queries on `.graph-pane`).

## Errors

Git failures surface as a dismissible banner carrying git's own stderr. An action that fails
leaves the view on the last good snapshot. A repository that disappears shows an empty state
on its tab rather than closing it.

## Verification

- Unit tests: parsers and lane layout against a scripted fixture repository (branches, a
  merge, tags, a stash, a linked worktree, dirty tree, a rename).
- Smoke test: Playwright launches the built Electron app on the fixture repository, exercises
  select/diff/stage/commit/checkout, and saves screenshots.
- Manual read-only pass against large real repositories for performance.
