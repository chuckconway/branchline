export interface Commit {
  sha: string
  parents: string[]
  author: string
  email: string
  /** Author time, unix seconds. */
  time: number
  subject: string
  isStash?: boolean
}

export type RefKind = 'head' | 'remote' | 'tag'

export interface Ref {
  /** Full name, e.g. refs/heads/feature/x */
  name: string
  /** Display name, e.g. feature/x, origin/feature/x, v1.2 */
  short: string
  kind: RefKind
  /** Commit the ref points at (annotated tags are peeled). */
  sha: string
  /** Remote name, for remote-tracking refs. */
  remote?: string
  upstream?: string
  ahead?: number
  behind?: number
  /** Upstream is configured but no longer exists. */
  gone?: boolean
  /** Checked out in the worktree being viewed. */
  isHead?: boolean
  /** Path of the worktree that has this branch checked out, if any. */
  worktreePath?: string
  /** The branch its remote treats as the default (what origin/HEAD points at). */
  isDefault?: boolean
}

export interface Stash {
  index: number
  /** stash@{n} */
  ref: string
  sha: string
  message: string
  time: number
}

export interface Worktree {
  path: string
  sha: string
  branch?: string
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
  isCurrent: boolean
  /** The repository's original working tree, which git never removes. */
  isMain: boolean
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

export interface FileChange {
  path: string
  oldPath?: string
  status: FileStatus
  added?: number
  deleted?: number
  binary?: boolean
  /** Revisions to diff between for this file, when it is part of a commit. */
  range?: [from: string, to: string]
}

export type Operation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

export interface Status {
  /** Current branch, or null when HEAD is detached. */
  branch: string | null
  /** null in a repository with no commits yet. */
  headSha: string | null
  upstream?: string
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  conflicted: FileChange[]
  /** An operation git is in the middle of, if any. */
  operation?: Operation
}

export interface Snapshot {
  repoPath: string
  name: string
  /** null means "unchanged since the commitsKey you already have". */
  commits: Commit[] | null
  commitsKey: string
  /** Changes whenever anything other than the commit list changes. */
  stateKey: string
  hasMore: boolean
  refs: Ref[]
  stashes: Stash[]
  worktrees: Worktree[]
  remotes: string[]
  remoteWeb: RemoteWeb | null
  status: Status
}

export interface CommitDetail {
  sha: string
  parents: string[]
  author: string
  email: string
  authorDate: string
  committer: string
  committerEmail: string
  commitDate: string
  message: string
  files: FileChange[]
}

export type DiffSpec =
  | { kind: 'range'; from: string; to: string; path: string; oldPath?: string }
  | { kind: 'unstaged'; path: string; oldPath?: string; untracked?: boolean }
  | { kind: 'staged'; path: string; oldPath?: string }

export type Action =
  | { type: 'fetch' }
  | { type: 'pull' }
  | { type: 'push' }
  | { type: 'checkout'; branch: string }
  | { type: 'checkoutRemote'; remoteBranch: string }
  | { type: 'checkoutDetached'; sha: string }
  | { type: 'createBranch'; name: string; at?: string; checkout: boolean }
  | { type: 'stash'; message?: string }
  | { type: 'stashPop'; index: number }
  | { type: 'stage'; paths: string[] }
  | { type: 'unstage'; paths: string[] }
  | { type: 'stageAll' }
  | { type: 'unstageAll' }
  | { type: 'commit'; message: string }
  | { type: 'cherryPick'; sha: string }
  | { type: 'revert'; sha: string }
  | { type: 'rebaseOnto'; sha: string }
  | { type: 'reset'; sha: string; mode: ResetMode }
  | { type: 'reword'; sha: string; message: string }
  | { type: 'drop'; sha: string }
  | { type: 'move'; sha: string; direction: 'up' | 'down' }
  | { type: 'createWorktree'; sha: string; path: string; branch?: string }
  /** `remoteBranch`, e.g. origin/x, must be the same-named branch on a remote; it is deleted too. */
  | { type: 'deleteBranch'; branch: string; remoteBranch?: string }
  | { type: 'deleteRemoteBranch'; remoteBranch: string }
  | { type: 'createTag'; name: string; sha: string; message?: string; push?: boolean }
  | { type: 'removeWorktree'; path: string; deleteBranch?: boolean }
  | { type: 'pruneWorktrees' }

export type ResetMode = 'soft' | 'mixed' | 'hard'

/** Where a remote's commits can be viewed in a browser. */
export interface RemoteWeb {
  remote: string
  /** e.g. https://github.com/owner/repo */
  base: string
  /** Path between the base and a commit id, e.g. /commit/ */
  commitPath: string
}

export interface BlameCommit {
  author: string
  time: number
  summary: string
}

export interface Blame {
  /** Keyed by full SHA. The all-zero SHA marks lines that are not committed yet. */
  commits: Record<string, BlameCommit>
  lines: { sha: string; text: string }[]
}

export interface FileHistoryEntry {
  commit: Commit
  /** The file as that commit changed it, with the revisions to diff between. */
  change: FileChange
}

export interface AppState {
  tabs: string[]
  active: string | null
  recents: string[]
}

export type OpenResult = { ok: true; path: string; state: AppState } | { ok: false; error: string }

export interface Api {
  getState(): Promise<AppState>
  pickRepo(): Promise<OpenResult | null>
  openRepo(path: string): Promise<OpenResult>
  closeRepo(path: string): Promise<AppState>
  setActive(path: string | null): Promise<void>
  forgetRecent(path: string): Promise<AppState>
  snapshot(repo: string, limit: number, knownCommitsKey: string | null): Promise<Snapshot>
  commitDetail(repo: string, sha: string, isStash: boolean): Promise<CommitDetail>
  diff(repo: string, spec: DiffSpec): Promise<string>
  action(repo: string, action: Action): Promise<string>
  /** Is this commit already on the current branch's upstream? */
  isPublished(repo: string, sha: string): Promise<boolean>
  /** How many commits are reachable only from these refs, and so leave with them. */
  uniqueCommits(repo: string, refNames: string[]): Promise<number>
  /** Uncommitted changes in each linked worktree, keyed by its path. */
  worktreeChanges(repo: string): Promise<Record<string, number>>
  blame(repo: string, rev: string | null, path: string): Promise<Blame>
  fileHistory(repo: string, rev: string | null, path: string): Promise<FileHistoryEntry[]>
  /** Ask where to save, then write the commit as a patch. Resolves to the path, or null if cancelled. */
  savePatch(repo: string, sha: string): Promise<string | null>
  /** Ask for a location for a new folder. Resolves to the path, or null if cancelled. */
  pickNewFolder(defaultPath: string): Promise<string | null>
  getZoom(): Promise<number>
  /** Make everything larger (1) or smaller (-1), or return to normal size (0). Resolves to the new factor. */
  stepZoom(direction: 1 | -1 | 0): Promise<number>
  onZoomChanged(cb: (factor: number) => void): () => void
  showInFinder(path: string): Promise<void>
  copyText(text: string): Promise<void>
  /** Filesystem path of a file or folder dropped onto the window. */
  pathForFile(file: File): string
  onRepoChanged(cb: (repo: string) => void): () => void
  onStateChanged(cb: (state: AppState) => void): () => void
}

/** Sentinel SHA for the synthetic "uncommitted changes" row. */
export const WIP = 'WIP'
