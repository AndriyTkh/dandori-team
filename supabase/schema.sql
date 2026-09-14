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
-- set search_path (T023a finding 8): every other definer/plain function this feature adds
-- carries one; this was the one omission, closed for consistency even though the function
-- reads nothing beyond its own NEW/OLD rows.
create or replace function public.keep_creator() returns trigger
language plpgsql set search_path = public, pg_temp as $fn$
begin
  new.user_id := old.user_id;
  return new;
end $fn$;

do $blk$
declare t text;
begin
  -- 'workspaces' joins the loop here (T023a finding 3): without it, `PATCH workspaces
  -- {user_id: <self>}` let a member overwrite the creator field and pass WITH CHECK
  -- (`auth.uid() = user_id`) trivially, because the value they just set is their own --
  -- a creator hijack.  Same mechanism labels/tasks/notes already had from T022; sorts as
  -- workspaces_zz_keep_creator, after workspaces_keep_newer/_synced_at (name order).
  foreach t in array array['workspaces', 'labels', 'tasks', 'notes'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_zz_keep_creator', t);
    execute format('create trigger %I before update on public.%I
                    for each row execute function public.keep_creator()',
                   t || '_zz_keep_creator', t);
  end loop;
end $blk$;

-- FR-010 (T023a finding 4): nothing above stops the sole owner of a team workspace soft-
-- deleting or demoting their own membership, or promoting/transferring another member to
-- `level = 'owner'` -- P1 has no ownership transfer at all.  A trigger, not a policy: the rule
-- has to see BOTH the row being written and the current owner-of-record (workspaces.user_id),
-- and members_access/members_update's predicates only ever see the row + auth.uid().
-- Exempted while the invariant would otherwise be meaningless or would fight a legitimate
-- structural purge: workspace gone (FK cascade already removed it), workspace `deleted`
-- (irrelevant once the whole workspace is gone), or `kind <> 'team'` (a kind-switch purge,
-- `on_workspace_kind_change`, runs AFTER the workspace row's own `kind` is already 'personal',
-- so this trigger reads the post-switch value and steps aside for its purge -- verified by
-- tests/stack/team-rls-delete-and-owner-invariant.test.ts (e1)).
create or replace function public.members_owner_invariant() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  ws record;
begin
  -- A real Postgres superuser (the local stack's harness connects as `postgres` directly, and a
  -- self-hoster's own admin SQL does the same) already has unconditional power over every row
  -- and every trigger in the database -- `ALTER TABLE ... DISABLE TRIGGER`,
  -- `session_replication_role = replica`, or simply `DROP TRIGGER` would get there anyway, so
  -- refusing it here would not be a real boundary, only friction on admin housekeeping (test
  -- fixture teardown included). RLS-facing roles (`authenticated`, `anon`, `service_role`) are
  -- never superusers, so this cannot be used to route around the invariant from the app.
  if current_setting('is_superuser') = 'on' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  select id, user_id, deleted, kind into ws
    from public.workspaces
   where id = coalesce(new.workspace_id, old.workspace_id);

  if ws.id is null or ws.deleted or ws.kind <> 'team' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.level = 'owner' and new.member_id <> ws.user_id then
    raise exception using errcode = 'DA016',
      message = 'only the workspace creator may hold level=owner -- no promote or transfer in P1';
  end if;

  if tg_op = 'UPDATE' and old.level = 'owner' then
    if new.deleted and not old.deleted then
      raise exception using errcode = 'DA016', message = 'the owner cannot remove their own membership';
    end if;
    if new.level <> 'owner' then
      raise exception using errcode = 'DA016', message = 'the owner cannot demote themselves';
    end if;
  end if;

  if tg_op = 'DELETE' and old.level = 'owner' then
    raise exception using errcode = 'DA016', message = 'the owner row cannot be hard-deleted directly';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $fn$;

drop trigger if exists members_zz_owner_invariant on public.members;
create trigger members_zz_owner_invariant before insert or update or delete on public.members
  for each row execute function public.members_owner_invariant();

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
end $$;

-- ==========================================================================
-- policy block -- REPLACED, both halves of each policy, separately    (plan D-4)
-- The write half's first branch is upstream's clause character for character: for a personal
-- workspace is_member() is false, so both halves evaluate exactly as today and the P0 RLS
-- tests pass unedited.  Reads stay looser than writes on the child tables, as today.
-- ==========================================================================

do $blk$
declare t text;
begin
  -- workspaces: READ widens to membership; WRITE deliberately does not.
  -- A member may not rename or delete the workspace (FR-005).
  execute 'drop policy if exists own_rows on public.workspaces';
  execute 'create policy own_rows on public.workspaces
             for all
             using      (auth.uid() = user_id or public.is_member(id))
             with check (auth.uid() = user_id)';

  foreach t in array array['labels', 'tasks', 'notes'] loop
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I
      for all
      using (
        auth.uid() = user_id
        or public.is_member(workspace_id)
      )
      with check (
        (
          auth.uid() = user_id
          and exists (select 1 from public.workspaces w
                       where w.id = workspace_id and w.user_id = auth.uid())
        )
        or public.is_member(workspace_id)
      )', t);
    -- NOTE: the membership branch is NOT conjoined with auth.uid() = user_id.  Conjoining it
    -- would stop a member editing a row another member created, which is the whole point of
    -- a team workspace.
  end loop;

  -- members: fork-only table, fork-only policy name.  own_rows keeps meaning exactly what
  -- upstream means by it.
  execute 'drop policy if exists members_access on public.members';
  execute 'create policy members_access on public.members
             for all
             using      (public.is_member(workspace_id))
             with check (public.is_owner(workspace_id) and auth.uid() = user_id)';
  -- read: any member sees the workspace''s membership rows (FR-007, FR-015)
  -- write: owners only, recording themselves as the row''s creator.  The creator''s own first
  --        owner row comes from workspaces_seed_owner, which is security definer and so does
  --        not have to satisfy this predicate -- that is what closes the chicken-and-egg hole.
end $blk$;

-- ==========================================================================
-- T023a findings 1 and 2 -- DELETE narrowed with RESTRICTIVE policies, `own_rows`/
-- `members_access` left byte-identical to c5fda53 above.
--
-- `for all` applies its one `using` clause to SELECT, UPDATE **and DELETE** alike -- there is
-- no way to give DELETE a narrower `using` than SELECT/UPDATE share within a single `for all`
-- policy. At c5fda53 the widened `using` (added for team reads) therefore also widened DELETE:
-- any member could hard-DELETE the team workspace (cascading away its labels/tasks/notes/
-- members, finding 1) or any `members` row including the owner's (finding 2).
--
-- Renaming `own_rows`/`members_access` into four single-command policies apiece was the first
-- approach tried here; it was reverted because two already-passing tests key off those exact
-- names via `pg_policies` (`team-rls-both-halves.test.ts`'s `fetchPolicyHalves`,
-- `schema-apply.test.ts`'s "creates the own_rows policy on all four tables") and this card's
-- own instruction is to fix the schema, not the tests, when a name (not a behaviour) is what
-- collides. `AS RESTRICTIVE` is the mechanism Postgres gives for exactly this: a restrictive
-- policy's `using` clause is AND-ed onto the applicable permissive ones for the SAME command
-- rather than OR-ed, so a `for delete` restrictive policy narrows what `own_rows`/
-- `members_access` already permit for DELETE specifically, without touching either policy's
-- own row in `pg_policies` (name, `qual`, `with_check` all stay exactly as introspected today).
-- No committed test issues a member hard-DELETE of any of these tables (the app itself never
-- does -- src/db/api.ts, src/sync/sync.ts only ever soft-delete), so narrowing DELETE here
-- closes a hole without touching any asserted product behaviour.
-- ==========================================================================

do $blk$
declare t text;
begin
  foreach t in array array['workspaces', 'labels', 'tasks', 'notes'] loop
    execute format('drop policy if exists %I_zz_delete_creator_only on public.%I', t, t);
    execute format('create policy %I_zz_delete_creator_only on public.%I
      as restrictive
      for delete
      using (auth.uid() = user_id)', t, t);
  end loop;

  execute 'drop policy if exists members_zz_delete_owner_only on public.members';
  execute 'create policy members_zz_delete_owner_only on public.members
             as restrictive
             for delete
             using (public.is_owner(workspace_id))';
end $blk$;

-- ==========================================================================
-- add-by-email and member listing -- two security definer RPCs   (plan D-9, contracts/rpc.md)
-- These reach `auth.users`, which policies alone cannot do (RLS on public tables says nothing
-- about it), so both carry `auth` in their search_path -- the two membership helpers above do
-- not need it and do not have it.  Revoked from public/anon for the same reason as is_member/
-- is_owner: PostgREST publishes every public function as an RPC by default (plan R-3).
-- ==========================================================================

create or replace function public.add_member_by_email(ws uuid, email text)
returns public.members
language plpgsql security definer set search_path = public, auth, pg_temp as $fn$
declare
  found_id     uuid;
  result       public.members;
  -- Computed into its own name, never referenced bare inside a query below: a query that
  -- names both `u.email` (the column) and the parameter `email` in the same scope raises
  -- plpgsql's `42702 column reference "email" is ambiguous`, not a normal comparison.
  wanted_email text := lower(trim(email));
begin
  if not public.is_owner(ws) then
    raise exception using errcode = 'DA001', message = 'not an owner of this workspace';
  end if;

  -- Supabase stores auth.users.email lower-cased; the owner types free text.  Normalising
  -- both sides is what stops an existing account being reported as absent (plan R-13).
  select u.id into found_id
    from auth.users u
   where lower(trim(u.email)) = wanted_email
   limit 1;

  -- The lookup precedes the insert inside this one function call, so a DA404 here leaves
  -- no row of any kind behind (SC-010) -- there is nothing left to roll back.
  if found_id is null then
    raise exception using errcode = 'DA404', message = 'no account with this email on this origin';
  end if;

  -- The set-list deliberately does not touch `level`: re-adding a removed person reactivates
  -- the same row (US2 acceptance 6), and adding the owner's own email hits this same conflict
  -- target without ever demoting them from 'owner' (edge case 5).
  insert into public.members (id, user_id, workspace_id, member_id, level)
  values (gen_random_uuid(), auth.uid(), ws, found_id, 'member')
  on conflict (workspace_id, member_id)
  do update set deleted = false, updated_at = now()
  returning * into result;

  return result;
end;
$fn$;

revoke execute on function public.add_member_by_email(uuid, text) from public, anon;
grant  execute on function public.add_member_by_email(uuid, text) to authenticated;

-- Zero rows unless the caller is a member (FR-007) -- a refusal reads exactly like an empty
-- workspace, which is what US2 acceptance 5 asks for.  No `profiles` table and no second copy
-- of the email exists anywhere: this reads auth.users live, at call time, and returns only the
-- three fields a member list needs.  `not m.deleted` keeps a removed person off the list they
-- no longer belong to, the same predicate is_member itself uses.
create or replace function public.workspace_member_emails(ws uuid)
returns table (member_id uuid, email text, level text)
language sql stable security definer set search_path = public, auth, pg_temp as $fn$
  select m.member_id, u.email, m.level
    from public.members m
    join auth.users u on u.id = m.member_id
   where m.workspace_id = ws
     and not m.deleted
     and public.is_member(ws)
$fn$;

revoke execute on function public.workspace_member_emails(uuid) from public, anon;
grant  execute on function public.workspace_member_emails(uuid) to authenticated;

-- ==========================================================================
-- fork block D -- the instance-admin layer              (ADR-0006 §C, plan D-16)
-- A SECOND, INDEPENDENT role layer.  It is an *instance* capability, never a workspace one:
-- no access policy above reads instance_admins, and none ever may (FR-039, SC-007's sibling).
-- An RLS policy that reads this table is a standing reviewer FINDING (ADR-0006 Consequences).
-- ==========================================================================

create table if not exists public.instance_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  granted_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table public.instance_admins enable row level security;
-- and NO policy: the table is unreachable from PostgREST by anyone.  It is read only by
-- is_admin() and written only by the provisioning routines, all security definer.  The
-- client learns "am I an admin" from the is_admin() RPC, never by selecting this table
-- (plan D-17).  It is not a synced table and never enters SYNCED_TABLES.

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $fn$
  select exists (select 1 from public.instance_admins a where a.user_id = auth.uid())
$fn$;

revoke execute on function public.is_admin() from public, anon;
grant  execute on function public.is_admin() to authenticated;

-- The first account ever created on this origin becomes an instance admin structurally --
-- granted by the backend, and ONLY while no admin exists (FR-037).  A trigger, not a runbook
-- step: it holds for every path that creates an account, so an instance is never adminless
-- and nobody has to be told to grant it.  Every account created afterwards is not an admin.
create or replace function public.seed_first_admin() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if not exists (select 1 from public.instance_admins) then
    insert into public.instance_admins (user_id, granted_by)
    values (new.id, null)
    on conflict (user_id) do nothing;
  end if;
  return null;
end $fn$;

drop trigger if exists users_seed_first_admin on auth.users;
create trigger users_seed_first_admin after insert on auth.users
  for each row execute function public.seed_first_admin();
-- Note (plan R-16): a trigger on auth.users is the common supported Supabase pattern (the
-- same shape the platform's own "handle_new_user" recipe uses), but the auth schema's
-- migrations are owned by GoTrue.  This trigger, and the routines of fork block E, are what
-- R-15's canary test exists to protect.

-- pgcrypto lives in the extensions schema on Supabase and is what fork block E's
-- extensions.crypt/gen_salt come from (plan R-17).  Asserted, never created here: creating
-- an extension needs privileges schema.sql does not assume.
--   select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
--    where e.extname = 'pgcrypto';        -- asserted by tests/stack/schema-apply.test.ts

-- ==========================================================================
-- fork block E -- the provisioning routines               (ADR-0006 §B, plan D-16)
-- create_login / set_login_password / delete_login / set_login_admin / list_logins -- five
-- public routines, plus a sixth, `_create_login_impl`, the impl-split helper `create_login`
-- delegates to (see its own comment above for why the split exists at all: `create_login`'s
-- pinned signature and PostgREST's plpgsql column-name collision force it). Signatures, guards,
-- error codes and the verbatim auth.users / auth.identities column set are contracted in
-- specs/002-team-workspaces/contracts/rpc.md, which is authoritative for the five public ones.
-- All six are security definer, all carry `set search_path = public, auth, extensions, pg_temp`,
-- and every one of them refuses a caller for whom public.is_admin() is false (FR-038, SC-018).
-- The five public routines are revoked from public and anon and granted to authenticated;
-- `_create_login_impl` is revoked from all three (public, anon, authenticated, T023a finding
-- 5) -- it has no caller of its own and is reached only through `create_login`, itself
-- `security definer`, whose privilege as the executing role is unaffected by this function's
-- own grants.
-- ==========================================================================

-- create_login's pinned signature returns a table column literally named "email", the same
-- name as its own input parameter -- plpgsql refuses that outright ("parameter name "email"
-- used more than once", probe-verified against this repo's own local stack 2026-09-14). The
-- pinned parameter and column names cannot change (R-3, PGRST202 on rename), so the real
-- logic lives in this differently-named-parameter helper, unreachable from PostgREST on its
-- own (revoked from public below), and create_login itself is a thin `language sql` shim --
-- a SQL-language function has no such symbol table and raises nothing over the shared name.
create or replace function public._create_login_impl(p_email text, p_password text, p_admin boolean)
returns table (user_id uuid, email text, is_admin boolean)
language plpgsql security definer set search_path = public, auth, extensions, pg_temp as $fn$
declare
  new_id     uuid;
  norm_email text := lower(trim(p_email));
begin
  if not public.is_admin() then
    raise exception using errcode = 'DA001', message = 'not an instance admin';
  end if;

  if norm_email !~ '^[^@\s]+@[^@\s]+$' then
    raise exception using errcode = 'DA010', message = 'malformed email';
  end if;

  if length(p_password) < 8 then
    raise exception using errcode = 'DA011', message = 'password too short';
  end if;

  -- Pre-check (contracts/rpc.md line 124 calls it exactly that): loses the race under
  -- concurrent create_login calls for the same email, which is why the insert below is
  -- ALSO wrapped -- SC-021 needs both (coordinator note 2026-09-14, T018 case (i)).
  if exists (select 1 from auth.users u where lower(trim(u.email)) = norm_email) then
    raise exception using errcode = 'DA012', message = 'identifier already in use';
  end if;

  new_id := gen_random_uuid();

  begin
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change, is_sso_user
    ) values (
      '00000000-0000-0000-0000-000000000000', new_id, 'authenticated', 'authenticated',
      norm_email, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
      '', '', '', '', false
    );
  exception when unique_violation then
    -- The loser of a concurrent create_login race hits GoTrue's own
    -- users_email_partial_key unique index here, not the pre-check above (SC-021).
    raise exception using errcode = 'DA012', message = 'identifier already in use';
  end;

  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), new_id, new_id::text,
    jsonb_build_object('sub', new_id::text, 'email', norm_email, 'email_verified', true),
    'email', now(), now(), now()
  );

  if p_admin then
    insert into public.instance_admins (user_id, granted_by) values (new_id, auth.uid());
  end if;

  return query select new_id, norm_email, coalesce(p_admin, false);
end;
$fn$;

-- T023a finding 5: `from public` alone left `anon`/`authenticated` still holding EXECUTE --
-- Supabase's own default privileges grant it to those two roles directly, not only through
-- `public`, so revoking `public` does not touch them. The `is_admin()` guard inside the body
-- still held (an anon caller got DA001, never DA015+), but the function was reachable at all,
-- which is itself the finding: an unrevoked, undocumented public endpoint.
revoke execute on function public._create_login_impl(text, text, boolean) from public, anon, authenticated;

create or replace function public.create_login(email text, password text, admin boolean default false)
returns table (user_id uuid, email text, is_admin boolean)
language sql security definer set search_path = public, auth, extensions, pg_temp as $fn$
  select * from public._create_login_impl(email, password, admin);
$fn$;

revoke execute on function public.create_login(text, text, boolean) from public, anon;
grant  execute on function public.create_login(text, text, boolean) to authenticated;

create or replace function public.set_login_password(user_id uuid, password text)
returns void
language plpgsql security definer set search_path = public, auth, extensions, pg_temp as $fn$
declare
  target uuid := user_id;
begin
  if not public.is_admin() then
    raise exception using errcode = 'DA001', message = 'not an instance admin';
  end if;

  if length(password) < 8 then
    raise exception using errcode = 'DA011', message = 'password too short';
  end if;

  if not exists (select 1 from auth.users u where u.id = target) then
    raise exception using errcode = 'DA404', message = 'no such login';
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = target;
end;
$fn$;

revoke execute on function public.set_login_password(uuid, text) from public, anon;
grant  execute on function public.set_login_password(uuid, text) to authenticated;

create or replace function public.delete_login(user_id uuid)
returns void
language plpgsql security definer set search_path = public, auth, extensions, pg_temp as $fn$
declare
  target uuid := user_id;
begin
  if not public.is_admin() then
    raise exception using errcode = 'DA001', message = 'not an instance admin';
  end if;

  if not exists (select 1 from auth.users u where u.id = target) then
    raise exception using errcode = 'DA404', message = 'no such login';
  end if;

  if target = auth.uid() then
    raise exception using errcode = 'DA013', message = 'cannot remove your own login';
  end if;

  if exists (
    select 1 from public.workspaces w
     where w.user_id = target and w.kind = 'team' and not w.deleted
  ) then
    raise exception using errcode = 'DA014', message = 'login owns a live team workspace';
  end if;

  -- Ban, not delete: every fork- and upstream-owned data table declares
  -- `user_id ... references auth.users (id) on delete cascade` (schema.sql workspaces:18,
  -- labels:32, tasks:44, notes:81) -- a real delete would cascade away everything this login
  -- ever created, including rows in team workspaces other people still use (FR-045, R-18).
  --
  -- DEVIATION from ADR-0006 §B / contracts/rpc.md, which both write
  -- `banned_until = 'infinity'`: probe-verified against this repo's own local stack
  -- (GoTrue v2.196.0, 2026-09-14) to 500 on the next sign-in attempt --
  -- "sql: Scan error on column index 1, name \"banned_until\": unsupported Scan, storing
  -- driver.Value type string into type *time.Time" -- GoTrue's Go client cannot scan
  -- Postgres' infinity timestamp into a time.Time. A finite far-future timestamp (still
  -- "banned_until is not null" for the test, still refused at sign-in) is what actually
  -- works against the pinned GoTrue version; flagged for the coordinator, contract text
  -- unchanged (out of this card's Write scope).
  update auth.users
     set banned_until       = '9999-12-31 23:59:59+00'::timestamptz,
         encrypted_password = extensions.crypt(gen_random_uuid()::text || gen_random_uuid()::text,
                                                extensions.gen_salt('bf')),
         updated_at         = now()
   where id = target;

  -- Table-aliased: a bare `where user_id = target` here is ambiguous between this
  -- function's own `user_id` parameter and the column of the same name (42702,
  -- probe-verified 2026-09-14) -- the same collision class T024 hit, this time in a
  -- WHERE clause rather than a query already qualifying every column.
  delete from public.instance_admins ia where ia.user_id = target;

  -- Explicit soft-delete, not left to a cascade: this is what makes
  -- members_zz_clear_assignee fire per row, exactly as a manual removal does (FR-014).
  update public.members
     set deleted = true, updated_at = greatest(updated_at, now())
   where member_id = target and not deleted;
end;
$fn$;

revoke execute on function public.delete_login(uuid) from public, anon;
grant  execute on function public.delete_login(uuid) to authenticated;

create or replace function public.set_login_admin(user_id uuid, admin boolean)
returns void
language plpgsql security definer set search_path = public, auth, extensions, pg_temp as $fn$
declare
  target uuid := user_id;
begin
  if not public.is_admin() then
    raise exception using errcode = 'DA001', message = 'not an instance admin';
  end if;

  if not exists (select 1 from auth.users u where u.id = target) then
    raise exception using errcode = 'DA404', message = 'no such login';
  end if;

  if admin then
    -- `on conflict (user_id)` names the pk column, not a variable, but PL/pgSQL's
    -- ambiguity check scans the on-conflict target list too (42702, probe-verified
    -- 2026-09-14) and finds this function's own `user_id` parameter -- an alias on the
    -- insert target does not help there (only the constraint name does), so this names
    -- the constraint instead of the column it covers.
    insert into public.instance_admins (user_id, granted_by)
    values (target, auth.uid())
    on conflict on constraint instance_admins_pkey do nothing;
  else
    if exists (select 1 from public.instance_admins a where a.user_id = target)
       and (select count(*) from public.instance_admins) <= 1 then
      raise exception using errcode = 'DA015', message = 'cannot revoke the last admin';
    end if;
    delete from public.instance_admins ia where ia.user_id = target;
  end if;
end;
$fn$;

revoke execute on function public.set_login_admin(uuid, boolean) from public, anon;
grant  execute on function public.set_login_admin(uuid, boolean) to authenticated;

create or replace function public.list_logins()
returns table (user_id uuid, email text, is_admin boolean, created_at timestamptz)
language plpgsql security definer set search_path = public, auth, extensions, pg_temp as $fn$
begin
  if not public.is_admin() then
    raise exception using errcode = 'DA001', message = 'not an instance admin';
  end if;

  return query
    select u.id, u.email::text, (a.user_id is not null), u.created_at
      from auth.users u
      left join public.instance_admins a on a.user_id = u.id
     order by u.created_at;
end;
$fn$;

revoke execute on function public.list_logins() from public, anon;
grant  execute on function public.list_logins() to authenticated;
