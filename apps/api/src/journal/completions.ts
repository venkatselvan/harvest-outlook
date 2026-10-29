import type { Pool } from "../db/pool";
import type { TaskCompletion, TaskCompletionSource } from "../plans";

/**
 * Feeds the plan timeline with tasks the farmer marked done in the journal. Completions are keyed by farm and task id
 * (task ids stay stable across plan revisions), so a revised plan keeps showing earlier completions.
 */
export function journalTaskCompletionSource(pool: Pool): TaskCompletionSource {
  const farmOf = "(SELECT farm_id FROM plans WHERE id = $2 AND owner_id = $1)";
  return {
    async getCompletions(ownerId: string, planId: string): Promise<TaskCompletion[]> {
      const r = await pool.query<{ task_id: string; completed_on: string }>(
        `SELECT task_id, to_char(completed_on,'YYYY-MM-DD') AS completed_on FROM journal_task_completions
         WHERE owner_id = $1 AND farm_id = ${farmOf} ORDER BY task_id`,
        [ownerId, planId],
      );
      return r.rows.map((x) => ({ taskId: x.task_id, completedOn: x.completed_on }));
    },
    async version(ownerId: string, planId: string): Promise<string> {
      const r = await pool.query<{ n: string; latest: string | null }>(
        `SELECT count(*)::text AS n, md5(coalesce(string_agg(task_id || ':' || completed_on::text || ':' || id::text, ',' ORDER BY task_id), '')) AS latest
         FROM journal_task_completions WHERE owner_id = $1 AND farm_id = ${farmOf}`,
        [ownerId, planId],
      );
      return `journal:${r.rows[0]!.n}:${r.rows[0]!.latest}`;
    },
  };
}
