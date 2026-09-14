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
--   * fork block D  -- instance_admins, is_admin(), the first-account trigger on auth.users
--                      (ADR-0006 §C, plan D-16)
--   * fork block E  -- the provisioning routines (ADR-0006 §B, plan D-16); their signatures,
--                      guards and error codes are contracted in ./rpc.md, which is
--                      authoritative for them -- this file carries blocks A-D
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
-- delegates to (T023a finding 7 -- this pointer previously said "five"). Signatures, guards,
-- error codes and the verbatim auth.users / auth.identities column set are contracted in
-- ./rpc.md, which is authoritative for the five public ones. All six are security definer, all
-- carry `set search_path = public, auth, extensions, pg_temp`, and every one of them refuses a
-- caller for whom public.is_admin() is false (FR-038, SC-018). The five public routines are
-- revoked from public and anon and granted to authenticated; `_create_login_impl` is revoked
-- from public, anon AND authenticated (T023a finding 5) -- it has no caller of its own.
-- ==========================================================================
