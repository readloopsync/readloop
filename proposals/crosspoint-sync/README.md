# Proposal: `readwise-reader` connector for crosspoint-sync

`readwise-reader.ts` is a drop-in connector for
[`crosspoint-reader/crosspoint-sync`](https://github.com/crosspoint-reader/crosspoint-sync)
that closes the Readloop loop: **when a document is finished on the device
(KOSync `finished` event, fired at ≥98% by the sync server), it archives the
matching Readwise Reader document** (`PATCH /api/v3/bulk_update/` →
`{location: "archive", seen: true}`), which also drops it out of the OPDS feed.

It's separate from crosspoint-sync's existing `readwise.ts` connector, which is
highlights-only (classic `/api/v2`) and `hidden`. This one carries `finished`
and uses the Reader API v3.

## How matching works
crosspoint-sync treats the KOSync `document` value as an **opaque hash** and
matches books by **title/author metadata** the firmware sends (see its
`connectors/matching.ts`). This connector uses that path: it builds a candidate
pool from the non-archived Reader locations (new/later/shortlist/feed) and runs
the framework's `decideMatch()` against the finished doc's title/author, gated at
a high threshold (0.85).

**Why the match is reliable here:** Readloop authors each EPUB's `dc:title` to be
the Readwise article title verbatim, so the title the firmware extracts matches
the Reader document's title near-exactly. (The earlier idea of stamping the id
into the download filename is dead — Crosspoint ignores `Content-Disposition`;
confirmed on-device 2026-09-18.)

## Status
- **Typechecks** cleanly against crosspoint-sync's current `src/connectors/types.ts`
  (`npx tsc --noEmit` passes with it added).
- To wire in: drop the file at `src/connectors/readwise-reader.ts` and add it to
  `src/connectors/registry.ts` (import + push into the `CONNECTORS` array).

## Still needs on-device validation (Jay + X3) before a PR to crosspoint-sync
1. **Does Crosspoint's KOSync send title/author metadata** in the progress call?
   (The whole metadata-match path depends on it. If not, fall back to a
   document-hash map — but that needs Crosspoint's exact hash algorithm.)
2. **Is ≥98% reachable** for short articles on the X3 (does the last page cross
   the `finished` threshold in `fanout.ts`)?
3. Endpoints/fields marked `LIVE-VERIFY GATE` in the connector (Reader v3
   `list`/`bulk_update` shapes; 207 partial-failure handling).
4. Where crosspoint-sync runs (self-host on the mini vs hosted).

## `readloop-route.ts` (v3 first-open resume)
Also in this folder: the internal seed endpoint added to crosspoint-sync for v3.
- Drop at `src/routes/readloop.ts`; wire in `app.ts`: `app.route('/readloop', readloopRoutes(db))`.
- Env: `READLOOP_SEED_SECRET` (shared with the OPDS server). Inert if unset.
- The OPDS server (news2reader) computes the EPUB's KOReader hash at download and
  POSTs `{username, document: hash, percentage}` to `/readloop/seed-progress`;
  the device's first pull then returns it → resume. Also made `fanout.ts`'s finish
  threshold env-configurable (`FINISHED_THRESHOLD`) and added request/error logging.
