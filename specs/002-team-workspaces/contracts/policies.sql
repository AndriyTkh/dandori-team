-- Contract: the SQL surface of 002-team-workspaces, as it will be written into
-- supabase/schema.sql.  NOT applied from this file -- ADR-0005 makes schema.sql the canonical
-- home of every definition, and this copy exists so the predicates can be reviewed as a unit
-- and diffed against what lands.  See ../plan.md D-1 .. D-9 and ../data-model.md.
--
-- Placement in schema.sql:
--   * fork block A  -- after upstream's table definitions, before the trigger loops
--   * fork block B  -- helpers, before the policy block (policies call them)
--   * fork block C  -- the fork's own triggers, in a guarded do $$ block that does NOT edit
--                      upstream's four-element foreach arrays (merge hygiene, plan R-4)
--   * policy block  -- upstream's existing drop/create block, replaced wholesale
-- Everything is idempotent and re-runnable, as upstream's file is.

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

-- kind is fixed at creation: coerce, never raise.  A raise would abort the whole sync
-- batch and stick the push queue; the third-value case is refused by the check constraint.
create or replace function public.pin_workspace_kind() returns trigger
language plpgsql as $fn$
begin
  new.kind := old.kind;
  return new;
end $fn$;

drop trigger if exists workspaces_zz_kind_fixed on public.workspaces;
create trigger workspaces_zz_kind_fixed before update on public.workspaces
  for each row execute function public.pin_workspace_kind();

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
