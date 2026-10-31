import type { Accessor, Resource } from "solid-js";
import type { CareTask, FarmCommandCenter as CommandData } from "@harvest/contracts";
import type { Workspace } from "../state";

/** Farm tool drawer selector. Owned by the shell, passed to views that open a drawer. */
export type Tool = "compare" | "soil" | null;
export type TodayScene = "growth" | "satellite";
/** One current crop cycle with its care evidence, as the shell resolves it (command-center data or the saved-workspace fallback). */
export type CommandCycle = CommandData["currentCycles"][number];

/**
 * Everything the Today tab receives from `FarmCommandCenter`.
 * The shell owns the command-center resource, the selected-cycle state, the plant-crop dialog and care completion.
 *
 * Since the Today rebuild (UI_BRIEF 3.1) the view loads `GET /api/v1/farms/:id/today` itself and reads only:
 * `data` (care sources and whether the plant dialog can open), `workspace` (field boundary), `cycles` (other current
 * crops), `tasks` (care schedule shown while the Today endpoint is unavailable), `scene`/`setScene` (Illustration or
 * Satellite, kept in the shell so it survives tab switches) and `openPlant`. Care completion goes through
 * `today/todayApi.ts` (same endpoint and idempotency header as `complete`) so the view can roll back an optimistic
 * Done. The other props stay in the interface so the shell compiles unchanged; the orchestrator can drop them when
 * it next edits the shell.
 */
export interface TodayViewProps {
  /** Parsed command-center data for the selected farm, or undefined while loading, on error, or for another farm. */
  data: Accessor<CommandData | undefined>;
  /** The command-center resource itself; the view reads `.loading` for the boundary-loading message. */
  resource: Resource<CommandData | undefined>;
  /** Newer of the stored workspace and the command-center workspace for the selected farm. */
  workspace: Accessor<Workspace | CommandData["workspace"] | undefined>;
  /** Unharvested cycles (command-center entries, or placeholders from the saved workspace while care evidence loads). */
  cycles: Accessor<CommandCycle[]>;
  /** The selected cycle entry (the first one when none is chosen). */
  active: Accessor<CommandCycle | undefined>;
  /** Open care tasks for the active cycle, earliest due first. */
  tasks: Accessor<CareTask[]>;
  /** Tasks of the active cycle that are due or overdue (the shell also shows this on the Today tab label). */
  dueCount: Accessor<number>;
  /** Growth model or satellite map. Kept in the shell so the choice survives switching tabs. */
  scene: Accessor<TodayScene>;
  setScene: (scene: TodayScene) => void;
  /** Whether every care task is expanded. Kept in the shell because a farm or session change resets it. */
  allCare: Accessor<boolean>;
  setAllCare: (value: boolean) => void;
  /** Id of the task currently being saved, or "". */
  careBusy: Accessor<string>;
  /** Select which current crop cycle the view shows. */
  setCycleId: (cycleId: string) => void;
  /** Record a source-scheduled care task as done today (POST, then refetch of the command center). */
  complete: (task: CareTask) => Promise<void>;
  /** Open the shell's plant-crop dialog, optionally with a crop preselected. */
  openPlant: (cropId?: string) => void;
  /** Open the soil-reports or compare-crops drawer. */
  showTool: (tool: Tool) => void;
}
