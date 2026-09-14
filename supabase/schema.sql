-- The Dandori schema. Run it whole in the SQL Editor of the Supabase project.
-- The script is idempotent: running it again breaks nothing.

-- All tables are built the same way:
--   user_id     — the owner, checked by the RLS policies;
--   updated_at  — the time of the edit, set by the device: it decides conflicts,
--                 and an update carrying one older than the row's own is refused
--                 here, so last-write-wins does not come down to who arrives last;
--   synced_at   — the time the server saw the row, set here by a trigger: the pull
--                 cursor runs on it, because an edit made offline keeps an
--                 `updated_at` older than the cursor of a device that has been
--                 online all along and would never be asked for again;
--   deleted     — soft delete, otherwise a deletion made on an offline device
--                 never arrives anywhere.

create table if not exists public.workspaces (
  id          uuid primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null default '',
  position    double precision not null default 0,
  -- Put every dated task of this workspace into Google Calendar, with one set of
  -- defaults: { "time": "10:00", "calendar_id": ..., "color_id": ..., "reminders": [...] }
  gcal_sync   boolean not null default false,
  gcal        jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false
);

create table if not exists public.labels (
  id            uuid primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null default '',
  color         text not null default 'slate',
  position      double precision not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted       boolean not null default false
);

create table if not exists public.tasks (
  id                  uuid primary key,
  user_id             uuid not null references auth.users (id) on delete cascade,
  workspace_id        uuid not null references public.workspaces (id) on delete cascade,
  title               text not null default '',
  description         text not null default '',
  -- The date type, not timestamp: the app has no time of day and never will.
  start_date          date,
  due_date            date,
  done                boolean not null default false,
  remind_days_before  integer,
  -- Keeps the task out of the reminder banner even when it is due today or
  -- already overdue. Separate from remind_days_before, which only controls
  -- the advance warning.
  muted               boolean not null default false,
  -- An attached note. Dropping the note only clears the link.
  note_id             uuid,
  position            double precision not null default 0,
  -- Labels live right inside the task: there is one user, a join table is redundant here.
  label_ids           jsonb not null default '[]'::jsonb,
  -- Custom fields of the card: [{ "name": "...", "value": "..." }]
  custom_fields       jsonb not null default '[]'::jsonb,
  -- The Google Calendar event mirroring this task, and how it is made:
  -- { "time": "10:00", "calendar_id": "primary", "color_id": null,
  --   "reminders": [{ "method": "popup", "minutes": 30 }] }
  -- `time` is the one clock in this database. It belongs to the event, never to
  -- the task: no view reads it and nothing sorts by it.
  gcal                jsonb,
  -- The calendar an event was actually put in; null when there is none. The one
  -- durable record that the event exists — a device that did not create it has
  -- no other way to know there is something to take away.
  gcal_placed         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted             boolean not null default false
);

create table if not exists public.notes (
  id            uuid primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  parent_id     uuid references public.notes (id) on delete cascade,
  kind          text not null check (kind in ('folder', 'file')),
  name          text not null default '',
  content       text not null default '',
  position      double precision not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted       boolean not null default false
);

-- tasks is declared before notes, so this foreign key is attached afterwards.
-- Dropping a note only clears the link, it never takes the task with it.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_note_id_fkey') then
    alter table public.tasks
      add constraint tasks_note_id_fkey
      foreign key (note_id) references public.notes (id) on delete set null;
  end if;
end $$;

-- ==========================================================================
-- fork block A -- added columns and the one added table            (plan D-1)
-- ==========================================================================

alter table public.workspaces
  add column if not exists kind text not null default 'personal';

alter table public.workspaces drop constraint if exists workspaces_kind_check;
alter table public.workspaces
  add constraint workspaces_kind_check check (kind in ('personal', 'team'));

