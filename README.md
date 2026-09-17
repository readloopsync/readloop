# Readloop

**Put your [Readwise Reader](https://readwise.io/read) library on an e-ink reader — and get read‑state back.**

Readloop bridges Readwise Reader and [Crosspoint](https://github.com/crosspoint-reader/crosspoint-reader)-flashed e-readers (Xteink X3/X4) — and any [OPDS](https://en.wikipedia.org/wiki/OPDS)/[KOReader](https://koreader.rocks/) device. Your saved articles are served as EPUBs over an OPDS catalog your reader browses over Wi‑Fi; when you finish an article, your reading progress loops back and archives it in Readwise.

It's a **loop**: articles flow *out* to the reader, read‑state flows *back* to Readwise.

> Status: 🚧 early. Planning complete; building. Readloop is an independent open-source project and is not affiliated with or endorsed by Readwise or Xteink.

## Why

Crosspoint has no native Readwise app, and putting one on the device isn't practical (it's an ESP32‑C3 microcontroller — no room for a Readwise client or a VPN). But Crosspoint *does* speak two open protocols we can meet it with:

- **OPDS** — browse & download a catalog of books/articles over the network.
- **KOReader sync (KOSync)** — report reading progress to a self-hosted server.

Readloop lives on the network side and speaks both, so the reader needs nothing special installed.

## How it works

```
                 ┌────────────── Readloop ──────────────┐
 Readwise  ──►   │  OPDS catalog  +  HTML→EPUB           │  ──►  Crosspoint e-reader
 Reader API      │  (delivery)                           │       (browse & download over Wi-Fi)
                 │                                        │
 Readwise  ◄──   │  KOSync connector                     │  ◄──  reading progress (KOSync)
 (archive/seen)  │  (read-state)                         │
                 └────────────────────────────────────────┘
```

**Delivery (in):** query the Readwise Reader API (`/api/v3/list?withHtmlContent=true`), convert each document's HTML to a clean EPUB, and expose it all as an OPDS catalog the reader pulls from.

**Read-state (out):** the reader reports progress via KOSync; when a document is finished, Readloop marks it archived/seen in Readwise (`/api/v3/bulk_update`) — which also keeps the OPDS feed clean automatically.

## Components

Readloop is delivered in layers over one server, so it fits homelab, NAS, and no‑Terminal desktop users alike:

| Component | What | Where |
|-----------|------|-------|
| **Readwise OPDS source** | The delivery half — contributed upstream as a new source in [`news2reader`](https://github.com/BHSPitMonkey/news2reader) (MIT), which already does OPDS + on‑the‑fly EPUB. | fork → upstream PR |
| **`rls-kosync`** | The read-state half — a Readwise connector for [`crosspoint-sync`](https://github.com/crosspoint-reader/crosspoint-sync) (a self-hostable KOSync server with pluggable service connectors). | this org |
| **`rls-desktop`** | A cross-platform menu‑bar/tray app (Tauri) that runs the server for people who don't want Docker — paste your token, get an OPDS URL + QR to point the reader at. | this org |

<sub>Sibling repos use the `rls-` prefix (ReadLoopSync) to stay short and avoid repeating the org name.</sub>

**Distribution:** multi-arch Docker image (primary, for self-hosters) · single binary / `npx` (no‑Docker) · desktop app via Homebrew Cask / winget. Bring your own Readwise token; Readloop stores nothing and phones home to no one.

## Roadmap

- **v1 — Delivery:** Readwise source upstreamed to `news2reader`; Docker + binary; desktop app; docs.
- **v2 — Read-state round-trip:** `readloop-sync` Readwise connector; true "finished → archived" via real reading progress.

The full plan lives in [`docs/PLAN.md`](docs/PLAN.md).

## License

[MIT](LICENSE) — matching `news2reader`, our upstream.
