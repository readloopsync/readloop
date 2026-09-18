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

1. **KOReader document-hash map (recommended).** KOSync identifies each book by a **document hash** — KOReader's *partial-MD5* (MD5 of a few byte ranges of the file). Since *we* generate the EPUB, we compute that same hash at generation time and persist `{hash → readwise_id}` in a small shared store; the connector resolves the KOSync `document` field (the hash) → id. Exact, and independent of filename/title.
   - **To confirm:** that `crosspoint-sync`'s `document` field is KOReader's partial-MD5 (verify against its `kosync.ts`/`matching.ts`), and replicate that exact algorithm server-side.
   - **Shared store:** the OPDS server and `crosspoint-sync` are separate processes, so either a shared SQLite/JSON file or a tiny `GET /map?hash=` lookup the connector calls.
2. **Title match (fallback).** Crosspoint names downloads `<author/site> - <title>.epub` from the OPDS entry, and sends title/filename in KOSync `DocumentMeta`, so the connector can match by title against the Reader library. Fuzzy — titles can collide/differ — so gate on high confidence and prefer *not* archiving over archiving the wrong doc.

### ❌ Ruled out: filename-stamped id
Setting `Content-Disposition: filename="<title> [rw-<id>].epub"` does **not** work on Crosspoint: **confirmed on-device 2026-09-18**, Crosspoint ignores the header and names the file from the OPDS entry (`aresluna.org - One hundred and thirty-seven seconds – Aresluna.epub`), so the `[rw-<id>]` never reaches `DocumentMeta.filename`. (Matches upstream PR #2415 "keep server filename" — not default yet.) The `Content-Disposition` header is kept anyway: harmless on Crosspoint, and readers that honor it (Kobo/KOReader) get nicer filenames.

## Open questions — need on-device / crosspoint-sync validation (Jay + X3)
- ✅ Does Crosspoint save under the server-provided filename? **No** (confirmed 2026-09-18) — names by OPDS `<author> - <title>`. Filename-id ruled out; use the hash map.
- Is `crosspoint-sync`'s `document` field KOReader's partial-MD5, and can we replicate it exactly on the produced EPUB? (Gates the hash-map approach.)
- What `DocumentMeta` fields does Crosspoint's KOSync actually populate at the server (title? filename?) — for the fallback title match.
- Is **98%** reachable for short articles on the X3 (does finishing the last page cross the threshold)? If not, may need a per-connector threshold.
- Where will `crosspoint-sync` run — self-hosted alongside Readloop on the mini, or the hosted `sync.crosspointreader.com`? (Connector must be in the build that runs.)

## Recommended path
1. ~~Content-Disposition filename stamp~~ — shipped, but **on-device test (2026-09-18) showed Crosspoint ignores it** (see "Ruled out" above). Header kept for other readers. **Pivot to the KOReader-hash map (option 1 above).**
2. Confirm `crosspoint-sync`'s `document` = KOReader partial-MD5 (read its `kosync.ts`/`matching.ts`), and replicate that hash in the OPDS provider at EPUB-generation time → persist `{hash → readwise_id}`.
3. Self-host `crosspoint-sync` on the mini; add the `readwise-reader` connector (resolves hash → id via the shared map, title as fallback); point the X3's KOSync at it.
3. Validate on-device: read an article past 98% → confirm it archives in Readwise and drops out of the OPDS feed.
4. If solid, PR the connector to `crosspoint-sync` (they built the framework for exactly this — see their Hardcover/ABS connectors).

## Note
Supersedes the earlier plan's standalone `rls-kosync` repo: the connector belongs **inside `crosspoint-sync`**, so v2 is (a) a small Readwise-provider tweak here + (b) a connector PR to `crosspoint-sync`, not a new repo.
