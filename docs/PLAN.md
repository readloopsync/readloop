# Readloop — Plan

## Progress log
- **2026-09-17** — Org `readloopsync` created; hub repo `readloopsync/readloop` live (MIT).
  `news2reader` forked to `readloopsync/news2reader`.
  **Phase 1 (delivery) first cut done** on branch `readwise-source`:
  a Readwise Reader provider (`src/provider/readwise.ts`) exposing feeds by
  location and building EPUBs from `html_content`; `htmlToEpub()` and a generic
  OPDS acquisition entry added. Builds on Node 22; smoke-tested without/with a
  (dummy) token — catalog gating, OPDS XML, auth header, and error handling all
  verified. **Still needed:** validate real data + EPUB rendering with a live
  `READWISE_TOKEN`, then on an actual X3. See `deploy/docker-compose.yml` for the
  drop-in-token run path, and `docs/DEV-NOTES.md` for the Node 22 toolchain gotcha.
  Not yet opened as an upstream PR (pending live validation + maintainer coordination).

## Goal
Deliver a Readwise (Reader) library to Crosspoint e-readers (and any OPDS/KOSync device) as EPUBs, and reflect real reading progress back to Readwise as read-state — packaged so homelab, NAS, and non-technical desktop users can all run it.

## The two halves
- **Delivery (in):** Readwise API → HTML→EPUB → **OPDS** catalog the device pulls. → contribute a **Readwise source to `news2reader`** (Node/TS, MIT).
- **Read-state (out):** device reading progress → **KOSync** → mark the Readwise doc archived/seen. → contribute a **Readwise connector to `crosspoint-sync`** (existing extensible KOSync server, MIT).

