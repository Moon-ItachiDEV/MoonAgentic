import { z } from "zod";

export type { PairedDevice, RemoteAccess, RemoteAddress } from "./remote.ts";
export {
  type AppInfo,
  type AppKind,
  type AppUpdate,
  MAX_UPDATE_NOTES,
  UPDATE_EVERY_MS,
  type UpdateNote,
} from "./app-update.ts";
import type { AppInfo } from "./app-update.ts";
export { type Notice, noticesFor, settledTags, waitingTag } from "./notices.ts";
export {
  limitsModel,
  MAX_FALLBACK_MODELS,
  type ProjectQuotaRules,
  spentUntil,
  type ThreadQuota,
  tightest,
} from "./quota.ts";
import { MAX_FALLBACK_MODELS, type ProjectQuotaRules, type ThreadQuota } from "./quota.ts";
export {
  defaultTeam,
  pickMember,
  presetMembers,
  suggestedPresets,
  TEAM_ROLES,
  teamPresets,
} from "./team-presets.ts";
export {
  applyRulings,
  applyVotes,
  REVIEW_JUDGE,
  verdictOf,
  normalPath,
  REVIEW_SEVERITIES,
  REVIEW_SLOTS,
  reviewAtWork,
  severityOf,
  slotReviewer,
  synthesize,
  type PrReview,
  type PrReviewer,
  type PrReviewPhase,
  type ReviewFinding,
  type ReviewNote,
  type ReviewPoint,
  type ReviewSeverity,
  type ReviewSlot,
  type ReviewVerdict,
  type ReviewVote,
  type ReviewRuling,
  type PrJudge,
} from "./pr-review.ts";
import { reviewAtWork, type PrReview } from "./pr-review.ts";

// Zod builds faster checks with `new Function` when it can, and tries it as soon as a
// schema is made. The web app's content security policy forbids that, so it is turned off
// before any schema exists; messages here are small enough not to need it.
z.config({ jitless: true });

export type AgentId = string;

export interface ModelChoice {
  id: string;
  name: string;
  description?: string;
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  /** Two-letter badge shown in the UI, e.g. "CC". */
  short: string;
  available: boolean;
  /** Why the agent cannot run, shown to the user when `available` is false. */
  hint?: string;
  /** Models the agent offered the last time one of its sessions started; absent until then. */
  models?: ModelChoice[];
  /** The model a new thread gets when the user picks none. */
  defaultModel?: string;
  /** Why the agent could not list its models, while it has none on record. */
  modelsError?: string;
  /** Other settings the agent offers, such as its mode (plan, agent…) or reasoning effort. */
  settings?: AgentSetting[];
  /** Settings observed for specific models, when choices (such as reasoning effort) vary by model. */
  modelSettings?: Record<string, AgentSetting[]>;
  /** The `/` commands the agent listed the last time one of its sessions started. */
  commands?: AgentCommand[];
  /** The program that starts it, once found on this machine. */
  command?: string;
  /** How to sign in with the agent's own tool, outside MoonAgentic. */
  login?: string;
  /** Added by the user in Connexions rather than built in. */
  custom?: boolean;
  /** What the last check found: the agent answered and opened a session, or why not. */
  check?: AgentCheck;
  /** The moon that stands for the agent while it works, when it has one. */
  mascot?: Mascot;
  /** Hermes and the user's own Hermes bots: the only agents that can have a moon. */
  mascotAllowed?: true;
}

/** The moon's outline: a crescent, a cratered full moon or a smooth orb. */
export const MASCOT_SHAPES = ["crescent", "full", "orb"] as const;
/** The moon's tint and the sky behind it. */
export const MASCOT_COLORS = ["ice", "violet", "pink", "mint", "amber", "silver"] as const;

export interface Mascot {
  shape: (typeof MASCOT_SHAPES)[number];
  color: (typeof MASCOT_COLORS)[number];
}

/** Mascots agents have until the user picks another one, or none. */
export const DEFAULT_MASCOTS: Readonly<Record<AgentId, Mascot>> = {
  hermes: { shape: "crescent", color: "ice" },
};

export interface AgentCheck {
  at: number;
  ok: boolean;
  /** The agent's own name and version, as it gave them when it started. */
  version?: string;
  /** True when the agent said it needs the user to sign in first. */
  signInNeeded?: boolean;
  error?: string;
}

/** An ACP agent the user added: a command that speaks ACP on its standard input and output. */
export interface CustomAgentInput {
  name: string;
  command: string;
  args: string[];
}

/** A permission request waiting for an answer, in any thread. */
export interface PendingRequest {
  threadId: string;
  itemId: string;
  title: string;
  options: PermissionOption[];
  at: number;
}

/** A `/` command the agent offers, sent to it as the start of a message. */
export interface AgentCommand {
  name: string;
  description: string;
  /** What to type after the command, when it takes some input. */
  hint?: string;
}

/** A skill: a method written in a `SKILL.md` that the agent loads when it is called with `$`. */
export interface Skill {
  name: string;
  description: string;
  /** Where it was found: in the project, or in the user's own folder. */
  scope: "project" | "user";
  /** Its `SKILL.md`, relative to the project for a project skill, from the home folder otherwise. */
  path: string;
}

/** The agents a skill is given to, each by the folder it reads skills from. */
export const SKILL_AGENTS = ["claude", "codex", "antigravity", "hermes"] as const;
export type SkillAgent = (typeof SKILL_AGENTS)[number];

/** Where an installed skill came from, when MoonAgentic installed it. */
export type SkillSource =
  | { kind: "github"; repo: string; path: string; ref?: string }
  | { kind: "command"; command: string }
  | { kind: "app" };

/**
 * A skill in the folders agents read: the user's own (every project) or one project's. One
 * entry per name, whichever agents' folders hold a copy of it.
 */
export interface InstalledSkill {
  name: string;
  description: string;
  /** In the home folder (every project), or in one project's folder. */
  projectId?: string;
  /** The agents that read it: those whose folder holds a copy. */
  agents: SkillAgent[];
  /** Its folders, relative to the home folder or the project (absolute for Hermes). */
  paths: string[];
  /** Files in its folder (its `SKILL.md` and what comes with it). */
  files: number;
  source?: SkillSource;
  installedAt?: number;
}

/** A skill found in a GitHub repository, before it is installed. */
export interface FoundSkill {
  name: string;
  description: string;
  /** Its folder in the repository; empty for a skill at the repository's root. */
  path: string;
}

/** A command that installs skills, as it will run: where, and the npm package it starts. */
export interface SkillCommandPlan {
  command: string;
  dir: string;
  /** The package `npx` starts, read from npm: shown before it runs. */
  npm?: { name: string; version?: string };
}

/** How a command that installs skills ended: what it added and what else it changed. */
export interface SkillRunEnd {
  code: number | null;
  /** Skills that were not there before it ran. */
  added: string[];
  /** Other files it changed among those agents read (settings, hooks…), relative to `dir`. */
  changed: string[];
  error?: string;
}

/** A `/` command written for the project, in `.moonagentic/commands/<name>.md`. */
export interface ProjectCommand {
  name: string;
  description: string;
  /** The message it stands for; `$ARGUMENTS` takes what follows the command. */
  template: string;
}

/** A message that matched a quick search. */
export interface SearchHit {
  threadId: string;
  itemId: string;
  kind: "user" | "agent";
  /** The text around the match. */
  snippet: string;
}

/** A setting an agent offers for its sessions, other than the model. */
export interface AgentSetting {
  /** The agent's own id for the setting. */
  id: string;
  kind: "mode" | "effort";
  choices: ModelChoice[];
  /** What the agent picks on its own for a new session. */
  current: string;
}

/** Settings the agent offers for `model`, falling back to its general settings when unobserved. */
export function agentSettingsFor(
  agent: Pick<AgentInfo, "settings" | "modelSettings"> | undefined,
  model: string | undefined,
): AgentSetting[] {
  if (!agent) return [];
  if (model && agent.modelSettings && Object.hasOwn(agent.modelSettings, model)) {
    return agent.modelSettings[model]!;
  }
  return agent.settings ?? [];
}

/** How much of the agent's context window the conversation fills, as the agent reports it. */
export interface ContextUsage {
  used: number;
  size: number;
  /** What the session has cost so far, when the agent says. */
  cost?: { amount: number; currency: string };
}

/**
 * An MCP server handed to agent sessions. Secret values (environment variables, HTTP
 * headers) stay on the server; clients only see their names.
 */
export interface McpServerInfo {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  /** stdio: the command line that starts the server. http: its URL. */
  target: string;
  /** Names of the environment variables (stdio) or headers (http) it is given. */
  secretNames: string[];
  /** The projects whose threads get it: every project when left out, none when empty. */
  projectIds?: string[];
  /**
   * Given to a team's reviewers, testers and mergers too. Left out, only the agents that
   * write the code get it: a thread's own agent, a coordinator, a team's lead and coders.
   */
  allRoles?: boolean;
  /** The agents whose threads get it: every agent when left out, none when empty. */
  agentIds?: string[];
}

/** A tool an MCP server offers, as it lists it. */
export interface McpTool {
  name: string;
  description?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  /** True when the folder is in a git repository, so threads can get their own branch. */
  git?: boolean;
  /** Kept at the top of the list of projects. */
  pinned?: boolean;
  /** Put away: out of the lists and the pickers, its threads kept as they are. */
  archived?: boolean;
  /**
   * Locked with /lock: nothing of it is sent, its threads, cards, plans and requests, until
   * the code is given. Its agents keep working.
   */
  locked?: boolean;
  /** Shown in place of the folder: an emoji or one or two letters, set in its settings. */
  icon?: string;
  /** The tint of its icon, among {@link PROJECT_COLORS}. */
  color?: ProjectColor;
  /** What its threads do when a model's quota runs out; nothing while unset. */
  quota?: ProjectQuotaRules;
  /**
   * False when a thread's branch is kept once its pull request is merged: by default
   * MoonAgentic deletes it then, in the project's repository only (« Supprimer après la fusion »).
   */
  deleteMerged?: false;
}

/** The tints a project's icon can take; the web app gives each its shade in both themes. */
export const PROJECT_COLORS = [
  "moon",
  "sky",
  "mint",
  "sun",
  "coral",
  "rose",
  "violet",
  "slate",
] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];
/** At most this many characters for a project's icon: an emoji with its modifiers fits. */
export const MAX_PROJECT_ICON = 16;
/** At most this many files in one answer to `files.search`. */
export const MAX_FILE_RESULTS = 5000;
/** At most this many bytes for a setup file edited from the app (AGENTS.md, a skill…). */
export const MAX_SETUP_FILE = 256 * 1024;
/** At most this many bytes for a project's shared memory notes (injected on fresh sessions). */
export const MAX_PROJECT_MEMORY = 16 * 1024;

/** A skill kept in the project, with its text, for its settings. */
export interface ProjectSkill {
  name: string;
  description: string;
  /** Its `SKILL.md`, relative to the project. */
  path: string;
  /** What follows its front matter. */
  body: string;
}

/**
 * What a project gives its agents, read from its folder and MoonAgentic for its settings:
 * the shared instructions (`AGENTS.md`), whether Claude Code reads them too, its shared
 * memory notes, its commands and skills.
 */
export interface ProjectSetup {
  /** `AGENTS.md` at the project's root; empty while there is none. */
  rules: {
    text: string;
    exists: boolean;
    /** Over {@link MAX_SETUP_FILE}: shown nowhere and not written from the app. */
    tooBig?: true;
  };
  /**
   * `CLAUDE.md`, which Claude Code reads in place of `AGENTS.md`: missing, importing
   * `AGENTS.md` (or a link to it), or a separate file.
   */
  claude: "missing" | "imports" | "separate";
  /**
   * Durable notes shared across every agent and every worktree of the project, kept in
   * MoonAgentic rather than in git. Empty while nothing has been noted yet.
   */
  memory: {
    text: string;
    updatedAt?: number;
  };
  commands: ProjectCommand[];
  skills: ProjectSkill[];
  /**
   * Those of these files git sees as changed and not yet committed, in a git project: a
   * thread on its own branch starts from the last commit, so it does not see them yet.
   */
  uncommitted?: string[];
}

