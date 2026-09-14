# ADR-0007 — Upstream's Google Calendar worker route is adopted as-is

- **Status:** Accepted (owner, 2026-09-14 — "merge new features, resolve conflicts")
- **Date:** 2026-09-14
- **Decider:** Andrii Tkhorenko (AndriyTkh) — fork owner, solo operator
- **Depends on:** ADR-0001 (fork contract — "no credential in the repository"), ADR-0004 (single
  origin per instance), ADR-0002 (phase gates — `gcal-integration` stays `UNTESTED`)
- **Amends:** nothing — it records a fact that arrived from upstream and corrects the architecture
  document, which had frozen the pre-merge truth.

## Context

Upstream `nitatsuu/Dandori` (8 commits, tip `806f5a8`, merged here as `7cb8df6` → `db23c6d`)
reworked how the app holds a Google account. Before the merge the browser renewed its access
through Google Identity Services' token client, which opens a window even when it has nothing to
ask — and a blocked window meant "every reload ended the connection and cost a click"
(`docs/upstream-CLAUDE.md`, §Google Calendar). Upstream records that the fix broke a rule upstream
had written itself, and that it was right to: an integration whose point is a reminder is worthless
if the token quietly expires.

The new shape: the consent screen is a page the owner is sent to on his own click, once; what comes
back and stays is a **refresh token** in the browser. Google hands a refresh token only to a client
that can keep a secret, so the one step that needs the secret — trading the code for tokens, and
trading the refresh token for another hour — is asked of a Cloudflare Worker that also serves the
static site. `wrangler.jsonc` now names `main: worker/index.ts`, keeps the `ASSETS` binding over
`./dist`, and adds `run_worker_first: ["/api/*"]`. Two further changes ride along: an event deleted
in Google is read back once per pass and unticks its task (one bit travelling the other way), and a
label's colour now chooses the event's colour (`GCAL_COLOR_OF`, `src/db/types.ts`). Three statements
in `docs/ARCHITECTURE.md` are thereby false — §2's layering line, §4's "no server component
anywhere", §5's "no client secret anywhere" — and the fork's Git rule requires an architecture
change to arrive as an ADR plus a regenerated index plus a map cascade, in one change set.

## Decision

**The fork adopts upstream's worker route as-is.** Specifically:

1. **One Worker, one route family.** The deploy is still one artifact: the `ASSETS` binding serving
   the built `./dist`, plus `/api/gcal/*` and nothing else (two doors, `token` and `revoke`;
   anything else under `/api/` is a deliberate 404 rather than the SPA fallback). No second route
   and no other server surface without its own ADR. **`worker/` is owned by the `infra` role**,
   alongside `wrangler.jsonc` and the service worker; it is not a data path and `data` does not
   touch it.
2. **`GOOGLE_CLIENT_SECRET` is a Cloudflare Worker secret and nothing else.** ADR-0001's rule — no
   credential, key or token anywhere in the repository or in a build — is **unchanged**, and now
   binds the worker too: never in `.env.example`, never in `wrangler.jsonc`, never inlined into the
   bundle, never in any answer the worker returns. ADR-0006's standing reviewer duty covers
   `worker/` without amendment.
3. **ADR-0004's origin invariant is untouched — stated explicitly.** The worker is **per-deployment,
   not per-origin**. It holds no database connection, stores nothing between requests, and never
   sees a `user_id`, a `workspace_id`, a task row or a Supabase token; all that passes through it is
   a Google authorization code, a verifier, a redirect URI and a refresh token, belonging to the one
   browser that asked. It cannot relate two origins and is not a federation surface: it is a
   property of the *site*, not of the data.
4. **Google Calendar stays personal-workspace behaviour.** What a team workspace should do about
   calendar events — whose calendar, whose consent, whose reminder — is **out of scope**: no spec
   exists, and per ADR-0001 no feature exists outside `specs/`.

## Alternatives considered

- **Reject the route, keep the browser-only token client.** Rejected. It buys the fork nothing — the
  differentiator is the agent-edit layer, not the calendar — while making every future upstream
  merge a conflict across `src/gcal/`, `wrangler.jsonc`, `README.md` and `.env.example`, and keeping
  the defect upstream measured. The fork pays for divergence only where its own model requires it.

## Consequences

- **`docs/ARCHITECTURE.md` §2, §4 and §5 are corrected in this change set**, and
  `docs/architecture-index.md` is regenerated against the new line counts.
- **`gcal-integration`'s map entry gains `worker/index.ts` in its `paths`** — the coordinator's
  edit, same change set. No status flip: the entry is already `UNTESTED`.
- **`s-gcal-round-trip`'s happy path is unchanged** — a task ticked for the calendar still appears
  as an event and disappears when unticked. Only how the token behind it is obtained changed, which
  the scenario does not assert.
- **Upstream merge tax.** `worker/index.ts` and `wrangler.jsonc` are upstream files the fork does
  not modify, so conflicts there should be rare; the hand-checked regions stay `supabase/*.sql`
  (policy bodies) and `CLAUDE.md`.
- **A deploy now needs two Cloudflare secrets set by hand** (`GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`) beside the three build-time `VITE_` vars. §5's second-operator check is
  unaffected: it needs no credential and does not deploy.

## Reconsider when

- A second `/api/*` route is proposed — a growing server surface needs its own decision.
- Runtime origin config lands: check the worker's `ours()` same-origin test still means what it says.

## Note on ADR-0006, alternative (b)

ADR-0006 rejected a Cloudflare Worker route for account provisioning partly because it "turns the
static-assets deploy into a server deploy". That half of the argument is overtaken by this ADR —
the deploy is a Worker deploy regardless. The substantive halves stand untouched: a Supabase
superuser credential would sit in a second vendor's secret store, and the privileged path could
not be exercised against the local stack. ADR-0006 §B is unaffected; its wording is left as
written, as ADR history.
