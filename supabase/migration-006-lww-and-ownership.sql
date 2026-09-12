-- Applied. Kept for a database that has not had it yet.
--
-- Everything this migration used to carry — `keep_newer`,
-- `follow_workspace_delete`, `stay_deleted_with_workspace`, their triggers and
-- the policies that bind a row to a workspace of yours — now lives in
-- `schema.sql` and only there. Re-running `schema.sql` in the SQL Editor puts
-- all of it in place: every statement in that file is guarded or replaced, and
-- it was tested over a database with rows in it — the data stays, the triggers
-- come back, and an update older than the row it lands on is refused from that
-- moment on.
--
-- What follows is the one thing re-running cannot do, because it is not a
-- definition but a single edit to the rows that were already there.

-- ------------------------------------------------ what was left before today

-- The triggers catch every row from now on. Rows orphaned before they existed —
-- a task added on one device while another deleted its workspace — are still
-- live under a workspace that is gone; this sends them after it once. Run as
-- the owner of the database, it reaches every account's rows; it only ever
-- touches rows whose workspace is already deleted.
update public.labels set deleted = true, updated_at = greatest(updated_at, now())
  where not deleted and workspace_id in (select id from public.workspaces where deleted);
update public.tasks set deleted = true, updated_at = greatest(updated_at, now())
  where not deleted and workspace_id in (select id from public.workspaces where deleted);
update public.notes set deleted = true, updated_at = greatest(updated_at, now())
  where not deleted and workspace_id in (select id from public.workspaces where deleted);
