-- Run once in the Supabase SQL Editor, on top of an existing schema.sql database.
-- Safe to run twice: every statement is guarded.
--
-- Why this exists.
--
-- A task can be mirrored into Google Calendar, which is where the owner's
-- reminders come from — the app itself cannot reach him with its tab closed.
-- Two columns on each side carry it:
--
--   tasks.gcal_event_id   the event this task owns, null until it has one
--   tasks.gcal            how that event is made: its clock time, which calendar
--                         it belongs to, its colour, and its reminders
--   workspaces.gcal_sync  put every dated task of this workspace in the calendar
--   workspaces.gcal       the defaults the whole-workspace sync hands out
--
-- They ride along with the rows they sit on, so the existing push and pull carry
-- them between devices with no new path and no second answer to a conflict.
--
-- `gcal.time` is the only clock in this database. It belongs to the event, not to
-- the task: no view reads it, nothing sorts by it, and it leaves with the column.

alter table public.tasks add column if not exists gcal_event_id text;
alter table public.tasks add column if not exists gcal jsonb;

alter table public.workspaces add column if not exists gcal_sync boolean not null default false;
alter table public.workspaces add column if not exists gcal jsonb;