/** A thread's own branch, checked out in a separate folder (a git worktree). */
export interface Workspace {
  branch: string;
  path: string;
  /** The commit the branch started from, once the worktree exists. */
  base?: string;
  /** The branch it started from, which a pull request targets. */
  baseBranch?: string;
  /**
   * Where the project sits inside the repository (`apps/web`), when it is not at its root:
   * the agent works in that folder of the worktree.
   */
  subdir?: string;
  /**
   * While the thread is archived, or its folder could only be removed in part: the files it
   * had, uncommitted ones included, as a tree. They come back when its folder is made again.
   */
  archivedTree?: string;
  /** The pull request, or the page to open one, after the last push. */
  prUrl?: string;
  prOpened?: boolean;
}

/** One changed file in a thread's workspace, compared with where its branch started. */
export interface ReviewFile {
  path: string;
  /** The path before a rename. */
  from?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** Line counts; null for a binary file. */
  added: number | null;
  removed: number | null;
  /** The unified diff hunks, from the first `@@` line. */
  patch: string;
  truncated?: boolean;
}

export type ThreadStatus = "idle" | "running" | "waiting" | "error";

export type PermissionMode = "supervised" | "full";

/** `reviewer2`: a second review of each piece, beside the first; `judge`: weighs the reviews. */
export type TeamRole = "lead" | "coder" | "reviewer" | "reviewer2" | "judge" | "tester" | "merger";

/** What one lane of a team's timeline is doing: the lead's, a piece's, or the merge's. */
export type TeamLanePhase =
  TeamTask["status"] | "planning" | "idle" | "merging" | "solving" | "checking";

/** A change in one lane of the team, when it happened: the timeline is drawn from them. */
export interface TeamEvent {
  at: number;
  /** -1 for the lead, -2 for the merge, else the piece's index. */
  lane: number;
  phase: TeamLanePhase;
}

/** One agent and model of a team, by role. */
export interface TeamMember {
  agentId: AgentId;
  model?: string;
}

/**
 * Where a team is: `merging` while its pieces are merged onto one branch, `blocked` once
 * nothing runs and a piece or the merge waits on the user.
 */
export type TeamPhase =
  "planning" | "coding" | "merging" | "blocked" | "done" | "failed" | "stopped";

/** A piece of the team's work, given by the lead to one coder. */
export interface TeamTask {
  title: string;
  brief: string;
  /**
   * `running` while its coder works, `reviewing` and `testing` while the reviewer and the
   * tester check it, `lead` while the lead rewrites its brief, `blocked` once it is the
   * user's turn.
   */
  status:
    | "waiting"
    | "running"
    | "reviewing"
    | "testing"
    | "judging"
    | "lead"
    | "blocked"
    | "done"
    | "failed"
    | "stopped";
  /** The coder's own thread, once it has started. */
  threadId?: string;
  reviewThreadId?: string;
  /** The second reviewer's and the judge's threads, for a team that has them. */
  review2ThreadId?: string;
  judgeThreadId?: string;
  testThreadId?: string;
  /** The verdicts of this round of reviews, kept until every reviewer has given its own. */
  verdicts?: { reviewer?: "ok" | "fix"; reviewer2?: "ok" | "fix" };
  /** True once the second reviewer was asked again for the verdict it left out. */
  reasked2?: boolean;
  /** Corrections sent back to the coder so far. */
  tries?: number;
  /** True once the lead has rewritten the brief, which it does once. */
  leadHelped?: boolean;
  /** True once the reviewer or tester was asked again for the verdict it left out. */
  reasked?: boolean;
  /** The last remarks of the reviewer or the tester, or why the piece is blocked. */
  note?: string;
  /** True once its branch is merged onto the team's. */
  merged?: boolean;
}

/**
 * A mission the user adds while the team works: the lead reads it, then puts it in its plan
 * as new pieces (`added` of them; none when the plan already covers it).
 */
export interface TeamMission {
  text: string;
  at: number;
  status: "waiting" | "reading" | "planned" | "failed" | "stopped";
  added?: number;
  /** Why it could not be put in the plan. */
  note?: string;
}

/** What a team, run from its lead's thread, is doing. The server keeps it. */
export interface Team {
  phase: TeamPhase;
  /** The task as the user gave it. */
  task: string;
  coder: TeamMember;
  /** Reads each piece's changes before it counts as done. */
  reviewer?: TeamMember;
  /** Reads them too, at the same time, for a second view. */
  reviewer2?: TeamMember;
  /** Weighs the reviews and says what is really to be corrected. */
  judge?: TeamMember;
  /** Runs the tests, and writes the missing ones, on each piece's branch. */
  tester?: TeamMember;
  /** Settles merge conflicts, then checks the pieces work together. */
  merger?: TeamMember;
  /** The thread whose branch gets every piece, once they are all done. */
  mergeThreadId?: string;
  /**
   * Once done, the team pushes its branch and opens its pull request by itself: `url` is
   * the pull request, or the page to open one when the user's `gh` could not.
   */
  shipped?: { url?: string; opened: boolean; note?: string };
  /** Why the branch could not be pushed or its pull request opened. */
  shipError?: string;
  /** The branch is being pushed and the pull request opened, right now. */
  shipping?: true;
  /** Set to false at the start when the user opens the pull request themselves. */
  autoShip?: boolean;
  /** What the merger is at: the piece whose conflicts it settles, or -1 for the last check. */
  mergeStep?: number;
  /** True once the merger was asked again for the verdict its last check left out. */
  mergeReasked?: boolean;
  /** Every change of each lane, oldest first, as it really happened. */
  timeline?: TeamEvent[];
  /** Coders working at once. */
  coders: number;
  permissionMode: PermissionMode;
  tasks: TeamTask[];
  /** Times the lead was asked again for a plan it could not be read from. */
  planTries?: number;
  /** The piece whose brief the lead is rewriting, one at a time. */
  leadTask?: number;
  /** Missions the user added while the team works, oldest first. */
  missions?: TeamMission[];
  /** The mission the lead is reading, one at a time, after the briefs it rewrites. */
  leadMission?: number;
  error?: string;
}

/** An agent's turn with no sign of progress for this long is said to be quiet. */
export const AGENT_QUIET_MS = 10 * 60_000;
/** An agent's turn with no sign of progress for this long is stopped. */
export const AGENT_SILENCE_STOP_MS = 30 * 60_000;

/**
 * The first line of a thread's error when its agent's process went away in the middle of a
 * turn (shut down, crashed, connection lost). What it did so far stays in the thread, which
 * « Reprendre » takes up again with a new agent session.
 */
export const AGENT_STOPPED = "L'agent s'est arrêté avant la fin de sa réponse.";
/** What « Reprendre » asks the agent, after a stop. */
/**
 * What a coordinator's brief to a thread is followed by when the user's own words are joined
 * to it: the agent gets both, the thread shows only the brief.
 */
export const ORIGIN_MARK =
  "\n\n---\nMessage d'origine de l'utilisateur, transmis tel quel par MoonAgentic :\n\n";
/** The roles of a team (chef, coders, review, tests, merge) and of a review (reviewers, judge). */
export const ROLE_JOBS = ["chef", "code", "relit", "tests", "fusion", "rev", "arb"] as const;
export type RoleJob = (typeof ROLE_JOBS)[number];
/** The shapes a role's mascot takes. */
export const ROLE_PHASES = ["crescent", "full", "star", "planet", "chef"] as const;
/** The tints a role's mascot takes. */
export const ROLE_COLORS = [
  "moon",
  "blue",
  "orange",
  "emerald",
  "violet",
  "rose",
  "gold",
  "crimson",
  "silver",
] as const;
export interface RoleMascot {
  phase: (typeof ROLE_PHASES)[number];
  color: (typeof ROLE_COLORS)[number];
}
export type RoleMascots = Partial<Record<RoleJob, RoleMascot>>;

/** Starts how the agent of a coordinator's thread is asked to answer: for it, not shown. */
export const REPLY_MARK = "\n\n---\nComment répondre, consigne de MoonAgentic :\n\n";
/** The language a fenced block of an answer is marked with to be shown as a review card. */
export const VERDICT_FENCE = "moon-revue";
/** The part of a coordinator's message the thread shows: its brief, without what is for the agent. */
export const briefOf = (text: string): string => {
  const at = [text.indexOf(REPLY_MARK), text.indexOf(ORIGIN_MARK)].filter((i) => i >= 0);
  return at.length ? text.slice(0, Math.min(...at)) : text;
};
export const RESUME_TEXT = "Tu as été interrompu : reprends là où tu t'es arrêté.";

/** True for a thread error that says its agent stopped, as said now or by an older server. */
export const agentStopped = (error: string | undefined): boolean =>
  !!error && (error.startsWith(AGENT_STOPPED) || /^ACP connection closed\b/i.test(error));

/** How many turns a goal gets when none is said, and at most. */
export const GOAL_TURNS = 10;
export const MAX_GOAL_TURNS = 50;
/** The turns a goal gets once more when it is taken up again after its last one. */
export const GOAL_MORE_TURNS = 5;

/**
 * Where a goal stands. `active`: the agent's turns follow one another until it is reached.
 * `paused`: by the user, a stop, a failed turn or a restart; nothing goes until it is taken
 * up again. `reached` and `blocked`: the agent said so. `exhausted`: its turns are spent.
 */
export type GoalState = "active" | "paused" | "reached" | "blocked" | "exhausted";

/**
 * What the user asked a thread's agent to reach, over as many turns as it takes, up to a
 * number the server keeps. The agent says when it is reached, or blocked.
 */
/** How many times MoonAgentic sends the agent to fix its pull request by itself, at most. */
export const PR_WATCH_TRIES = 3;

/**
 * « Corriger tout seul », on a thread whose branch has a pull request: when its checks fail
 * or it conflicts with its base, the agent is told, fixes it, and MoonAgentic pushes the fix.
 * At most `max` times, then it is the user's again. Present while it is on.
 */
export interface PrWatch {
  /** Fixes asked for so far. */
  tries: number;
  max: number;
  /** What was last acted on, such as `ci:<commit>`: never twice for the same. */
  handled?: string;
  /** What the last fix was for. */
  last?: "ci" | "conflict";
  /** True once `max` fixes did not make it pass: nothing more is tried. */
  exhausted?: true;
  /** Why the last fix could not be pushed, when it could not. */
  error?: string;
}

export interface ThreadGoal {
  text: string;
  state: GoalState;
  /** The goal's turns sent so far, the first included. */
  turns: number;
  maxTurns: number;
  /** Why it is paused or blocked, in words for the user. */
  reason?: string;
  startedAt: number;
  /** When it was reached, blocked or spent. */
  endedAt?: number;
}

/** How many messages a thread keeps waiting at most. */
export const MAX_QUEUED_MESSAGES = 20;

