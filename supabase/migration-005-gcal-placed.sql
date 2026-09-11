-- Run once in the Supabase SQL Editor, after migration-004-gcal.sql.
-- Safe to run twice.
--
-- Why this exists.
--
-- Whether a task has an event was remembered only by the device that made it,
-- in its own local notes. A second device never had those notes, and signing out
-- wipes them — so turning the sync off anywhere else deleted nothing and left
-- the events in the calendar with nothing that would ever remove them.
--
-- `gcal_placed` holds the calendar an event was actually put in, travels with
-- the task like everything else, and is `null` when there is no event. It is
-- also what tells a calendar change which calendar to take the old event out of.
--
-- The earlier copy of migration 004 added `tasks.gcal_event_id`. Nothing reads
-- it: the event's id is the task's own with the dashes removed. Drop it if it is
-- there; leaving it costs nothing either.

alter table public.tasks add column if not exists gcal_placed text;
alter table public.tasks drop column if exists gcal_event_id;