## Locked decisions
- Server code lands **upstream in `news2reader`**, not a standalone server repo. MIT throughout. Bring-your-own token, store nothing, no telemetry.
- Three run layers over one server: portable Node server → single binary (Bun `compile` / `pkg`) → **Tauri v2 menu-bar app** (scaffolded from `ahkohd/tauri-macos-menubar-app-example` `v2-popover`; macOS/Windows/Linux from one codebase).
- Distribution: **multi-arch Docker primary**; binary/npx secondary; launchd/systemd as sample units. Homebrew Cask (Mac) + winget (Windows); signing deferred until traction.
- Network: X3 is ESP32-C3 = plain HTTP-over-Wi-Fi client, no Tailscale. **LAN-first**, zero-auth on private net; remote = separate expose-with-auth problem (nginx+domain or tunnel; optional OPDS basic-auth; `opds-proxy` as a fallback front-end if Crosspoint's OPDS auth is fussy).
- Readwise: `GET /api/v3/list/?withHtmlContent=true` (bearer, **20/min**, paginate+cache) in; `PATCH /api/v3/bulk_update/` (`location`, `seen`, ≤50/req) out.

## Open questions
1. `news2reader`'s source interface — clone and read it (drives adapter shape).
2. Does Crosspoint's native OPDS client support basic auth? (Decides remote-access design / whether `opds-proxy` is needed.)
3. Is Readwise's `html_content` already clean reader-mode HTML? (If so, skip re-running Readability.)
4. Grouping: one EPUB per article (best for OPDS browsing) vs. tag/date bundles — likely configurable.
5. What does `crosspoint-sync`'s extended API expose? (Decides id-mapping path 1 vs 2 below.)
6. Signing budget: Homebrew Cask/winget + unsigned first, or buy Developer ID / Authenticode.

---

## TRACK A — Delivery (v1)

### Phase 0 — De-risk spike (½ day)
Run `readwise-epub` against a token → sideload EPUBs to the X3 via WebDAV/Calibre; confirm rendering. Point the X3's OPDS client at a test feed; confirm browse/download and **observe auth handling**. *Exit:* Readwise→EPUB→X3 chain proven.

### Phase 1 — Readwise source, upstreamed to news2reader
- Fork/clone; read the existing source-module interface (HN/Tildes/Karakeep/Pocket).
- Adapter: list + `withHtmlContent`, rate-limit-aware paging + cache, filters (`tags`, `location`), configurable grouping (per-article default); map → OPDS entries → EPUB.
- **Bake in the mapping hook now (cheap, enables v2):** stamp every generated EPUB with a stable identifier — OPF `<dc:identifier>` = `readwise:<doc_id>` (and encode in filename). This is what Track B maps against.
- **Optional mark-on-download toggle** (default *off*, or "move to a location" not `archive`): on serve, `bulk_update` the doc. Honest label: "downloaded ≠ read."
- Config via env (`READWISE_TOKEN`, filters, grouping, optional OPDS basic-auth); tests; PR; coordinate with maintainer.

### Phase 2 — Single-binary build
Bun/`pkg` per-arch binaries in CI → the no-Docker run mode *and* the desktop app's sidecar. Ship sample launchd/systemd units.

### Phase 3 — Docker (mostly docs)
Confirm the existing multi-arch image serves the Readwise source; headline README = 5-line compose + env table.

### Phase 4 — Tauri menu-bar app (`rls-desktop`)
Scaffold from `ahkohd` `v2-popover`; embed the Phase-2 binary as a `sidecar`. UI: Readwise token, **OPDS URL**, **QR code**, start/stop, start-at-login. Build Mac/Win/Linux.

### Phase 5 — Distribution & signing
Homebrew Cask (Mac) + winget (Windows); document unsigned "run anyway"; Developer ID / Authenticode only if traction. Release CI: Actions `buildx` + Tauri action.

### Phase 6 — Docs & v1 launch
Quickstarts (Docker always-on / app no-Terminal / binary); Crosspoint OPDS setup guide (URL / scan QR); announce in Crosspoint discussion #257.

---

## TRACK B — Read-state round-trip (v2)

### Phase 7 — Readwise connector for `crosspoint-sync` (`rls-kosync`)
The device already speaks KOSync; `crosspoint-sync` already relays reading state to external services (Hardcover, Audiobookshelf, Micro.blog). Add Readwise as a connector.

- **Trigger:** on a KOSync progress update, when `reading_progress ≥` a configurable threshold (~95–100%), `PATCH /api/v3/bulk_update/` → `{location: "archive", seen: true}` for the mapped doc. Also auto-cleans the OPDS feed (archived items leave `new`/`later`).
- **Idempotency:** track already-marked docs so progress pings don't re-write; batch up to 50/req.
- **Config:** per-user Readwise token on the sync server, threshold, and target location (`archive` vs a custom "read" location).

### The id-mapping (spelled out)
The two halves are separate processes, so they share a document identity the reader reports.

1. **Preferred — read our embedded id directly.** If `crosspoint-sync`'s extended API surfaces the EPUB's `<dc:identifier>`, the connector reads `readwise:<doc_id>` straight off it — no hashing, no shared state.
2. **Fallback — shared hash map.** KOSync keys books by KOReader's document hash (partial-MD5 of file chunks). At EPUB-generation time the OPDS source computes the same partial-MD5 and writes `{partial_md5 → readwise_doc_id}` to a small shared store (sqlite/JSON, or the source exposes `GET /map?hash=`). The connector resolves hash → doc id per update.

Because Phase 1 stamps `readwise:<doc_id>` into every EPUB, path (1) is likely free and (2) is a safe backup.

### Phase 8 — App + docs for read-state
Desktop app surfaces the read-state toggle, threshold, and sync-server URL; docs describe the full round-trip and `crosspoint-sync` setup. Announce the connector to the Crosspoint community (discussion #61 lineage).

---

## Repositories (org: `readloopsync`)
Sibling repos use the `rls-` prefix (ReadLoopSync) for brevity.
- **`readloopsync/readloop`** — project hub / docs (this repo).
- **Fork of `news2reader`** — Readwise *source* + EPUB id-stamping (MIT).
- **`rls-desktop`** — Tauri app (MIT).
- **`rls-kosync`** — Readwise *connector* for `crosspoint-sync` (MIT).

## Dependency order
Phase 0 gates all. Track A is linear (1→2→4; 3 rides on 1; 5–6 close v1). Track B starts after Phase 1 (needs id-stamping + delivered EPUBs); Phase 7 is independent of the app, so it can run in parallel with 4–6.

## References
- Crosspoint firmware — https://github.com/crosspoint-reader/crosspoint-reader
- Crosspoint plugin/Readwise discussion #257 — https://github.com/crosspoint-reader/crosspoint-reader/discussions/257
- Crosspoint KOSync discussion #61 — https://github.com/crosspoint-reader/crosspoint-reader/discussions/61
- `crosspoint-sync` (KOSync server) — https://github.com/crosspoint-reader/crosspoint-sync
- `news2reader` (upstream) — https://github.com/BHSPitMonkey/news2reader
- Readwise Reader API — https://readwise.io/reader_api
- Tauri menu-bar example — https://github.com/ahkohd/tauri-macos-menubar-app-example
