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

The connector needs the finished book's **Reader document id**. After reading `crosspoint-sync`'s code, the mechanism is settled:

**Title/author metadata match (this is how the framework actually works).** `crosspoint-sync` treats the KOSync `document` value as an **opaque hash** — it does *not* recompute it from the file — and matches books by **title/author the firmware sends** in the progress `metadata` (see its `connectors/matching.ts`: "the EPUB's own title/author … is the real signal"). So the connector builds a candidate pool from the non-archived Reader locations and runs the framework's `decideMatch()` against the finished doc's title/author.

**Why this is near-exact for us (not fuzzy):** Readloop authors each EPUB's `dc:title` to equal the Readwise article title verbatim, so the title the firmware extracts equals the Reader document's title. We still gate at a high confidence threshold (0.85) so a collision never archives the wrong doc.

✅ **The connector is written and typechecks** against crosspoint-sync's real types — see [`proposals/crosspoint-sync/`](../proposals/crosspoint-sync/) (`readwise-reader.ts` + notes).

*(The earlier "compute a KOReader partial-MD5 hash map" idea is dropped: the server never sees the file and treats the hash as opaque, so it isn't the framework's path. A hash map would only be a fallback if Crosspoint turns out not to send title metadata over KOSync — see open questions.)*

### ❌ Ruled out: filename-stamped id
Setting `Content-Disposition: filename="<title> [rw-<id>].epub"` does **not** work on Crosspoint: **confirmed on-device 2026-09-18**, Crosspoint ignores the header and names the file from the OPDS entry (`aresluna.org - One hundred and thirty-seven seconds – Aresluna.epub`), so the `[rw-<id>]` never reaches `DocumentMeta.filename`. (Matches upstream PR #2415 "keep server filename" — not default yet.) The `Content-Disposition` header is kept anyway: harmless on Crosspoint, and readers that honor it (Kobo/KOReader) get nicer filenames.

## Open questions — need on-device / crosspoint-sync validation (Jay + X3)
- ✅ Does Crosspoint save under the server filename? **No** (2026-09-18) — names by OPDS `<author> - <title>`; filename-id ruled out.
- ✅ How does the connector map finished→Reader doc? **Title/author metadata match** — connector written and typechecks (`proposals/crosspoint-sync/`).
- **THE gating unknown:** does Crosspoint's KOSync actually **send title/author metadata** in the progress call? crosspoint-sync's matching assumes the firmware does; confirm on-device. If it doesn't, we'd need a document-hash map (needs Crosspoint's exact hash algorithm) instead.
- Is **98%** reachable for short articles on the X3 (does finishing the last page cross `fanout.ts`'s threshold)? If not, may need a per-connector threshold.
- Where will `crosspoint-sync` run — self-hosted on the mini, or the hosted `sync.crosspointreader.com`? (The connector must be in the build that runs; self-host is needed to add our connector.)

## Recommended path
1. ✅ Connector written + typechecks (`proposals/crosspoint-sync/readwise-reader.ts`).
2. Self-host `crosspoint-sync` on the mini; drop in the connector + register it.
3. Point the X3's KOSync at it (Settings → System → KOReader Sync). **First: verify the progress call carries title metadata** (server logs / DocumentMeta) — that gates the whole approach.
4. Read an article past 98% → confirm it archives in Readwise and leaves the OPDS feed.
5. If solid, PR the connector to `crosspoint-sync`.
3. Validate on-device: read an article past 98% → confirm it archives in Readwise and drops out of the OPDS feed.
4. If solid, PR the connector to `crosspoint-sync` (they built the framework for exactly this — see their Hardcover/ABS connectors).

## Note
Supersedes the earlier plan's standalone `rls-kosync` repo: the connector belongs **inside `crosspoint-sync`**, so v2 is (a) a small Readwise-provider tweak here + (b) a connector PR to `crosspoint-sync`, not a new repo.