/**
 * A message written while the thread's agent was at work, by the user or by the project's
 * coordinator. It waits its turn, can be changed or taken out meanwhile, and goes by itself
 * once the turn before it is over.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  /** Left by the project's coordinator, or sent by the user through Hermes on Discord. */
  from?: "coordinator" | "hermes";
  /** When it was written. */
  at: number;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  agentId: AgentId;
  status: ThreadStatus;
  permissionMode: PermissionMode;
  /** The model the agent runs, once known. */
  model?: string;
  /** The value of each of the agent's other settings, by setting id. */
  settings?: Record<string, string>;
  /** Hidden when the agent does not report it. */
  usage?: ContextUsage;
  /** True when the agent offers a /compact command to shrink its context. */
  canCompact?: boolean;
  /** The `/` commands this thread's agent offers, as it last listed them. */
  commands?: AgentCommand[];
  /**
   * In a snapshot only, in place of `commands`: its place in the snapshot's `commandLists`.
   * Each thread of an agent holds the same list: sent once, the state of 3 000 threads went
   * from 10 MB to 1 MB (N7). `unpackSnapshot` puts it back.
   */
  commandList?: number;
  /** Kept at the top of the sidebar. */
  pinned?: boolean;
  /**
   * Resolved (« Résolu »): out of the lists of work under way, its worktree removed until
   * it is reopened. Its files, uncommitted ones included, are kept in git meanwhile.
   */
  archived?: boolean;
  /** Its pull request as GitHub last described it, once one is known. */
  pr?: ThreadPullRequest;
  /** The start of what its agent last said, for lists of threads. */
  summary?: string;
  /** Set when the thread works on its own branch rather than in the project folder. */
  workspace?: Workspace;
  /**
   * A project's coordinator: the one conversation the user talks to about the whole
   * project. It answers, or opens a thread for the work. Kept out of lists of threads.
   */
  kind?: "coordinator";
  /**
   * Its agent answered while no window had it open, or the user marked it so: shown until
   * it is opened.
   */
  unread?: boolean;
  /**
   * While its agent works: since when (ms) it has given no sign of progress, once that has
   * lasted long enough to say so. Past a longer silence the turn is stopped.
   */
  quietSince?: number;
  /**
   * Its turn waits for a place: the server already runs as many turns as it may. It starts
   * by itself once one ends.
   */
  inLine?: true;
  /** The coordinator's thread, for a thread it opened. */
  openedBy?: string;
  /** The coordinator's own name for the subject: asked again, it gets this thread back. */
  taskKey?: string;
  /**
   * The brief it gets once a place is free: its coordinator already has as many threads
   * at work as it may run at once, so this one waits in line.
   */
  held?: string;
  /**
   * What was written for after the turn under way, in order. Each of the user's goes as a
   * turn of its own. Kept across restarts; a turn the user stopped sends none, nor does one
   * ended on an error send the user's.
   */
  queue?: QueuedMessage[];
  /** What the agent works toward turn after turn, set with « /goal ». */
  goal?: ThreadGoal;
  /** Watches its pull request and has the agent fix it; see `PrWatch`. */
  prWatch?: PrWatch;
  /** What it does about a quota that ran out: waits for it, or goes on with a fallback. */
  quota?: ThreadQuota;
  /** The team lead's thread, for a coder's thread. */
  parentId?: string;
  /** The thread's part in a team. */
  role?: TeamRole;
  /** Works in that thread's folder rather than its own: a team's reviewer or tester. */
  worksIn?: string;
  /** The team this thread leads. */
  team?: Team;
  /** The review of a pull request by several agents this thread runs, set with « /revue ». */
  prReview?: PrReview;
  /** Set when the last turn ended with an error. */
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/** What lists of threads need of a thread's pull request. */
export interface ThreadPullRequest {
  url: string;
  number: number;
  state: PullRequestInfo["state"];
  /** Its checks as one: `failed` if one failed, else `pending` if one still runs. */
  checks: "none" | "pending" | "passed" | "failed";
  conflicts?: true;
  /** The repository's rules hold the merge back. */
  blocked?: true;
  /** Once merged, the commit GitHub merged: its branch still on it is merged. */
  mergedHead?: string;
}

/** What a list of threads keeps of a pull request. */
export function threadPullRequest(pr: PullRequestInfo): ThreadPullRequest {
  const counted = pr.checks.filter((c) => c.state !== "skipped");
  return {
    url: pr.url,
    number: pr.number,
    state: pr.state,
    checks: counted.some((c) => c.state === "failed")
      ? "failed"
      : counted.some((c) => c.state === "pending")
        ? "pending"
        : counted.length
          ? "passed"
          : "none",
    ...(pr.conflicts ? { conflicts: true as const } : {}),
    ...(pr.blocked ? { blocked: true as const } : {}),
    ...(pr.state === "merged" && pr.head ? { mergedHead: pr.head } : {}),
  };
}

/** Where a thread stands for its user, in the order a project lists them. */
export const THREAD_GROUPS = ["waiting", "running", "idle", "resolved"] as const;
export type ThreadGroup = (typeof THREAD_GROUPS)[number];

/** Phases of a team in which one of its agents works, or is about to. */
const TEAM_AT_WORK: readonly TeamPhase[] = ["planning", "coding", "merging"];

/**
 * The group of a thread, worked out from what is really going on: its agent, the team it
 * leads, its pull request. `waiting` means the next step is the user's: an answer, an
 * error to look at, a pull request to merge or whose checks failed. `members` are the
 * threads of the team it leads: the lead's own pull request is its team's, kept on it by
 * the server.
 */
export function threadGroup(thread: Thread, members: readonly Thread[] = []): ThreadGroup {
  if (thread.archived) return "resolved";
  // A team's member that asks the user something makes the whole team wait on them.
  if (
    thread.status === "waiting" ||
    thread.team?.phase === "blocked" ||
    members.some((m) => m.status === "waiting" && !m.archived)
  )
    return "waiting";
  // One waiting in line behind its coordinator starts by itself: it stays in sight with the
  // threads at work, not folded away with the idle ones.
  if (
    thread.status === "running" ||
    !!thread.held ||
    (thread.team && TEAM_AT_WORK.includes(thread.team.phase)) ||
    reviewAtWork(thread.prReview)
  )
    return "running";
  if (
    thread.status === "error" ||
    thread.team?.phase === "failed" ||
    thread.prReview?.phase === "failed"
  )
    return "waiting";
  const pr = thread.pr;
  if (pr?.state === "open" && (pr.checks === "failed" || pr.conflicts || prReady(pr)))
    return "waiting";
  return "idle";
}

/** An open pull request nothing holds back: only the user's merge is missing. */
export const prReady = (pr: ThreadPullRequest): boolean =>
  pr.state === "open" &&
  !pr.conflicts &&
  !pr.blocked &&
  pr.checks !== "pending" &&
  pr.checks !== "failed";

