# Supabase setup

1. Create a project on [supabase.com](https://supabase.com), pick a nearby region.
2. SQL Editor → paste `schema.sql` → Run.
3. Authentication → Providers → Email: leave it enabled,
   turn **Confirm email** off (there is one account, nobody to confirm it for).
4. Authentication → Users → Add user: create your own account by hand.
   There is no open sign-up in the app.
5. Project Settings → API: copy the `URL` and the `anon public` key
   into `.env.local`, following `.env.example`.

The `service_role` key is not needed by the app and never gets into the repository
under any circumstances: it bypasses RLS.

## Changing the database

`schema.sql` is the only place the tables, functions, triggers and policies are
written. It is idempotent — every statement is guarded or replaced — so bringing
an existing database up to date is pasting it into the SQL Editor and running it
again. Tested over a database with rows in it: the rows stay, the triggers and
policies come back, and the rules they carry hold from that moment.

A `migration-*.sql` file exists only for what re-running `schema.sql` cannot do:

- a column added to a table that already exists, since `create table if not
  exists` leaves a built table alone;
- a one-off edit to rows that were already there.

Nothing else goes into one. A definition copied into a migration is a second
copy of something that already has a home, and the two agree only until the day
someone changes one of them — which, for the rules that decide conflicts and
deletions, is a disagreement nothing in the app would ever show.