create table if not exists public.members (
  id            uuid primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,       -- creator
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  member_id     uuid not null references auth.users (id) on delete cascade,       -- the subject
  level         text not null default 'member' check (level in ('owner', 'member')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  synced_at     timestamptz not null default now(),
  deleted       boolean not null default false
);

-- unconditional, NOT partial on (not deleted): re-adding a removed person must reuse this row
create unique index if not exists members_one_per_person
  on public.members (workspace_id, member_id);
create index if not exists members_by_person
  on public.members (member_id, synced_at);

alter table public.members enable row level security;

alter table public.tasks
  add column if not exists assignee uuid references auth.users (id) on delete set null;

-- `synced_at` is the server's own stamp: every write sets it, so the pull cursor
-- can order rows by the moment the server saw them.
create or replace function public.touch_synced_at() returns trigger
language plpgsql
as $$
begin
  new.synced_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['workspaces', 'labels', 'tasks', 'notes'] loop
    execute format(
      'alter table public.%I add column if not exists synced_at timestamptz not null default now()', t);
    execute format('drop trigger if exists %I on public.%I', t || '_synced_at', t);
    execute format(
      'create trigger %I before insert or update on public.%I
         for each row execute function public.touch_synced_at()',
      t || '_synced_at', t);
    execute format(
      'create index if not exists %I on public.%I (user_id, synced_at)', t || '_synced_at_idx', t);
  end loop;
end $$;

-- The rest is the ordinary lookup by workspace.
create index if not exists tasks_workspace_idx on public.tasks (workspace_id, due_date);
create index if not exists notes_workspace_idx on public.notes (workspace_id, parent_id);

-- Last write wins, and the server is the judge of it. A device pushes its queue
-- whenever it can, so without this the winner was whoever arrived last: an edit
-- made offline at 10:05 overwrote the one made at 10:09 on the other device.
-- Equal stamps are accepted on purpose — a device rewrites a row of its own
-- without touching `updated_at` when all it records is where the calendar event
-- ended up.
create or replace function public.keep_newer() returns trigger
language plpgsql
as $$
begin
  -- Returning null abandons the row: nothing is written and `synced_at` is not
  -- moved either, so the row is not handed out again for nothing.
  if new.updated_at < old.updated_at then
    return null;
  end if;
  return new;
end;
$$;

-- A deleted workspace takes its rows with it, including the ones another device
-- was adding at the same moment: they would otherwise stay live on the server
-- under a workspace that is gone — out of reach in the app, present in the export.
create or replace function public.follow_workspace_delete() returns trigger
language plpgsql
as $$
begin
  if new.deleted and not old.deleted then
    -- `now()`, not the workspace's own stamp: the delete is the latest thing
    -- known about these rows and has to outrank the edit each carries, or the
    -- device that made that edit would push it back as the newer one.
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
  -- The trigger above catches what is already on the server; this one catches
  -- what is still on the way.
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
  -- The names decide the order: triggers fire alphabetically, so an older write
  -- is thrown out before anything else looks at it, and `synced_at` is stamped
  -- last of all.
  foreach t in array array['workspaces', 'labels', 'tasks', 'notes'] loop
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

-- ==========================================================================
-- fork block B -- membership helpers                               (plan D-5)
-- security definer is NOT optional: members_access is a policy ON members whose predicate
-- must query members.  Inline EXISTS re-enters RLS on the same table ->
--   "infinite recursion detected in policy for relation members".
-- set search_path is a security control: without it a caller-controlled search_path can
-- substitute the table this function reads.
-- ==========================================================================

create or replace function public.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $fn$
  select exists (
    select 1 from public.members m
     where m.workspace_id = ws and m.member_id = auth.uid() and not m.deleted)
$fn$;

create or replace function public.is_owner(ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $fn$
  select exists (
    select 1 from public.members m
     where m.workspace_id = ws and m.member_id = auth.uid()
       and m.level = 'owner' and not m.deleted)
$fn$;

revoke execute on function public.is_member(uuid) from public, anon;
revoke execute on function public.is_owner(uuid)  from public, anon;
grant  execute on function public.is_member(uuid) to authenticated;
grant  execute on function public.is_owner(uuid)  to authenticated;

-- ==========================================================================
-- fork block C -- the fork's own triggers                    (plan D-3, D-6, D-8)
-- Naming: every new BEFORE trigger carries a _zz_ infix so it sorts AFTER upstream's
-- keep_newer -> stay_deleted -> synced_at.  Postgres fires same-timing triggers in name
-- order; a new trigger sorting first would run before keep_newer abandons a stale row and
-- would change observable behaviour (FR-014).
-- ==========================================================================

-- members gets the SAME housekeeping every synced table has, added here rather than by
-- editing upstream's array['workspaces','labels','tasks','notes'] loops.
drop trigger if exists members_synced_at on public.members;
create trigger members_synced_at before insert or update on public.members
  for each row execute function public.touch_synced_at();

drop trigger if exists members_keep_newer on public.members;
create trigger members_keep_newer before update on public.members
  for each row execute function public.keep_newer();

-- creator becomes owner, in the same operation, on every path into the table
create or replace function public.seed_workspace_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if new.kind = 'team' then
    insert into public.members (id, user_id, workspace_id, member_id, level)
    values (gen_random_uuid(), new.user_id, new.id, new.user_id, 'owner')
    on conflict (workspace_id, member_id) do nothing;
  end if;
  return null;
end $fn$;

drop trigger if exists workspaces_seed_owner on public.workspaces;
create trigger workspaces_seed_owner after insert on public.workspaces
  for each row execute function public.seed_workspace_owner();

-- kind is MUTABLE, by the workspace's owner, in either direction (ADR-0006 §D, owner
-- decision C, spec FR-034..FR-036).  There is no pin trigger: pin_workspace_kind and
-- workspaces_zz_kind_fixed of the superseded plan D-6 do NOT exist.  Kind is an ordinary
-- column under keep_newer and under the unchanged workspaces write half, which is already
-- owner-only -- so "only the owner may switch it" needs no new predicate (FR-034).
-- Two values only: workspaces_kind_check still refuses a third, at creation and at a switch
-- alike (FR-001, US8 acceptance 7).
--
-- The consequences of a switch are a trigger, because they must hold for every path into the
-- table -- the app's push, an offline-created workspace synced later, the SQL editor.
create or replace function public.on_workspace_kind_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if new.kind = 'personal' then
    -- team -> personal: every membership of this workspace ends, through exactly the
    -- soft-delete path a removal uses.  members_zz_clear_assignee then fires per row and
    -- clears that person's assignees with an outranking stamp -- one mechanism, not two
    -- (FR-035).  greatest(updated_at, now()) for the same reason follow_workspace_delete
    -- uses it: the end of the membership must outrank an edit already in flight.
    update public.members
       set deleted = true, updated_at = greatest(updated_at, now())
     where workspace_id = new.id and not deleted;
  else
    -- personal -> team: seed exactly ONE owner row, re-activating a previously
    -- soft-deleted one rather than adding a second (FR-036, SC-019).  Nobody who was a
    -- member during an earlier team period is restored -- only new.user_id is touched.
    insert into public.members (id, user_id, workspace_id, member_id, level)
    values (gen_random_uuid(), new.user_id, new.id, new.user_id, 'owner')
    on conflict (workspace_id, member_id) do update
       set deleted    = false,
           level      = 'owner',
           updated_at = greatest(public.members.updated_at, now());
  end if;
  return null;
end $fn$;

drop trigger if exists workspaces_zz_kind_change on public.workspaces;
create trigger workspaces_zz_kind_change after update on public.workspaces
  for each row when (new.kind is distinct from old.kind)
  execute function public.on_workspace_kind_change();
-- AFTER, so keep_newer (BEFORE, returning null on a stale write) has already abandoned a
-- stale row before this can fire -- a kind flip arriving out of order changes nothing.

-- assignee must be a live member.  A trigger, not RLS: no access decision may read assignee.
-- Coerce, never raise: same reasoning as pin_workspace_kind above -- a raise inside a sync
-- batch would abort the whole upsert and wedge the tasks queue for every device that queued an
-- assignment to a member removed in the meantime (the exact race US5 describes).  Coercion is
-- also the same structural answer as clear_assignee_on_removal below, so the two rules agree.
create or replace function public.assignee_must_be_member() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if new.assignee is not null
     and not exists (select 1 from public.members m
                      where m.workspace_id = new.workspace_id
                        and m.member_id = new.assignee and not m.deleted) then
    new.assignee := null;
  end if;
  return new;
end $fn$;

drop trigger if exists tasks_zz_assignee_member on public.tasks;
create trigger tasks_zz_assignee_member before insert or update on public.tasks
  for each row execute function public.assignee_must_be_member();

-- removal auto-clears assignment, structurally, never by the client.
-- greatest(updated_at, now()) so the clear outranks an edit already queued on the removed
-- member's device (same technique as follow_workspace_delete).
create or replace function public.clear_assignee_on_removal() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare ws uuid; who uuid;
begin
  if tg_op = 'DELETE' then
    ws := old.workspace_id; who := old.member_id;
  elsif new.deleted and not old.deleted then
    ws := new.workspace_id; who := new.member_id;
  else
    return null;
  end if;

  update public.tasks
     set assignee = null, updated_at = greatest(updated_at, now())
   where workspace_id = ws and assignee = who;
  return null;
end $fn$;

drop trigger if exists members_zz_clear_assignee on public.members;
create trigger members_zz_clear_assignee after update on public.members
  for each row execute function public.clear_assignee_on_removal();

drop trigger if exists members_zz_clear_assignee_del on public.members;
create trigger members_zz_clear_assignee_del after delete on public.members
  for each row execute function public.clear_assignee_on_removal();

-- user_id keeps meaning "who created this row" in a team workspace too.  Without this the
-- push path (sync.ts stamps user_id on every payload row) would rewrite it to whoever edited
-- last.  No-op on a personal row -- same value assigned.
create or replace function public.keep_creator() returns trigger
language plpgsql as $fn$
begin
  new.user_id := old.user_id;
  return new;
end $fn$;

do $blk$
declare t text;
begin
  foreach t in array array['labels', 'tasks', 'notes'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_zz_keep_creator', t);
    execute format('create trigger %I before update on public.%I
                    for each row execute function public.keep_creator()',
                   t || '_zz_keep_creator', t);
  end loop;
end $blk$;

-- Access to your own rows only. The app talks with the anon key,
-- so all data protection rests on these policies.
--
-- A label, a task or a note also has to land in a workspace you own: the
-- policies used to check `user_id` alone and the foreign keys never look at who
-- owns what they point at, so anyone who learned a workspace id could put his
-- own rows inside it. Reading stays `user_id` alone — rows of yours are yours
-- whatever they point at, and a workspace that has not arrived yet must not
-- hide them.
do $$
declare
  t text;
begin
  foreach t in array array['workspaces', 'labels', 'tasks', 'notes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
  end loop;

  execute
    'create policy own_rows on public.workspaces
       for all
       using (auth.uid() = user_id)
       with check (auth.uid() = user_id)';

  foreach t in array array['labels', 'tasks', 'notes'] loop
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
