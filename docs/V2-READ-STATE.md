# v2 — Read-state round-trip (finish on device → archive in Readwise)

Goal: when you finish an article on the X3, mark that Readwise **Reader** document archived/seen, so it leaves the OPDS feed automatically. This closes the loop (delivery out via OPDS, read-state back via KOSync).

## Key findings (from reading `crosspoint-reader/crosspoint-sync`)

`crosspoint-sync` is a KOSync server (TypeScript/Hono + SQLite) with a **connector framework** (`src/connectors/`). It already:
- Tracks per-document progress from KOSync and, in `fanout.ts`, **emits a `finished` event when `percentage >= 0.98`** (`src/connectors/fanout.ts:66,79`), else a `progress` event. Connectors that `carries: ['finished']` get these via `push()`.
- Ships connectors for Hardcover, Audiobookshelf, Micro.blog, BookFusion, and **Readwise**.

**But the existing `readwise.ts` connector is the wrong tool for v2:** it `carries: ['highlight']` only, is `hidden: true`, uses the *classic* Readwise API (`/api/v2/highlights`, `/export`), and explicitly makes progress/finished a **no-op**. It's for pushing/pulling *highlights*, not archiving Reader documents.

So v2 is a genuinely new, unbuilt capability — but it drops cleanly into the existing framework.

## Design: a `readwise-reader` connector

A new connector (distinct id from the highlights one) that carries `finished` and writes to the **Reader** API:

```ts
// crosspoint-sync/src/connectors/readwise-reader.ts (sketch)
const BASE = 'https://readwise.io/api/v3';

// match(): resolve the finished document -> a Reader document id.
// Preferred: our OPDS server stamps the id into the download filename
// (see "id-mapping" below); parse it back here. Fallback: title (unreliable).
async function match(cred, doc /* DocumentMeta */, _http): Promise<Match | null> {
  const id = readerIdFromFilename(doc.filename); // e.g. "... [rw-01m29306…].epub"
  if (id) return { externalId: id, fromSidecar: true, confidence: 1 };
  return doc.title ? { externalId: `title:${doc.title}`, confidence: 0.3 } : null;
}

async function push(cred, m /* Match */, ev /* OutboundEvent */, http): Promise<PushResult> {
  if (ev.kind !== 'finished') return { ok: true };        // only act on finish
  if (m.externalId.startsWith('title:')) return { ok: true }; // no exact id -> skip archiving
  const res = await http(`${BASE}/bulk_update/`, {
    method: 'PATCH',
    headers: { authorization: `Token ${tokenOf(cred)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ updates: [{ id: m.externalId, location: 'archive', seen: true }] }),
  });
  if (res.status === 401) return { ok: false, needsReauth: true, error: 'unauthorized' };
  if (res.status === 429 || res.status >= 500) return { ok: false, retryable: true };
  return { ok: res.status < 300 ? true : false };
}

export const readwiseReaderConnector: Connector = {
  id: 'readwise-reader',
  displayName: 'Readwise Reader (archive on finish)',
  tier: 1,
  capabilities: { read: false, write: true },
  carries: ['finished'],
  credentialKind: 'token',
  validate, // GET /api/v3/list/?limit=1
  match,
  push,
};
```
Register it in `src/connectors/registry.ts`. Idempotency: archiving an already-archived doc is harmless; the runner also de-dupes.

## The id-mapping problem (the crux)

The connector needs the finished book's **Reader document id**. Options, best first:

1. **Filename-stamped id (recommended, self-contained).** Our OPDS provider sets `Content-Disposition: attachment; filename="<title> [rw-<id>].epub"` on `content.epub`. If Crosspoint saves with the server filename, `DocumentMeta.filename` carries the id and `match()` parses it out — exact, no firmware sidecar needed.
   - **Companion change (our side):** add that header in `src/provider/readwise.ts`'s content route.
   - **Dependency:** Crosspoint must preserve the server-provided filename. There's upstream movement here (PR #2415 "OPDS - keep server filename"); needs confirming on-device.
2. **Sidecar exact id.** `crosspoint-sync` types already have `Match.fromSidecar` ("exact provider id supplied by the downloaded book's sidecar"). Cleaner but needs firmware to write/send a sidecar — more moving parts.
3. **Title match (fallback).** Unreliable for articles (titles collide/differ); use only to *not* archive (confidence too low), never to archive the wrong doc.

## Open questions — need on-device / crosspoint-sync validation (Jay + X3)
- Does Crosspoint save OPDS downloads under the **server-provided filename**? (Decides whether option 1 works.)
- What `DocumentMeta` fields does Crosspoint's KOSync actually populate at the server (filename? title?)?
- Is **98%** reachable for short articles on the X3 (does finishing the last page cross the threshold)? If not, may need a per-connector threshold.
- Where will `crosspoint-sync` run — self-hosted alongside Readloop on the mini, or the hosted `sync.crosspointreader.com`? (Connector must be in the build that runs.)

## Recommended path
1. Add `Content-Disposition` with `[rw-<id>]` to the Readwise provider (our repo; small, safe).
2. Self-host `crosspoint-sync` on the mini; add the `readwise-reader` connector; point the X3's KOSync at it.
3. Validate on-device: read an article past 98% → confirm it archives in Readwise and drops out of the OPDS feed.
4. If solid, PR the connector to `crosspoint-sync` (they built the framework for exactly this — see their Hardcover/ABS connectors).

## Note
Supersedes the earlier plan's standalone `rls-kosync` repo: the connector belongs **inside `crosspoint-sync`**, so v2 is (a) a small Readwise-provider tweak here + (b) a connector PR to `crosspoint-sync`, not a new repo.