/** The planner's columns, in order. */
export const PLAN_STATUSES = ["todo", "doing", "report", "test", "live"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** A card of a project's planner: written by the user, or laid down by a team's lead. */
export interface PlanTask {
  id: string;
  projectId: string;
  /** Its number in the project, shown as `#12`; never used twice. */
  number: number;
  title: string;
  description?: string;
  /**
   * The user sets it, unless a thread or a team does the task: then it follows what that
   * thread, or the team's piece, is really doing.
   */
  status: PlanStatus;
  /**
   * `lead` when a team's lead planned it, `hermes` when Hermes laid it down from Discord,
   * `user` when written by hand.
   */
  source: "user" | "lead" | "hermes";
  /** The thread that works on it: started from the card, or linked by the user. */
  threadId?: string;
  /** The piece of a team it stands for: its status then follows that piece. */
  team?: { leadId: string; index: number };
  /** The day its work is meant to start, as a timestamp. */
  start?: number;
  /** The day it is due, as a timestamp. */
  due?: number;
  /** When its work really began: when it first left « À faire ». The server sets it. */
  startedAt?: number;
  /** When it was delivered. The server sets it, and clears it if the card comes back. */
  doneAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  /** When the server saw the agent start this step, and finish it. */
  startedAt?: number;
  endedAt?: number;
  /** What the agent used while on this step: a file, a command, a tool, at most three. */
  tools?: string[];
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "diff"; path: string; oldText: string | null; newText: string };

/** A question an agent asks with a tool of its own; the answer is the user's next message. */
export interface ToolQuestion {
  question: string;
  options: string[];
  /** Several options may be picked. */
  multi?: boolean;
  /** What each option means, in the order of `options`; "" for one that says nothing more. */
  descriptions?: string[];
  /** What each option would look like (code, a sketch in text), in the order of `options`. */
  previews?: string[];
}

/** The answer to one question: the options picked, and the user's own words if any. */
export interface QuestionAnswer {
  picks: string[];
  text?: string;
}

/** A question an agent stopped its turn on, waiting for an answer, in any thread. */
export interface PendingQuestion {
  threadId: string;
  itemId: string;
  questions: ToolQuestion[];
  at: number;
}

/** The kinds of image a message can carry. SVG is left out: it can carry scripts. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
/** The largest image the server keeps. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 8;

/** An image sent with a message, kept by the server with the message's thread. */
export interface ImageRef {
  id: string;
  /** The file's name, as it was sent or made up from its kind. */
  name: string;
  mime: ImageType;
  /** In bytes. */
  size: number;
}

export type Item =
  | {
      id: string;
      kind: "user";
      /** Empty when the message is only images. */
      text: string;
      /** The images sent with the message: read at `/api/attachments/<thread>/<id>`. */
      images?: ImageRef[];
      /** Written by the team's engine, not by the user: a member's brief, a fix, a check. */
      byTeam?: true;
      /**
       * Not typed by the user: written by the project's coordinator, an agent, or sent by
       * the server to take the thread's goal one turn further, to fix its pull request, or
       * with the review remarks the user picked on GitHub.
       */
      from?: "coordinator" | "goal" | "pr" | "remarks" | "hermes";
      /** Sent by Hermes, and its answer went back to Discord. */
      relayed?: true;
      /** The thread's files just before this message, for threads with their own branch. */
      checkpoint?: string;
      /**
       * Sent before the conversation moved into a project: going back to it puts the
       * project's files back as they were at the move (`checkpoint`).
       */
      beforeMove?: true;
      at: number;
    }
  | { id: string; kind: "agent"; text: string; at: number }
  | { id: string; kind: "thought"; text: string; at: number }
  | {
      id: string;
      kind: "tool";
      title: string;
      toolKind: string;
      status: ToolStatus;
      content: ToolContent[];
      /**
       * How many characters of `content` are left out of this copy: a large result does not
       * travel with the timeline, it is asked for with `item.get` when its line is opened.
       */
      omitted?: number;
      /**
       * The images the tool says it made, as paths of the computer: an agent such as Codex
       * tells them in the tool's result only, and its answer may not name them.
       */
      images?: string[];
      /** What the tool asks the user, when it is a question. */
      questions?: ToolQuestion[];
      /**
       * Set when the agent holds its turn until the question is answered (`question.respond`),
       * rather than ending the turn and reading the next message.
       */
      form?: "open" | "answered" | "cancelled";
      /** What the user answered to each question, once `form` is "answered". */
      answers?: string[];
      at: number;
    }
  | {
      id: string;
      kind: "permission";
      title: string;
      options: PermissionOption[];
      /** The option the user picked, or "cancelled" when the turn ended first. */
      outcome: string | null;
      at: number;
    }
  | { id: string; kind: "plan"; entries: PlanEntry[]; at: number }
  /** The coordinator opened a thread for a piece of work: a link to it, where it did. */
  | { id: string; kind: "opened"; threadId: string; title: string; at: number }
  /**
   * A thread the coordinator opened has finished what it was asked: its own last words and
   * the files it changed, told where the user asked for the work.
   */
  | {
      id: string;
      kind: "result";
      threadId: string;
      title: string;
      /** The start of the thread's last answer. */
      summary: string;
      /** The files changed on its branch, the first of them. */
      files: string[];
      /** How many more it changed. */
      moreFiles?: number;
      /** True when what ended is a failure, such as a team that could not finish. */
      failed?: boolean;
      at: number;
    }
  /** The thread went from one agent to another; agent items before it are `from`'s. */
  | { id: string; kind: "handoff"; from: AgentId; to: AgentId; at: number }
  /** The conversation, started outside any project, moved into this one. */
  | { id: string; kind: "moved"; projectId: string; name: string; at: number };

export type ItemKind = Item["kind"];

/** Favorite model ids per agent, shared by every device. */
export type Favorites = Record<AgentId, string[]>;

/** One favorite model, as placed in the user's order of the favorites wheel. */
export interface FavoriteRef {
  agentId: AgentId;
  model: string;
}

/**
 * Every favorite in the user's order: the ones the order names first, as it names them, then
 * the ones it does not name yet (starred elsewhere, or saved before there was an order), agent
 * by agent. Refs to a model that is no longer a favorite are left out.
 */
export function orderedFavorites(favorites: Favorites, order: FavoriteRef[] = []): FavoriteRef[] {
  const seen = new Set<string>();
  const out: FavoriteRef[] = [];
  const add = (agentId: string, model: string) => {
    const key = `${agentId}\u0000${model}`;
    if (seen.has(key) || !Object.hasOwn(favorites, agentId)) return;
    if (!(favorites[agentId] ?? []).includes(model)) return;
    seen.add(key);
    out.push({ agentId, model });
  };
  for (const ref of order) add(ref.agentId, ref.model);
  for (const [agentId, models] of Object.entries(favorites)) {
    for (const model of models) add(agentId, model);
  }
  return out;
}

export const SCHEDULE_REPEATS = ["once", "hourly", "daily", "weekdays", "weekly"] as const;
export type ScheduleRepeat = (typeof SCHEDULE_REPEATS)[number];

/**
 * A task MoonAgentic starts by itself, once or again and again: at its time, a new thread
 * of its project gets the task's text, with the agent chosen when it was planned.
 */
export interface Schedule {
  id: string;
  projectId: string;
  title: string;
  /** The message the thread starts with. */
  text: string;
  agentId: string;
  model?: string;
  permissionMode: PermissionMode;
  /** Each run gets its own branch, when the project is a git repository. */
  isolated?: boolean;
  repeat: ScheduleRepeat;
  /** When it next starts. For one that is off or has run its only time, when it last was due. */
  nextAt: number;
  /** Off: paused by the user, or a one-time task that has run. */
  enabled: boolean;
  /** How many times it really started a thread. */
  runs: number;
  lastAt?: number;
  /** The thread of its last run, while that thread exists. */
  lastThreadId?: string;
  /** Why its last time did not start, in words for the user. */
  lastError?: string;
  /** Planned by Hermes from Discord rather than by hand. */
  by?: "hermes";
  createdAt: number;
}

/** What Hermes may do in MoonAgentic, set in Réglages › Hermes · Discord. */
export interface HermesAllow {
  /** Write to a project's coordinator, and read its answer. */
  coordinators: boolean;
  /** Write to one thread of a project. */
  threads: boolean;
  /** Add cards to the planner and planned tasks. */
  plan: boolean;
  /** Answer the agents' permission requests and questions. */
  requests: boolean;
}

/** What MoonAgentic tells the Discord channel by itself. */
export interface HermesNotify {
  /** A thread finished its turn. */
  done: boolean;
  /** A thread waits for an answer. */
  waiting: boolean;
  /** A thread's pull request is ready to merge. */
  prReady: boolean;
}

/** One thing Hermes did, for the list under « Dernières actions ». */
export interface HermesAction {
  what: string;
  /** The project's name, when it was about one. */
  project?: string;
  at: number;
}

export const DEFAULT_HERMES_ALLOW: HermesAllow = {
  coordinators: true,
  threads: true,
  plan: true,
  requests: false,
};
export const DEFAULT_HERMES_NOTIFY: HermesNotify = { done: true, waiting: true, prReady: true };

/**
 * Hermes Agent, driven from Discord, as MoonAgentic sees it: whether it has an access, what
 * it may do, where notices go, and what it did lately.
 */
export interface HermesStatus {
  /** An access exists: Hermes's MCP server can call this MoonAgentic. */
  connected: boolean;
  /** When Hermes last called a tool. */
  lastSeen?: number;
  allow: HermesAllow;
  notify: HermesNotify;
  /** A Discord webhook is set for the notices; its address is never sent back. */
  webhook: boolean;
  /** The lines to put in Hermes's `config.yaml`, under `mcp_servers:`; no secret in them. */
  config: string;
  log: HermesAction[];
  /** MoonAgentic writing its `mcp_servers` entry in Hermes's setup and restarting its gateway. */
  setup?: HermesSetupState;
  /** MoonAgentic changing Hermes's default model, apart from the connection. */
  modelSetup?: HermesSetupState;
  /** Hermes's default model, as its `config.yaml` says; absent until read. */
  model?: { provider?: string; model: string };
  /** Why the model could not be read, when it could not. */
  modelError?: string;
  /** Hermes's Discord gateway as last looked at; started again by MoonAgentic when it stops. */
  gateway?: { running: boolean; at: number; reason?: string };
}

export interface HermesSetupState {
  what: "connect" | "model";
  state: "running" | "done" | "failed";
  /** What failed, in a sentence. */
  error?: string;
  at: number;
}

export type { PullRequestCheck, PullRequestInfo, PullRequestRemark } from "./pull-request.ts";
import type { PullRequestInfo, PullRequestRemark } from "./pull-request.ts";

/**
 * What MoonAgentic knows of GitHub on the machine running it: the account signed in from
 * MoonAgentic itself (its token stays on that machine, sealed by the system), or else what the
 * user's own `git` and `gh` know.
 */
export interface GithubStatus {
  /** `git` is installed. */
  git: boolean;
  /** GitHub CLI (`gh`) is installed. */
  gh: boolean;
  /** The signed-in account, when there is one. */
  login?: string;
  /**
   * Who signed in: MoonAgentic's own « Se connecter à GitHub », or the user's `gh`. MoonAgentic's
   * own sign-in wins when both are there.
   */
  account?: "moonagentic" | "gh";
  /** True when « Se connecter à GitHub » can be offered here. */
  canSignIn: boolean;
  /** Where MoonAgentic's own sign-in is kept, so the user is told the truth about it. */
  vault?: GithubVault;
  /**
   * How git proves who it is to github.com when it pushes: MoonAgentic's sign-in, `gh` lent for
   * each clone and push (after git's own helpers), or only its own credential helper, or nothing.
   */
  gitAuth: "token" | "helper" | "gh" | "none";
  /** Why the account could not be read, in GitHub's or `gh`'s own words. */
  error?: string;
}

/**
 * Where MoonAgentic keeps its GitHub sign-in: sealed with the Windows account (DPAPI), in the
 * macOS keychain or the Linux secret service, or, with none of them, a file only the user reads.
 */
export type GithubVault = "windows" | "macos" | "linux" | "file";

/** A repository the user can reach on GitHub. */
export interface GithubRepo {
  /** `owner/name`. */
  fullName: string;
  description?: string;
  private: boolean;
  /** Its last push, as a timestamp. */
  pushedAt?: number;
}

/** A git folder found on the machine running MoonAgentic, so nothing is cloned twice. */
export interface LocalClone {
  path: string;
  /** Its folder's name. */
  name: string;
  /** The GitHub repository its `origin` points to, as `owner/name`. */
  repo?: string;
  /** The project already using this folder. */
  projectId?: string;
}

/** A sign-in started from MoonAgentic: the code to type on GitHub, and where. */
export interface GithubDeviceCode {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

/** The kinds of work a coordinator opens a thread for. */
export const WORK_KINDS = ["question", "bug", "fonctionnalite", "relecture", "tests"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
/** What a route is set for: a kind of work, or all those with no route of their own. */
export const ROUTE_KINDS = ["default", ...WORK_KINDS] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

/** Threads a coordinator runs at once unless the settings say otherwise, and at most. */
export const DEFAULT_PARALLEL = 3;
export const MAX_PARALLEL = 6;
/**
 * Turns the whole server runs at once unless the settings say otherwise, and at most. Past
 * it, what a coordinator, a team or a planned task starts waits in line; what the user sends
 * themselves always goes.
 */
export const DEFAULT_MAX_TURNS = 4;
export const MAX_MAX_TURNS = 12;

/** A team as the user last set one up: what a coordinator starts when asked for a team. */
export interface TeamSetup {
  lead: TeamMember;
  coder: TeamMember;
  reviewer?: TeamMember;
  reviewer2?: TeamMember;
  judge?: TeamMember;
  tester?: TeamMember;
  merger?: TeamMember;
  coders: number;
  permissionMode: PermissionMode;
  autoShip?: boolean;
}

/** How coordinators route work: an agent and model for each kind, and the team to start. */
export interface CoordinatorSettings {
  /** A kind left out goes to the coordinator's own agent. */
  /** Per kind of work; `default` for every kind left unset, before the coordinator's own. */
  routes: Partial<Record<RouteKind, TeamMember>>;
  /** Kept from the last team the user started by hand. */
  team?: TeamSetup;
  /**
   * Kept from the last « /revue » the user started: one per maker, in the order of
   * `REVIEW_SLOTS`, `null` for a maker the user left out.
   */
  review?: (TeamMember | null)[];
  /** And its judge; `null` when the user chose none. */
  reviewJudge?: TeamMember | null;
  /** Threads a coordinator runs at once, the others waiting in line; 3 when left out. */
  parallel?: number;
  /** Turns the whole server runs at once, coordinators or not; 4 when left out. */
  maxTurns?: number;
}

/** One window of an agent's subscription, as the agent's own service reports it. */
export interface QuotaWindow {
  /** What it covers, in words: « Session de 5 h », « Semaine, Opus ». */
  label: string;
  /** The same, short, for tight places: « 5 h », « semaine ». */
  short: string;
  /** Share used, from 0 to 100; past 100 when the agent lets the user go over. */
  usedPercent: number;
  /** When it frees up again, as a timestamp, when the agent says. */
  resetsAt?: number;
  /**
   * The one model this window limits (« Opus », « Fable »), named by the agent: reaching it
   * stops that model only, not the agent.
   */
  model?: string;
  /**
   * When the window limits a group of models (« Gemini 4 Neon », « Gemini 4 Carbon »…), their
   * names as the agent gives them: `model` then names the group (« Gemini »).
   */
  models?: string[];
}

/**
 * What an agent's subscription has left, read from the agent's own service: never estimated.
 * `loading`: first read in progress; `unreadable`: the agent gives no figures to another app,
 * or asking failed (`note` says why); `none`: the agent pays as it goes, so there is no quota
 * to follow. When `state` is `ok`, `note` may still explain that a newer refresh failed
 * temporarily and the previous figures were kept.
 */
/** One day of the home page's activity map. */
export interface ActivityDay {
  /** Days since 1 January 1970, in the asking device's time zone. */
  day: number;
  /** Messages written that day by the user or an agent (a team's own briefs left out). */
  count: number;
}

export interface AgentQuota {
  agentId: AgentId;
  state: "ok" | "unreadable" | "none" | "loading";
  /** The plan, as the agent names it: « Abonnement Max », « ChatGPT Plus ». */
  plan?: string;
  windows: QuotaWindow[];
  /** Other lines worth showing, such as credits. */
  extras: { label: string; value: string }[];
  note?: string;
  /** Where the agent shows its figures itself, when they cannot be read here. */
  link?: string;
  /** True when the agent has no live reader (so re-reading cannot change this card). */
  fixed?: boolean;
  /** When figures were last read, as a timestamp. */
  readAt?: number;
}

export interface Snapshot {
  coordinator: CoordinatorSettings;
  favorites: Favorites;
  /** The order of the favorites wheel, as the user set it (see `orderedFavorites`). */
  favoriteOrder?: FavoriteRef[];
  requests: PendingRequest[];
  /** Questions agents hold their turn on, in every thread. */
  questions: PendingQuestion[];
  mcpServers: McpServerInfo[];
  /** Set when MCP secrets could not be decrypted/read from disk (e.g. DPAPI vault moved machines). */
  mcpSecretsError?: string;
  agents: AgentInfo[];
  projects: Project[];
  threads: Thread[];
  plan: PlanTask[];
  schedules: Schedule[];
  quotas: AgentQuota[];
  /** True once a code to lock projects with is set. */
  lockPin?: boolean;
  /** True when this connection belongs to a paired device rather than the computer itself. */
  pairedDevice?: boolean;
  /** The user's default choices for a new thread, once set on any device. */
  defaults?: Defaults;
  /** The teams the user set up in the settings; none until edited once. */
  teamPresets?: TeamPreset[];
  /** The mascot of each role of a team or a review the user changed; the others keep theirs. */
  roleMascots?: RoleMascots;
  /** This MoonAgentic's version and what it knows of a newer one. */
  app?: AppInfo;
  /**
   * Set while the database refuses writes for a cause outside MoonAgentic (a full disk, another
   * program holding the file): what to tell the user, as nothing is saved meanwhile.
   */
  storageError?: string;
  /** The threads' `/` commands, each list once, as `packSnapshot` leaves them. */
  commandLists?: AgentCommand[][];
}

/** The snapshot as it is sent: each list of `/` commands once, the threads naming theirs. */
export function packSnapshot(snapshot: Snapshot): Snapshot {
  const lists: AgentCommand[][] = [];
  const places = new Map<string, number>();
  const threads = snapshot.threads.map((thread) => {
    // An empty list stays as it is: it says the agent has none, which is not « not known yet ».
    if (!thread.commands?.length) return thread;
    const { commands, ...rest } = thread;
    const key = JSON.stringify(commands);
    let place = places.get(key);
    if (place === undefined) {
      place = lists.push(commands) - 1;
      places.set(key, place);
    }
    return { ...rest, commandList: place };
  });
  return { ...snapshot, threads, ...(lists.length ? { commandLists: lists } : {}) };
}

/** The snapshot as `packSnapshot` found it: each thread with its own `commands` again. */
export function unpackSnapshot(snapshot: Snapshot): Snapshot {
  const { commandLists, ...rest } = snapshot;
  return {
    ...rest,
    threads: snapshot.threads.map((thread) => {
      if (thread.commandList === undefined) return thread;
      const { commandList, ...kept } = thread;
      // A place that names no list leaves the thread without one, never with something else.
      const commands =
        Array.isArray(commandLists) && Number.isInteger(commandList) && commandList >= 0
          ? commandLists[commandList]
          : undefined;
      return Array.isArray(commands) ? { ...kept, commands } : kept;
    }),
  };
}

/** What a new thread starts with unless chosen otherwise, kept by the server for every device. */
export interface Defaults {
  permissionMode: PermissionMode;
  /** In a git project, each new thread works on its own branch. */
  isolated: boolean;
}

/**
 * A team under a name, as the user set it up: who takes each role. A role left out is taken
 * by the first agent ready (lead and coders) or by nobody; `null` means nobody on purpose.
 */
export interface TeamPreset {
  id: string;
  label: string;
  roles: {
    lead?: TeamMember;
    coder?: TeamMember;
    reviewer?: TeamMember | null;
    reviewer2?: TeamMember | null;
    judge?: TeamMember | null;
    tester?: TeamMember | null;
    merger?: TeamMember | null;
  };
}
/** At most this many saved teams. */
export const MAX_TEAM_PRESETS = 12;

/**
 * Where a screen is in a thread's timeline: the number of the first item it holds, and the
 * count of changes it has seen (`rev`) since the server started (`epoch`). Given back when
 * the thread is opened again, it lets the server send only what changed since.
 */
export interface TimelineMark {
  first: number;
  epoch: string;
  rev: number;
}

/**
 * One of the project repository's `moon/*` branches, the ones MoonAgentic makes for its threads.
 * `merged` when all it brings is already in the branch it is compared with, and no thread uses
 * it: only those can be deleted. `inUse` when a thread still works on it, or a worktree has it.
 */
export interface MoonBranch {
  name: string;
  /** When its last commit was made, in milliseconds. */
  at: number;
  state: "merged" | "inUse" | "unmerged";
  /** Commits it has that the branch it is compared with has not; 0 when merged. */
  ahead: number;
  /** The thread it was made for, when that thread is still there. */
  thread?: { id: string; title: string; archived?: boolean };
}

/** What an artifact is shown as: a page, an image, or a PDF document. */
export type ArtifactKind = "html" | "image" | "pdf";

/**
 * A file an agent made or changed in its thread's own branch that can be looked at as it is:
 * an HTML page, an image or a PDF. Found anew each time the list is asked for.
 */
export interface Artifact {
  threadId: string;
  threadTitle: string;
  projectId: string;
  /** Its path in the thread's folder, with `/` separators. */
  path: string;
  kind: ArtifactKind;
  size: number;
  /** When it was last written, in milliseconds. */
  mtime: number;
}

export type ServerMessage =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "agents"; agents: AgentInfo[] }
  | { type: "favorites"; favorites: Favorites; order?: FavoriteRef[] }
  | { type: "coordinatorSettings"; settings: CoordinatorSettings }
  /** Hermes's state, after it changed or when asked with `hermes.get`. */
  | { type: "hermes"; hermes: HermesStatus }
  /** Every permission request still waiting, after one is added or answered. */
  | { type: "requests"; requests: PendingRequest[] }
  /** Every question an agent holds its turn on, after one is asked or answered. */
  | { type: "questions"; questions: PendingQuestion[] }
  | { type: "mcpServers"; servers: McpServerInfo[]; error?: string }
  | { type: "mcpTools"; requestId: string; tools: McpTool[] }
  | { type: "project"; project: Project }
  | { type: "defaults"; defaults: Defaults }
  /** The app's version, settings or update changed. */
  | { type: "app"; app: AppInfo }
  /** The database refuses writes (see `Snapshot.storageError`), or takes them again (`null`). */
  | { type: "storage"; error: string | null }
  | { type: "teamPresets"; presets: TeamPreset[] | null }
  | { type: "roleMascots"; mascots: RoleMascots }
  | { type: "projectSetup"; requestId: string; projectId: string; setup: ProjectSetup }
  /** The skills installed for every project and for each project, after a change too. */
  | { type: "skills"; requestId: string; skills: InstalledSkill[] }
  /** The skills a repository holds, read from a shallow clone of it. */
  | { type: "skillsFound"; requestId: string; repo: string; ref?: string; skills: FoundSkill[] }
  /** What a command that installs skills will run, before it runs. */
  | { type: "skillCommand"; requestId: string; plan: SkillCommandPlan }
  /** What a running command printed, then how it ended. */
  | { type: "skillRun"; runId: string; output?: string; ended?: SkillRunEnd }
  | { type: "thread"; thread: Thread }
  /** The thread was deleted, its timeline with it. */
  | { type: "threadRemoved"; threadId: string }
  /** A planner card, new or changed. */
  | { type: "planTask"; task: PlanTask }
  | { type: "planTaskRemoved"; id: string }
  | { type: "schedule"; schedule: Schedule }
  | { type: "scheduleRemoved"; id: string }
  /** The project was removed from MoonAgentic, with its threads; its folder stays. */
  | { type: "projectRemoved"; projectId: string }
  /**
   * The end of a thread's timeline, from its item numbered `first`: the `earlier` ones
   * before it stay on the server until asked for with `thread.page`.
   */
  | ({ type: "items"; threadId: string; items: Item[]; earlier: number } & TimelineMark)
  /** An item, new or changed, with its number in the timeline. */
  | { type: "item"; threadId: string; item: Item; seq: number; rev: number }
  /** Streaming text appended to an existing agent or thought item. */
  | { type: "append"; threadId: string; itemId: string; text: string; rev: number }
  /** What changed in a timeline since the screen's mark: the answer to `thread.open` with `since`. */
  | { type: "changes"; threadId: string; items: { item: Item; seq: number }[]; rev: number }
  /** The stretch of a timeline that ends just before the item numbered `before`. */
  | {
      type: "page";
      requestId: string;
      threadId: string;
      items: Item[];
      before: number;
      first: number;
      earlier: number;
      /** Asked for a use that is not shown: the screen keeps what it holds. */
      apart?: true;
    }
  | {
      type: "review";
      threadId: string;
      files: ReviewFile[];
      error?: string;
      /** Files left out of the list because there are too many to show. */
      omitted?: number;
    }
  /**
   * What merging the branch the thread started from into its own would do now: how many
   * commits it is behind, and the files that would conflict. `target` is the branch it is
   * compared with, `origin/main` when the remote is ahead of the local `main`.
   */
  | {
      type: "forecast";
      requestId: string;
      threadId: string;
      target: string;
      behind: number;
      conflicts: string[];
    }
  /**
   * The files of a thread's own folder, as the « Fichiers » tab lists them: tracked ones and
   * new ones git does not ignore. `capped` when there were more than the list holds.
   */
  | {
      type: "worktreeFiles";
      requestId: string;
      threadId: string;
      files: string[];
      capped: boolean;
    }
  /**
   * The project repository's own `moon/*` branches, as « Nettoyer les branches » lists them,
   * with the branches they were compared with (the current one, and its remote copy).
   */
  | {
      type: "projectBranches";
      requestId: string;
      projectId: string;
      targets: string[];
      branches: MoonBranch[];
    }
  /**
   * The server's public key for Web Push, which a browser needs to subscribe, and whether the
   * browser at the address asked about is reached already.
   */
  | { type: "pushState"; requestId: string; publicKey: string; subscribed: boolean }
  /** The artifacts of the threads' own branches, the newest first; see `Artifact`. */
  | { type: "artifacts"; requestId: string; artifacts: Artifact[]; capped: boolean }
  /**
   * Where one artifact can be shown for a while: an address on this server that works without
   * the token, for the files of that thread's folder alone, and only for some minutes.
   */
  | { type: "artifactLink"; requestId: string; url: string; expiresAt: number }
  /**
   * Where a file an answer names can be seen for a while, in the same way as an artifact:
   * an image the agent made, a PDF, a page.
   */
  | {
      type: "fileLink";
      requestId: string;
      url: string;
      name: string;
      mime: string;
      size: number;
      expiresAt: number;
    }
  /** What deleting merged branches did: those deleted, and those kept with why. */
  | {
      type: "branchesDeleted";
      requestId: string;
      projectId: string;
      deleted: string[];
      kept: { name: string; reason: string }[];
    }
  /**
   * One file of a thread's folder, to read: its text, or why it is not shown (`binary`, or
   * `size` in bytes past what is shown).
   */
  | {
      type: "worktreeFile";
      requestId: string;
      threadId: string;
      path: string;
      text?: string;
      binary?: boolean;
      size?: number;
    }
  /** Project files matching what follows an `@`, best first. */
  | { type: "files"; requestId: string; files: string[] }
  /** What `$` and `/` can offer in a thread's folder, beyond the agent's own commands. */
  | { type: "catalog"; requestId: string; skills: Skill[]; commands: ProjectCommand[] }
  | { type: "searched"; requestId: string; hits: SearchHit[] }
  /**
   * Messages written each day, the user's and the agents', for the home page's activity map.
   * `day` counts days since 1 January 1970 in the asking device's time zone; days without a
   * message are left out. `firstAt`: when the first thread was started, so days before it
   * are drawn as « before MoonAgentic » rather than as days without work.
   */
  | {
      type: "activity";
      requestId: string;
      days: ActivityDay[];
      firstAt?: number;
    }
  /** An item whole, with what its copy in the timeline left out. */
  | { type: "fullItem"; requestId: string; threadId: string; item: Item }
  | {
      type: "shipped";
      requestId: string;
      threadId: string;
      commit?: string;
      url?: string;
      prOpened: boolean;
    }
  /** What each agent's subscription has left, after it was read again. */
  | { type: "quotas"; quotas: AgentQuota[] }
  | { type: "github"; requestId: string; status: GithubStatus }
  | { type: "githubRepos"; requestId: string; repos: GithubRepo[] }
  /** Reply to `github.login`: the code to type on GitHub. */
  | { type: "githubDevice"; requestId: string; device: GithubDeviceCode }
  /** How a sign-in started from MoonAgentic ended, sent to every client. */
  | {
      type: "githubLogin";
      state: "done" | "failed" | "cancelled";
      login?: string;
      error?: string;
    }
  /** Reply to `local.clones`: where projects go by default, and the git folders found. */
  | { type: "localClones"; requestId: string; parent: string; clones: LocalClone[] }
  /**
   * A pull request as it is now. Without `pr`: there is none, or nothing here can ask
   * GitHub (no `gh`, no GitHub remote); `error` says why when asking failed.
   */
  | { type: "pullRequest"; requestId: string; pr?: PullRequestInfo; error?: string }
  /** Reply to `workspace.prRemarks`: the pull request's open remarks; `error` when asking failed. */
  | {
      type: "prRemarks";
      requestId: string;
      number?: number;
      remarks: PullRequestRemark[];
      error?: string;
    }
  /** Reply to a create request, so the client can navigate to what it made. */
  | { type: "created"; requestId: string; id: string }
  /** Reply to a request that makes nothing new, once it succeeded. */
  | { type: "done"; requestId: string }
  /** Answer to a `ping`: the connection is alive. */
  | { type: "pong" }
  /**
   * A single-use ticket for the connection that will replace this one, good for `ttlMs`:
   * opening it again needs no request, which may go on a connection that died too.
   */
  | { type: "ws.ticket"; ticket: string; ttlMs: number }
  | { type: "error"; requestId?: string; message: string };

/** The most items one page of a timeline holds: an export reads a long thread by these. */
export const MAX_PAGE_ITEMS = 1000;

const id = z.string().min(1).max(200);
/**
 * Names an action of the user's that a screen sends again when it cannot tell whether the
 * server got it, a connection having died under it: the server does it once.
 */
const sendId = z.string().regex(/^[\w-]{1,64}$/);
/** Who takes a role in a team: an agent, on one of its models or its own default. */
const teamMember = z.object({ agentId: id, model: id.optional() }).strict();
/** How many bytes a text takes in UTF-8. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
/** A setup file's text, within {@link MAX_SETUP_FILE} bytes once in UTF-8. */
const setupText = z
  .string()
  .max(MAX_SETUP_FILE)
  .refine((t) => utf8Bytes(t) <= MAX_SETUP_FILE, "Texte trop long.");
/** A project's shared memory notes, within {@link MAX_PROJECT_MEMORY} bytes once in UTF-8. */
const memoryText = z
  .string()
  .max(MAX_PROJECT_MEMORY)
  .refine((t) => utf8Bytes(t) <= MAX_PROJECT_MEMORY, "Mémoire trop longue (16 Ko max).");
/** A command's or a skill's name: lower case, digits, `-` and `_`, as a file name too. */
const setupName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Un nom en minuscules, chiffres, - ou _.");
/** A description: one line. */
/** A GitHub repository skills are installed from: `owner/name`, nothing else. */
export const SKILL_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
/** A branch or tag of it: no option for git, no `.` or `..` part. */
export const SKILL_REF = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9][\w./-]{0,199}$/;
/** An installed skill's name: its folder's. */
const skillName = z.string().regex(/^[A-Za-z0-9][\w.-]{0,99}$/);
/** One line, as typed in a terminal. */
const skillCommand = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((c) => !/[\r\n\0]/.test(c), "Une seule ligne.");
const setupLine = z
  .string()
  .trim()
  .max(500)
  .regex(/^[^\r\n]*$/, "Une seule ligne.");
/** An item's number in its timeline, or a count of changes. */
const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(200_000);
/** A message's text, which may be empty when images say it all. */
const messageText = z.string().max(200_000);
/** The images joined to a message, already sent to `POST /api/attachments`. */
const attachments = z.array(id).max(MAX_IMAGES_PER_MESSAGE).optional();
const saysSomething = (m: { text: string; attachments?: string[] | undefined }) =>
  m.text.trim().length > 0 || (m.attachments?.length ?? 0) > 0;
const planTitle = z.string().trim().min(1).max(200);
const planDescription = z.string().trim().max(4000);
/** Names an MCP secret may take: an environment variable, or an HTTP header (RFC 9110 token). */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const secrets = (name: RegExp, sameName: (a: string, b: string) => boolean) =>
  z
    .array(z.object({ name: z.string().max(200).regex(name), value: z.string().max(10_000) }))
    .max(50)
    .refine((list) => list.every((s, i) => list.findIndex((o) => sameName(o.name, s.name)) === i));

export const McpServerInput = z.object({
  name: z.string().trim().min(1).max(120),
  transport: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("stdio"),
      command: z.string().trim().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(100),
      env: secrets(ENV_NAME, (a, b) => a === b),
    }),
    z.object({
      type: z.literal("http"),
      url: z.url({ protocol: /^https?$/ }).max(4096),
      headers: secrets(HEADER_NAME, (a, b) => a.toLowerCase() === b.toLowerCase()),
    }),
  ]),
  /** The projects whose threads get it: every project when left out. */
  projectIds: z.array(id).max(500).optional(),
  /** Given to a team's reviewers, testers and mergers too. */
  allRoles: z.boolean().optional(),
  /** The agents whose threads get it: every agent when left out. */
  agentIds: z.array(id).max(100).optional(),
});
export type McpServerInput = z.infer<typeof McpServerInput>;

