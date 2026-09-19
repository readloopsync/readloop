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

---

## Future (v3): progress fan-in — Readwise → device

Mirror image of v2 (which pushes *finished* → archive). Idea: when you've read part
of an article in Readwise, a freshly downloaded EPUB should open at that spot.

- **Feasible — the plumbing exists.** `crosspoint-sync` already does progress
  *fan-in* for Audiobookshelf (`refreshProgress`/`fanin.ts`): pull a percentage
  from an external service into the canonical store; the device picks it up on its
  next sync (which PULLs via `GET /syncs/progress/:document`).
- **Work:** make `readwise-reader` **read-capable** (currently write-only) and add
  a fan-in pull that reads each matched doc's `reading_progress` (0–1, from the
  Reader API) → returns an `InboundChange {percentage, finished}`.
- **Caveat — position precision:** KOSync resumes to a *real xpath position* in the
  specific EPUB, but Readwise only exposes a **percentage**. crosspoint-sync
  translates percentage→position from **samples harvested during prior device
  reads**, which don't exist for a never-opened download. So on first open you'd
  get the right *status/percentage*, but not necessarily an exact-line seek until
  the device has read it once.
- **Scope:** v3, after v2 (fan-out/archive) is validated on-device.

### v3 status (2026-09-19)
- ✅ **Phase 1 — pull mechanism built.** `readwise-reader` is now read-capable with `pullProgress()` (verified: pulled `0.6777` for a 68%-read doc). crosspoint-sync's periodic fan-in worker applies it to any **already-matched** doc → device picks it up on its next sync. So *cross-device* resume works: a doc the device has synced once, read further in the Readwise app, updates on the device.
- ⏳ **Phase 2 — first-open resume (the "read 50% in the app, download fresh, resume" case).** Needs a **match to exist before the first device push**, which means seeding it at **download time**:
  1. OPDS server computes the EPUB's **KOReader binary partial-MD5** (must exactly equal what the device computes — the key risk, verify on-device) and registers `{hash → readwise id}` (+ optionally the current progress) with crosspoint-sync.
  2. crosspoint-sync's on-GET refresh (`refresh.ts`) is currently **hard-coded to BookFusion** — generalize it (or rely on the 5-min worker) so the readwise-reader connector is refreshed on pull.
- **Caveat (both phases):** Readwise gives only a percentage; exact-line seek depends on a position sample from a prior device read (fresh downloads resume by percentage, not necessarily the exact line).

### Phase 2 hash de-risk — ✅ PASSED (2026-09-19)
Crosspoint computes the KOSync `document` (binary method) as a **KOReader-style partial-MD5** — `lib/KOReaderSync/KOReaderDocumentId.cpp`: read 1024-byte chunks at offsets `getOffset(i)` for `i = -1..10` (i<0 → 0; else `1024 << (2*i)` = `1024·4^i`), MD5 the concatenation. Replicated in Node and it produced the **exact device hash** for a freshly downloaded article (Oreos: `79c3f0ac…` == device). So the OPDS server can compute the device's hash from the bytes it serves.

Note: epub-gen stamps a random `dc:identifier` per build, so the same article regenerated hashes differently — **hash the exact bytes served** (at serve time), don't re-generate.

**Phase-2 build (revised, simplest path):**
1. In the Readwise provider's `content.epub` route, after building the file: compute `koHash(file)`, fetch the doc's `reading_progress`, and **seed a progress row** in crosspoint-sync keyed by that hash (percentage + a synthetic position; `device='readloop'`).
2. First-open `GET /syncs/progress/<hash>` returns it → device resumes. No fan-in/refresh.ts change needed.
3. Seeding mechanism (TBD): direct write to crosspoint-sync's SQLite (co-located; needs busy-timeout) vs. a small authenticated seed endpoint on crosspoint-sync. In rls-desktop both are one app so it's internal.

```js
// KOReader/Crosspoint binary document hash (verified against a real device hash)
function koHash(path){
  const crypto=require("crypto"), fs=require("fs");
  const CHUNK=1024, OFFSET_COUNT=12;
  const fd=fs.openSync(path,"r"), size=fs.fstatSync(fd).size, md5=crypto.createHash("md5"), buf=Buffer.alloc(CHUNK);
  for(let i=-1;i<OFFSET_COUNT-1;i++){ const off=i<0?0:CHUNK*(4**i); if(off>=size)continue;
    const n=fs.readSync(fd,buf,0,Math.min(CHUNK,size-off),off); if(n>0)md5.update(buf.subarray(0,n)); }
  fs.closeSync(fd); return md5.digest("hex");
}
```
