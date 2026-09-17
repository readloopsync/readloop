# Dev notes

## Node toolchain (news2reader fork)

`news2reader` uses **Yarn 4 with Plug'n'Play (PnP)** and pins **Node 22** (`.nvmrc` = v22.2.0).

- **Node 25 breaks the build/run.** Node 25's experimental ESM loader throws
  `EBADF: bad file descriptor, fstat` when Yarn's PnP `.pnp.loader.mjs` runs
  (both `yarn build` / tsc and `yarn start`). Use Node 22.
- On this Mac, the Homebrew `node@22` keg was broken at the time
  (`Library not loaded: .../libsimdjson.30.dylib` after a simdjson upgrade).
  Workaround used: a standalone Node 22 tarball from nodejs.org, run without
  touching system packages. `brew reinstall node@22` would likely also fix it.
- Running the server directly as `node dist/server.js` fails with
  `Cannot find package 'express'` because PnP isn't active — always go through
  Yarn: `yarn start` (or `yarn node dist/server.js`).

**Simplest path that avoids all of the above: run it in Docker** (see
`deploy/docker-compose.yml`) — the image uses `node:22` and handles Yarn itself.

## Readwise provider (fork branch `readwise-source`)

- Provider: `src/provider/readwise.ts`. Auth header is `Authorization: Token <token>`
  (not `Bearer`). Endpoint: `GET /api/v3/list/` (20 req/min per token).
- Catalog listing uses `withHtmlContent=false` (metadata only); the full
  `html_content` is fetched lazily per document at download time and cached to
  disk, to stay within the rate limit.
- EPUBs are built from `html_content` via `htmlToEpub()` in `src/epub.ts`
  (no re-fetch / Readability), so paywalled and newsletter content survives.
- `epub-gen` 0.1.0 can't set the OPF `dc:identifier`, so the Readwise doc id is
  carried in the OPDS entry `<id>` (`readwise:<doc_id>`) and the EPUB filename.
  Revisit if the v2 KOSync id-mapping needs an in-file identifier.