export const ClientMessage = z.discriminatedUnion("type", [
  /** Asks for a `pong`: a connection that gets none back is dead, whatever the browser says. */
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("project.create"),
    requestId: id,
    name: z.string().trim().min(1).max(120),
    path: z.string().min(1).max(4096),
  }),
  z
    .object({
      type: z.literal("thread.create"),
      requestId: id,
      projectId: id,
      agentId: id,
      permissionMode: z.enum(["supervised", "full"]),
      model: id.optional(),
      settings: z
        .record(id, id)
        .refine((r) => Object.keys(r).length <= 20)
        .optional(),
      /** Gives the thread its own branch and worktree, when the project is a git repository. */
      isolated: z.boolean().optional(),
      text: messageText,
      attachments,
      /** The text is a goal: the agent works toward it over this many turns at most. */
      goal: z
        .object({ maxTurns: z.number().int().min(1).max(MAX_GOAL_TURNS).optional() })
        .optional(),
    })
    .refine(saysSomething),
  /**
   * Opens the project's coordinator, made with this agent the first time. Answers
   * `created` with its thread.
   */
  z.object({
    type: z.literal("coordinator.open"),
    requestId: id,
    projectId: id,
    agentId: id,
    model: id.optional(),
  }),
  /** Sends a kind of work to an agent and model; without an agent, back to the coordinator's own. */
  z.object({
    type: z.literal("coordinator.setRoute"),
    kind: z.enum(ROUTE_KINDS),
    agentId: id.optional(),
    model: id.optional(),
  }),
  /** How many threads a coordinator runs at once. */
  z.object({
    type: z.literal("coordinator.setParallel"),
    parallel: z.number().int().min(1).max(MAX_PARALLEL),
  }),
  /** How many turns the whole server runs at once. */
  z.object({
    type: z.literal("server.setMaxTurns"),
    maxTurns: z.number().int().min(1).max(MAX_MAX_TURNS),
  }),
  z.object({ type: z.literal("workspace.review"), threadId: id }),
  /**
   * Puts one file of the review back as it was where the branch started: its changes are
   * dropped, committed ones too. For a rename, `from` comes back as well.
   */
  z.object({
    type: z.literal("workspace.rejectFile"),
    requestId: id,
    threadId: id,
    path: z.string().min(1).max(4096),
    from: z.string().min(1).max(4096).optional(),
  }),
  /** Asks what merging the branch the thread started from would do now; see `forecast`. */
  z.object({ type: z.literal("workspace.forecast"), requestId: id, threadId: id }),
  /** Merges the branch the thread started from into its own, only when nothing conflicts. */
  z.object({ type: z.literal("workspace.sync"), requestId: id, threadId: id }),
  /** Lists the files of the thread's own folder; see `worktreeFiles`. */
  z.object({ type: z.literal("workspace.files"), requestId: id, threadId: id }),
  /** Reads one file of the thread's own folder, by its path in the list; see `worktreeFile`. */
  z.object({
    type: z.literal("workspace.readFile"),
    requestId: id,
    threadId: id,
    path: z.string().min(1).max(4096),
  }),
  z.object({
    type: z.literal("workspace.ship"),
    requestId: id,
    threadId: id,
    message: z.string().trim().min(1).max(10_000),
    pr: z.boolean(),
    /** The files to commit, as the review lists them; every change when left out. */
    files: z.array(z.string().min(1).max(4096)).min(1).max(5000).optional(),
  }),
  /**
   * Shows the thread. With `since`, the mark of what the screen already holds, the server
   * answers with what changed only, when it still knows.
   */
  z.object({
    type: z.literal("thread.open"),
    threadId: id,
    since: z.object({ epoch: id, rev: seq, first: seq }).optional(),
  }),
  /**
   * Asks for the items just before the one numbered `before`, back to `reach` if given.
   * `apart` is for a use that is not shown (an export): the screen keeps what it holds, and
   * the page may be bigger, `size` items.
   */
  z.object({
    type: z.literal("thread.page"),
    requestId: id,
    threadId: id,
    before: seq,
    reach: id.optional(),
    size: z.number().int().min(1).max(MAX_PAGE_ITEMS).optional(),
    apart: z.literal(true).optional(),
  }),
  /** The window no longer shows the thread: what its agent says next is unread. */
  z.object({ type: z.literal("thread.leave"), threadId: id }),
  z.object({ type: z.literal("thread.setUnread"), threadId: id, unread: z.boolean() }),
  /** Marks every thread of the project as read. */
  z.object({ type: z.literal("project.markRead"), projectId: id }),
  z
    .object({
      type: z.literal("thread.send"),
      threadId: id,
      text: messageText,
      attachments,
      sendId: sendId.optional(),
    })
    .refine(saysSomething),
  z.object({ type: z.literal("thread.cancel"), threadId: id, sendId: sendId.optional() }),
  /**
   * Takes a thread up again after its agent stopped: what waits goes first, else the agent
   * is asked to go on where it was. A new agent session starts with the thread's model.
   */
  z.object({ type: z.literal("thread.resume"), threadId: id, sendId: sendId.optional() }),
  /**
   * « Attendre »: a thread on a fallback model goes back to its own and waits for its quota,
   * to start again by itself once it is reset. Its turn on the fallback, if any, is stopped.
   */
  z.object({ type: z.literal("thread.quotaWait"), threadId: id }),
  /** The thread no longer starts again by itself when its quota is reset. */
  z.object({ type: z.literal("thread.quotaCancel"), threadId: id }),
  /**
   * Keeps a message for after the turn under way. Sent at once instead when the thread
   * is free and nothing waits before it.
   */
  z.object({
    type: z.literal("thread.queue"),
    requestId: id,
    threadId: id,
    text: messageText.trim().min(1),
  }),
  /** Changes a message that waits; an empty text takes it out. */
  z.object({
    type: z.literal("thread.queueEdit"),
    requestId: id,
    threadId: id,
    id,
    text: messageText,
  }),
  /**
   * Sends a message that waits now, the first one unless `id` names another: after a stop or
   * an error nothing goes by itself. With a turn under way, the turn is stopped first.
   */
  z.object({
    type: z.literal("thread.queueSend"),
    requestId: id,
    threadId: id,
    id: id.optional(),
  }),
  /**
   * Gives the thread a goal its agent works toward, turn after turn: at once if the thread
   * is free, else at the end of its turn. It replaces the one before.
   */
  z.object({
    type: z.literal("thread.goal"),
    requestId: id,
    threadId: id,
    text: messageText.refine((t) => t.trim().length > 0),
    maxTurns: z.number().int().min(1).max(MAX_GOAL_TURNS).optional(),
  }),
  /** Turns « Corriger tout seul » on or off for the thread's pull request; see `PrWatch`. */
  z.object({
    type: z.literal("thread.watchPr"),
    requestId: id,
    threadId: id,
    on: z.boolean(),
  }),
  /** Pauses the goal, takes it up again, or drops it. */
  z.object({
    type: z.literal("thread.goalControl"),
    requestId: id,
    threadId: id,
    action: z.enum(["pause", "resume", "stop"]),
  }),
  /** Puts the files back as they were before this message and forgets what came after. */
  z.object({ type: z.literal("thread.restore"), requestId: id, threadId: id, itemId: id }),
  /** Asks for an item whole: a tool's large result, when its line is opened. */
  z.object({ type: z.literal("item.get"), requestId: id, threadId: id, itemId: id }),
  /** Hands the thread to another agent, which gets the conversation so far. */
  z.object({ type: z.literal("thread.switchAgent"), threadId: id, agentId: id }),
  z.object({
    type: z.literal("thread.setPermissionMode"),
    threadId: id,
    permissionMode: z.enum(["supervised", "full"]),
  }),
  z.object({ type: z.literal("thread.setModel"), threadId: id, model: id }),
  z.object({ type: z.literal("thread.setSetting"), threadId: id, settingId: id, value: id }),
  z.object({ type: z.literal("thread.setPinned"), threadId: id, pinned: z.boolean() }),
  /** Gives the thread the user's own name, from its « … » menu. */
  z.object({
    type: z.literal("thread.rename"),
    threadId: id,
    title: z.string().trim().min(1).max(200),
  }),
  /** Takes a conversation started outside any project into a project. */
  z.object({ type: z.literal("thread.move"), threadId: id, projectId: id }),
  /** Gives a task to a team: a lead splits it, coders do the pieces at once, each on a branch. */
  z.object({
    type: z.literal("team.start"),
    requestId: id,
    projectId: id,
    task: text,
    lead: z.object({ agentId: id, model: id.optional() }),
    coder: z.object({ agentId: id, model: id.optional() }),
    reviewer: z.object({ agentId: id, model: id.optional() }).optional(),
    reviewer2: z.object({ agentId: id, model: id.optional() }).optional(),
    judge: z.object({ agentId: id, model: id.optional() }).optional(),
    tester: z.object({ agentId: id, model: id.optional() }).optional(),
    merger: z.object({ agentId: id, model: id.optional() }).optional(),
    coders: z.number().int().min(1).max(4),
    permissionMode: z.enum(["supervised", "full"]),
    /** Opens the pull request by itself once done; true when left out. */
    autoShip: z.boolean().optional(),
  }),
  /** Stops the team, its lead and every coder at work. */
  z.object({ type: z.literal("team.stop"), threadId: id }),
  /**
   * Has a pull request of the project's GitHub repository read by several agents at once,
   * each on its own thread, and their findings put together. `pr` is its number or address.
   */
  z.object({
    type: z.literal("review.start"),
    requestId: id,
    projectId: id,
    pr: z.string().trim().min(1).max(300),
    reviewers: z
      .array(z.object({ agentId: id, model: id.optional() }))
      .min(1)
      .max(3),
    /** Settles the points still disputed after the reviewers weighed each other's. */
    judge: z.object({ agentId: id, model: id.optional() }).optional(),
    /** What each maker's menu holds, `null` for nobody: kept for the next review. */
    slots: z
      .array(z.object({ agentId: id, model: id.optional() }).nullable())
      .max(3)
      .optional(),
    /** Every command of the reviewers and the judge waits for the user's yes. */
    supervised: z.boolean().optional(),
  }),
  /** Stops every reviewer still reading. */
  z.object({ type: z.literal("review.stop"), threadId: id }),
  /** Starts a reviewer that failed or was stopped again, in its own thread. */
  z.object({
    type: z.literal("review.retry"),
    requestId: id,
    threadId: id,
    index: z.number().int().min(0).max(2),
  }),
  /**
   * Starts a piece that is blocked, failed or stopped again, its tries counted from zero;
   * without a piece, the merge that stopped.
   */
  /** Pushes the finished team's branch and opens its pull request, once more. */
  z.object({
    type: z.literal("team.ship"),
    requestId: id,
    threadId: id,
  }),
  /** A mission added while the team works: its lead puts it in the plan. */
  z.object({
    type: z.literal("team.addMission"),
    requestId: id,
    threadId: id,
    text: z.string().trim().min(1).max(20_000),
  }),
  z.object({
    type: z.literal("team.retry"),
    requestId: id,
    threadId: id,
    index: z.number().int().min(0).max(63).optional(),
  }),
  /** Adds a card to the project's planner. */
  z.object({
    type: z.literal("plan.add"),
    requestId: id,
    projectId: id,
    title: planTitle,
    description: planDescription.optional(),
    status: z.enum(PLAN_STATUSES).optional(),
    start: z.number().int().positive().optional(),
    due: z.number().int().positive().optional(),
  }),
  /**
   * Changes a card. `null` clears its description, its days or its thread. The status
   * of a card a thread or a team works on follows that work, and cannot be set here.
   */
  z.object({
    type: z.literal("plan.update"),
    requestId: id,
    id,
    title: planTitle.optional(),
    description: planDescription.nullable().optional(),
    status: z.enum(PLAN_STATUSES).optional(),
    start: z.number().int().positive().nullable().optional(),
    due: z.number().int().positive().nullable().optional(),
    threadId: id.nullable().optional(),
  }),
  z.object({ type: z.literal("plan.remove"), requestId: id, id }),
  /**
   * Starts the card's work: a new thread of its project gets the card's title and
   * description, and the card follows it from then on. Answers `created` with the thread.
   */
  z.object({
    type: z.literal("plan.run"),
    requestId: id,
    id,
    agentId: id,
    permissionMode: z.enum(["supervised", "full"]),
    model: id.optional(),
    /** Gives the thread its own branch and worktree, when the project is a git repository. */
    isolated: z.boolean().optional(),
  }),
  /** Plans a task: at `at`, then as `repeat` says, a new thread starts with `text`. */
  z.object({
    type: z.literal("schedule.add"),
    requestId: id,
    projectId: id,
    title: planTitle.optional(),
    text: z.string().trim().min(1).max(200_000),
    agentId: id,
    model: id.optional(),
    permissionMode: z.enum(["supervised", "full"]),
    isolated: z.boolean().optional(),
    repeat: z.enum(SCHEDULE_REPEATS),
    at: z.number().int().positive(),
  }),
  /** Changes a planned task. Turning one back on that is past due moves it to its next time. */
  z.object({
    type: z.literal("schedule.update"),
    requestId: id,
    id,
    title: planTitle.optional(),
    text: z.string().trim().min(1).max(200_000).optional(),
    repeat: z.enum(SCHEDULE_REPEATS).optional(),
    at: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({ type: z.literal("schedule.remove"), requestId: id, id }),
  /** Starts the planned task now, whatever its time; its next time does not move. */
  z.object({ type: z.literal("schedule.run"), requestId: id, id }),
  z.object({
    type: z.literal("thread.setArchived"),
    threadId: id,
    archived: z.boolean(),
    sendId: sendId.optional(),
  }),
  z.object({ type: z.literal("thread.delete"), requestId: id, threadId: id }),
  z.object({ type: z.literal("project.remove"), requestId: id, projectId: id }),
  /** Gives the project another name in MoonAgentic; its folder keeps its own. */
  z.object({
    type: z.literal("project.rename"),
    projectId: id,
    name: z.string().trim().min(1).max(120),
  }),
  z.object({ type: z.literal("project.setPinned"), projectId: id, pinned: z.boolean() }),
  z.object({ type: z.literal("project.setArchived"), projectId: id, archived: z.boolean() }),
  /** Changes the defaults of every device: those not given stay. */
  z.object({
    type: z.literal("defaults.set"),
    permissionMode: z.enum(["supervised", "full"]).optional(),
    isolated: z.boolean().optional(),
  }),
  /** One role's mascot in teams and reviews, for every device; null puts back its own. */
  z.object({
    type: z.literal("roleMascots.set"),
    job: z.enum(ROLE_JOBS),
    look: z.object({ phase: z.enum(ROLE_PHASES), color: z.enum(ROLE_COLORS) }).nullable(),
  }),
  /** Keeps these teams, in this order; null goes back to the suggested ones. */
  z.object({
    type: z.literal("teamPresets.set"),
    presets: z
      .array(
        z.object({
          id: z.string().regex(/^[\w-]{1,40}$/),
          label: z.string().trim().min(1).max(40),
          roles: z
            .object({
              // Never nobody: left out, they fall back on the first agent ready.
              lead: teamMember.optional(),
              coder: teamMember.optional(),
              reviewer: teamMember.nullable().optional(),
              reviewer2: teamMember.nullable().optional(),
              judge: teamMember.nullable().optional(),
              tester: teamMember.nullable().optional(),
              merger: teamMember.nullable().optional(),
            })
            .strict(),
        }),
      )
      .min(1)
      .max(MAX_TEAM_PRESETS)
      .refine((list) => new Set(list.map((p) => p.id)).size === list.length, "Ids en double.")
      .nullable(),
  }),
  /** Its icon and tint in MoonAgentic; null puts back the folder, or the usual tint. */
  z.object({
    type: z.literal("project.setLook"),
    projectId: id,
    icon: z
      .string()
      .trim()
      .min(1)
      .max(MAX_PROJECT_ICON)
      // One glyph or a few letters: no spaces, no control characters.
      .regex(/^[^\s\p{Cc}]+$/u)
      .nullable(),
    color: z.enum(PROJECT_COLORS).nullable(),
  }),
  /**
   * What the project's threads do when a model's quota runs out. Each part left out stays as
   * it is.
   */
  z.object({
    type: z.literal("project.setQuotaRules"),
    projectId: id,
    resume: z.boolean().optional(),
    fallback: z
      .object({
        on: z.boolean(),
        back: z.boolean(),
        models: z
          .array(z.object({ agentId: id, model: id }))
          .max(MAX_FALLBACK_MODELS)
          .refine(
            (list) => new Set(list.map((m) => `${m.agentId}\u0000${m.model}`)).size === list.length,
            "Modèle en double.",
          ),
      })
      .optional(),
  }),
  /** « Supprimer après la fusion »: whether a thread's branch goes once its PR is merged. */
  z.object({ type: z.literal("project.setDeleteMerged"), projectId: id, on: z.boolean() }),
  /** The installed skills: answered with skills. */
  z.object({ type: z.literal("skills.list"), requestId: id }),
  /**
   * Reads the skills of a GitHub repository: `owner/name`, its address (a folder of it too),
   * a skills.sh page or an `npx skills add` line. Answered with skillsFound.
   */
  z.object({ type: z.literal("skills.find"), requestId: id, source: z.string().min(1).max(500) }),
  /** Installs skills found with skills.find, for every project or one, in these agents' folders. */
  z.object({
    type: z.literal("skills.install"),
    requestId: id,
    repo: z.string().regex(SKILL_REPO),
    ref: z.string().regex(SKILL_REF).optional(),
    paths: z.array(z.string().max(500)).min(1).max(50),
    projectId: id.optional(),
    agents: z.array(z.enum(SKILL_AGENTS)).min(1),
  }),
  /** Gives an installed skill to these agents only: copies it in or takes it out of their folders. */
  z.object({
    type: z.literal("skills.setAgents"),
    requestId: id,
    name: skillName,
    projectId: id.optional(),
    agents: z.array(z.enum(SKILL_AGENTS)).min(1),
  }),
  /** Moves an installed skill to every project (`to` left out) or to one project. */
  z.object({
    type: z.literal("skills.move"),
    requestId: id,
    name: skillName,
    projectId: id.optional(),
    to: id.optional(),
  }),
  /** Installs a skill from GitHub again, from where it came. */
  z.object({
    type: z.literal("skills.update"),
    requestId: id,
    name: skillName,
    projectId: id.optional(),
  }),
  /** Removes an installed skill from every agent's folder. */
  z.object({
    type: z.literal("skills.remove"),
    requestId: id,
    name: skillName,
    projectId: id.optional(),
  }),
  /** Says where a command that installs skills would run, before it runs: skillCommand. */
  z.object({
    type: z.literal("skills.preview"),
    requestId: id,
    command: skillCommand,
    projectId: id.optional(),
  }),
  /**
   * Runs a command that installs skills, as shown by skills.preview, in the project's folder
   * or the home folder. Its output comes as skillRun; answered with done once started.
   */
  z.object({
    type: z.literal("skills.run"),
    requestId: id,
    runId: id,
    command: skillCommand,
    projectId: id.optional(),
  }),
  /** Types a line into a running command, for a question it asks. */
  z.object({ type: z.literal("skills.runInput"), runId: id, text: z.string().max(2000) }),
  /** Stops a running command. */
  z.object({ type: z.literal("skills.runStop"), runId: id }),
  /** What the project gives its agents, read from its folder: answered with projectSetup. */
  z.object({ type: z.literal("project.setup"), requestId: id, projectId: id }),
  /** Writes `AGENTS.md` at the project's root. */
  z.object({
    type: z.literal("project.saveRules"),
    requestId: id,
    projectId: id,
    text: setupText,
  }),
  /** Saves the project's shared memory notes, kept in MoonAgentic across agents and worktrees. */
  z.object({
    type: z.literal("project.saveMemory"),
    requestId: id,
    projectId: id,
    text: memoryText,
  }),
  /** Has Claude Code read `AGENTS.md` too: `CLAUDE.md` imports it, made if need be. */
  z.object({ type: z.literal("project.linkClaude"), requestId: id, projectId: id }),
  /** Writes a `/` command, `.moonagentic/commands/<name>.md`; `previous`: its old name. */
  z.object({
    type: z.literal("project.saveCommand"),
    requestId: id,
    projectId: id,
    name: setupName,
    previous: setupName.optional(),
    description: setupLine,
    template: setupText.refine((t) => t.trim().length > 0),
  }),
  z.object({
    type: z.literal("project.removeCommand"),
    requestId: id,
    projectId: id,
    name: setupName,
  }),
  /**
   * Writes a skill: the one at `path` when given (one of the project's), else a new one in
   * `.claude/skills/<name>/SKILL.md` and `.agents/skills/<name>/SKILL.md`.
   */
  z.object({
    type: z.literal("project.saveSkill"),
    requestId: id,
    projectId: id,
    path: z.string().max(300).optional(),
    // As agents name them; a new one also needs a lower-case name, its folder's.
    name: z.string().regex(/^[A-Za-z0-9][\w.:-]{0,63}$/, "Un nom sans espace."),
    description: setupLine.refine((d) => d.length > 0, "Décris-la en une ligne."),
    body: setupText,
  }),
  /** Removes a project skill's `SKILL.md`; its folder goes too when nothing else is in it. */
  z.object({
    type: z.literal("project.removeSkill"),
    requestId: id,
    projectId: id,
    path: z.string().max(300),
  }),
  /** Sets the code projects are locked with, or changes it: then the current one is needed. */
  z.object({
    type: z.literal("lock.setPin"),
    requestId: id,
    pin: z.string().regex(/^\d{6}$/),
    current: z.string().max(20).optional(),
  }),
  /** Locks a project, for every device, until the code is given. */
  z.object({ type: z.literal("lock.project"), requestId: id, projectId: id }),
  z.object({
    type: z.literal("lock.unlock"),
    requestId: id,
    projectId: id,
    pin: z.string().max(20),
  }),
  /**
   * Checks the lock code and changes nothing: what a device asks before it shows its own
   * screen again, once locked as a whole.
   */
  z.object({ type: z.literal("lock.check"), requestId: id, pin: z.string().max(20) }),
  /** Clears the lock code and unlocks every project (computer only). */
  z.object({ type: z.literal("lock.reset"), requestId: id }),
  /** Asks for Web Push's key, and whether this browser is reached already; see `pushState`. */
  z.object({
    type: z.literal("push.state"),
    requestId: id,
    endpoint: z.string().max(2048).optional(),
  }),
  /** This browser wants notifications while MoonAgentic is closed, except for those projects. */
  z.object({
    type: z.literal("push.subscribe"),
    requestId: id,
    endpoint: z.string().url().max(2048),
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
    muted: z.array(id).max(500),
  }),
  z.object({
    type: z.literal("push.unsubscribe"),
    requestId: id,
    endpoint: z.string().max(2048),
  }),
  /** Asks for Hermes's state; answered with `hermes`. */
  z.object({ type: z.literal("hermes.get") }),
  /** Gives Hermes an access, or a new one in place of the old one. */
  z.object({ type: z.literal("hermes.connect"), requestId: id }),
  /** Takes Hermes's access away: its next call is refused. */
  z.object({ type: z.literal("hermes.cut"), requestId: id }),
  /**
   * Changes what Hermes may do and what is told on Discord; those not given stay. `webhook`
   * is a Discord webhook address, or null to stop the notices.
   */
  z.object({
    type: z.literal("hermes.set"),
    requestId: id,
    allow: z
      .object({
        coordinators: z.boolean(),
        threads: z.boolean(),
        plan: z.boolean(),
        requests: z.boolean(),
      })
      .partial()
      .optional(),
    notify: z
      .object({ done: z.boolean(), waiting: z.boolean(), prReady: z.boolean() })
      .partial()
      .optional(),
    webhook: z.string().max(500).nullable().optional(),
  }),
  /** Sends a test message to the Discord webhook. */
  z.object({ type: z.literal("hermes.test"), requestId: id }),
  /** Looks at Hermes's gateway now, and starts it if it stopped. */
  z.object({ type: z.literal("hermes.gateway"), requestId: id }),
  /** Writes Hermes's `mcp_servers` entry again and restarts its gateway. */
  z.object({ type: z.literal("hermes.install"), requestId: id }),
  /** Sets Hermes's default model, a model as Hermes lists it (`provider:model`). */
  z.object({
    type: z.literal("hermes.setModel"),
    requestId: id,
    model: z.string().trim().min(1).max(300),
  }),
  /** Looks for a newer version of MoonAgentic now. */
  z.object({ type: z.literal("app.check") }),
  /** Installs the version downloaded: once no thread is at work, or at once. */
  z.object({ type: z.literal("app.install"), when: z.enum(["idle", "now"]) }),
  /** Takes back an install that waits for the threads to finish. */
  z.object({ type: z.literal("app.cancel") }),
  /** Changes how the app looks for versions and runs; those not given stay. */
  z.object({
    type: z.literal("app.settings"),
    checks: z.boolean().optional(),
    notify: z.boolean().optional(),
    openAtLogin: z.boolean().optional(),
    preventSleep: z.boolean().optional(),
  }),
  /** Lists the artifacts of the threads' own branches; see `artifacts`. */
  z.object({ type: z.literal("artifacts.list"), requestId: id }),
  /** Asks for an address to show one artifact; see `artifactLink`. */
  z.object({
    type: z.literal("artifacts.open"),
    requestId: id,
    threadId: id,
    path: z.string().min(1).max(4096),
  }),
  /**
   * Asks for an address to see a file an answer of this thread names, as the agent wrote it
   * (a path of the computer, `file:///…`, or relative to the thread's folder); see `fileLink`.
   */
  z.object({
    type: z.literal("file.open"),
    requestId: id,
    threadId: id,
    ref: z.string().min(1).max(4096),
  }),
  /** Lists the project repository's `moon/*` branches; see `projectBranches`. */
  z.object({ type: z.literal("project.branches"), requestId: id, projectId: id }),
  /**
   * Deletes these `moon/*` branches, each only if it is still merged and no thread uses it
   * when the server looks again; see `branchesDeleted`.
   */
  z.object({
    type: z.literal("project.deleteBranches"),
    requestId: id,
    projectId: id,
    branches: z.array(z.string().min(1).max(300)).min(1).max(500),
  }),
  /**
   * Looks for project files to mention with `@`, in the thread's folder when given. `limit`
   * asks for more than the few a menu shows: with no query, the project's files from the
   * shallowest, for its tree.
   */
  z.object({
    type: z.literal("files.search"),
    requestId: id,
    projectId: id,
    threadId: id.optional(),
    query: z.string().max(500),
    limit: z.number().int().min(1).max(MAX_FILE_RESULTS).optional(),
  }),
  /** Lists the skills and project commands of the thread's folder, or the project's. */
  z.object({
    type: z.literal("composer.catalog"),
    requestId: id,
    projectId: id,
    threadId: id.optional(),
  }),
  /** Counts the messages written each day over the last `days` days, for the home page. */
  z.object({
    type: z.literal("activity"),
    requestId: id,
    /** The device's `Date#getTimezoneOffset()`, in minutes, so days end at its midnight. */
    tzOffset: z.number().int().min(-900).max(900),
    days: z.number().int().min(1).max(400),
  }),
  /** Finds messages containing the text, in every thread. */
  z.object({
    type: z.literal("search"),
    requestId: id,
    query: z.string().trim().min(2).max(200),
  }),
  /** Stars or unstars one model, so two devices editing favorites never overwrite each other. */
  z.object({
    type: z.literal("favorites.toggle"),
    agentId: id,
    model: id,
    starred: z.boolean(),
  }),
  /** Puts the favorites in this order: the wheel of the composer shows them so. */
  z.object({
    type: z.literal("favorites.reorder"),
    order: z.array(z.object({ agentId: id, model: id }).strict()).max(500),
  }),
  /** Gives the agent its moon, or none (`null`): it then keeps its logo or letters. */
  z.object({
    type: z.literal("agent.setMascot"),
    agentId: id,
    mascot: z
      .object({ shape: z.enum(MASCOT_SHAPES), color: z.enum(MASCOT_COLORS) })
      .strict()
      .nullable(),
  }),
  z.object({ type: z.literal("mcp.add"), requestId: id, server: McpServerInput }),
  z.object({ type: z.literal("mcp.setEnabled"), id, enabled: z.boolean() }),
  /** Says who gets the server: which projects (`null` for all of them), and which roles. */
  z.object({
    type: z.literal("mcp.setScope"),
    id,
    projectIds: z.array(id).max(500).nullable(),
    allRoles: z.boolean(),
  }),
  z.object({ type: z.literal("mcp.remove"), id }),
  /** Says which agents get the server: `null` for every agent. */
  z.object({
    type: z.literal("mcp.setAgents"),
    id,
    agentIds: z.array(id).max(100).nullable(),
  }),
  /** Starts the server briefly to list its tools; answered with `mcpTools`. */
  z.object({ type: z.literal("mcp.tools"), requestId: id, id }),
  /**
   * Starts the agent briefly to learn which models it offers, and whether it is ready.
   * Without a project, it starts in the user's home folder.
   */
  z.object({ type: z.literal("agent.discover"), agentId: id, projectId: id.optional() }),
  z.object({
    type: z.literal("agent.addCustom"),
    requestId: id,
    agent: z.object({
      name: z.string().trim().min(1).max(60),
      command: z.string().trim().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(50),
    }),
  }),
  z.object({ type: z.literal("agent.removeCustom"), agentId: id }),
  /** Reads each agent's subscription quotas again now, or only this agent's. */
  z.object({ type: z.literal("quotas.refresh"), requestId: id, agentId: id.optional() }),
  /** Asks what `git` and `gh` know of GitHub on the machine running MoonAgentic. */
  z.object({ type: z.literal("github.status"), requestId: id }),
  /** Lists the repositories the signed-in account can reach, last pushed first. */
  z.object({ type: z.literal("github.repos"), requestId: id }),
  /**
   * Starts « Se connecter à GitHub »: the reply holds a code to type on github.com, and a
   * `githubLogin` message follows once the user said yes there, or no, or let it expire.
   */
  z.object({ type: z.literal("github.login"), requestId: id }),
  /** Stops a sign-in still waiting for the user on GitHub. */
  z.object({ type: z.literal("github.loginCancel"), requestId: id }),
  /** Forgets MoonAgentic's own GitHub sign-in; `gh`'s, if any, is left alone. */
  z.object({ type: z.literal("github.logout"), requestId: id }),
  /** Where new projects go, and the git folders already on the machine. */
  z.object({ type: z.literal("local.clones"), requestId: id }),
  /** Asks GitHub for the pull request of a thread's branch, with its checks. */
  z.object({ type: z.literal("workspace.pr"), requestId: id, threadId: id }),
  /**
   * Merges the pull request of a thread's branch, if its last commit is still `head`: what
   * the user saw is what gets merged.
   */
  z.object({
    type: z.literal("workspace.mergePr"),
    requestId: id,
    threadId: id,
    number: z.number().int().positive(),
    head: z.string().regex(/^[0-9a-f]{40,64}$/),
  }),
  /** The open review remarks of the pull request of a thread's branch, as GitHub has them. */
  z.object({ type: z.literal("workspace.prRemarks"), requestId: id, threadId: id }),
  /**
   * Sends the thread's agent the review remarks picked among those, by GitHub's ids: the
   * server reads them again from GitHub rather than take their words from the client.
   */
  z.object({
    type: z.literal("workspace.sendRemarks"),
    requestId: id,
    threadId: id,
    ids: z.array(z.string().min(1).max(200)).min(1).max(100),
  }),
  /**
   * « Réglé »: a remark of the thread's pull request is done with. A conversation is resolved
   * on GitHub; a review, which GitHub cannot resolve, is kept settled in MoonAgentic. Answered
   * with prRemarks, read again.
   */
  z.object({
    type: z.literal("workspace.settleRemark"),
    requestId: id,
    threadId: id,
    id: z.string().min(1).max(200),
  }),
  /** Asks GitHub for the state of the pull request at this address, to draw its link. */
  z.object({
    type: z.literal("github.pr"),
    requestId: id,
    url: z.string().max(500),
  }),
  /**
   * Clones a GitHub repository into a new folder, `parent/name`, and makes it a project.
   * `repo` is `owner/name` or its address on github.com.
   */
  /**
   * The project « Discussions »: a folder of its own where a conversation goes when no project
   * exists yet, so the home page's composer can be used at once. Made the first time.
   */
  z.object({ type: z.literal("project.discussions"), requestId: id }),
  z.object({
    type: z.literal("project.clone"),
    requestId: id,
    repo: z.string().trim().min(3).max(500),
    parent: z.string().trim().min(1).max(4096),
    name: z.string().trim().min(1).max(120).optional(),
  }),
  /**
   * Answers a permission request. `followUp` is what the user says with a refusal: the
   * server sends it as their next message once the turn that asked is over, since no
   * message can go to an agent still at work.
   */
  z.object({
    type: z.literal("permission.respond"),
    threadId: id,
    itemId: id,
    optionId: id,
    followUp: z.string().trim().min(1).max(4000).optional(),
    sendId: sendId.optional(),
  }),
  /** Answers a question the agent holds its turn on: one answer per question, in order. */
  z.object({
    type: z.literal("question.respond"),
    threadId: id,
    itemId: id,
    answers: z
      .array(
        z.object({
          picks: z.array(z.string().max(500)).max(12),
          text: z.string().max(4000).optional(),
        }),
      )
      .min(1)
      .max(8),
    sendId: sendId.optional(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
