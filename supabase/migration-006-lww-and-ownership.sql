-- Run once in the Supabase SQL Editor, after migration-005-gcal-placed.sql.
-- Safe to run twice: every statement is guarded or replaced.
--
-- Why this exists.
--
-- 1. Last write wins — decided here, not by whoever arrives last.
--
-- The rule has always been "last write wins by `updated_at`", but nothing
-- enforced it: a device pushed its queue and the server wrote down whatever
-- came. An edit made on the phone at 10:05 while it was offline therefore
-- overwrote the laptop's 10:09 edit the moment the phone came back, and a
-- delete could be undone by an older edit that happened to arrive after it.
-- The server is the only place that sees both writes, so it is the only place
-- the rule can hold.
--
-- An update whose `updated_at` is older than the row's own is skipped whole.
-- Equal is accepted on purpose: a device rewrites a row of its own without
-- touching `updated_at` when all it records is where the calendar event ended
-- up, and that write has to land.
--
-- 2. A workspace deleted on one device takes the rows another device was
-- adding at the same time.
--
-- Deleting a workspace soft-deletes its labels, tasks and notes — but only the
-- ones the deleting device knew about. A task made on the phone a moment
-- earlier arrived afterwards and stayed live on the server under a workspace
-- that is gone: invisible in the app, present in the export, forever.
--
-- 3. A stranger could write into a workspace that is not his.
--
-- The policies checked `user_id` alone, and the foreign keys never look at who
-- owns the workspace they point at. Signed in as himself, anyone who learned a
-- workspace id could insert his own task, label or note into it.

-- ------------------------------------------------------------ last write wins

create or replace function public.keep_newer() returns trigger
language plpgsql
as $$
begin
  -- Returning null abandons the row: the older write changes nothing and
  -- `synced_at` is not moved either, so the row is not handed out again.
  if new.updated_at < old.updated_at then
    return null;
  end if;
  return new;
end;
$$;

-- ------------------------------------------- a workspace takes its rows along

create or replace function public.follow_workspace_delete() returns trigger
language plpgsql
as $$
begin
  if new.deleted and not old.deleted then
    -- `now()` and not the workspace's own stamp: the delete is the latest thing
    -- known about these rows, and it has to outrank the edit each of them is
    -- carrying, or the device that made that edit would push it back as newer.
    -- `greatest` keeps it from ever moving a stamp backwards.
    update public.labels set deleted = true, updated_at = greatest(updated_at, now())
      where workspace_id = new.id and not deleted;
    update public.tasks set deleted = true, updated_at = greatest(updated_at, now())
      where workspace_id = new.id and not deleted;
    update public.notes set deleted = true, updated_at = greatest(updated_at, now())
      where workspace_id = new.id and not deleted;
  end if;
  return null;
end;
$$;

create or replace function public.stay_deleted_with_workspace() returns trigger
language plpgsql
as $$
begin
  -- The row above catches what is already on the server; this one catches what
  -- is still on the way — a task made on the phone while the laptop was
  -- deleting the workspace it belongs to.
  if not new.deleted and exists (
    select 1 from public.workspaces w where w.id = new.workspace_id and w.deleted
  ) then
    new.deleted = true;
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['workspaces', 'labels', 'tasks', 'notes'] loop
    -- The names decide the order: triggers fire alphabetically, so an older
    -- write is thrown out before anything else looks at it, and `synced_at`
    -- is stamped last of all.
    execute format('drop trigger if exists %I on public.%I', t || '_keep_newer', t);
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function public.keep_newer()',
      t || '_keep_newer', t);
  end loop;

  foreach t in array array['labels', 'tasks', 'notes'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_stay_deleted', t);
    execute format(
      'create trigger %I before insert or update on public.%I
         for each row execute function public.stay_deleted_with_workspace()',
      t || '_stay_deleted', t);
  end loop;
end $$;

drop trigger if exists workspaces_cascade_delete on public.workspaces;
create trigger workspaces_cascade_delete after update on public.workspaces
  for each row execute function public.follow_workspace_delete();

-- ---------------------------------------------------------- your rows, yours

-- A label, a task or a note may only be written into a workspace you own.
-- Reading is still `user_id` alone: rows of yours are yours whatever they
-- point at, and a workspace that has not arrived yet must not hide them.
do $$
declare
  t text;
begin
  foreach t in array array['labels', 'tasks', 'notes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format(
      'create policy own_rows on public.%I
         for all
         using (auth.uid() = user_id)
         with check (
           auth.uid() = user_id
           and exists (
             select 1 from public.workspaces w
              where w.id = workspace_id and w.user_id = auth.uid()))', t);
  end loop;
end $$;

-- ------------------------------------------------ what was left before today

-- The triggers above catch every row from now on. Rows orphaned before this
-- migration existed — a task added on one device while another deleted its
-- workspace — are still live under a workspace that is gone; this sends them
-- after it once. Run as the owner of the database, it reaches every account's
-- rows; it only ever touches rows whose workspace is already deleted.
update public.labels set deleted = true, updated_at = greatest(updated_at, now())
  where not deleted and workspace_id in (select id from public.workspaces where deleted);
update public.tasks set deleted = true, updated_at = greatest(updated_at, now())
  where not deleted and workspace_id in (select id from public.workspaces where deleted);
update public.notes set deleted = true, updated_at = greatest(updated_at, now())
  where not deleted and workspace_id in (select id from public.workspaces where deleted);
