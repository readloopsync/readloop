import { Hono } from 'hono';
import type { DB } from '../db/db.js';
import { upsertProgress } from './kosync.js';
import { nowSeconds } from '../models/sync.js';
import type { AppEnv } from '../auth/middleware.js';

/**
 * Readloop-only internal endpoint. The Readloop OPDS server calls this at
 * download time to pre-seed a reading position — the Readwise `reading_progress`
 * keyed by the EPUB's KOReader document hash — so a freshly downloaded article
 * resumes on the device's first pull (before any device push / match exists).
 *
 * Guarded by a shared secret (READLOOP_SEED_SECRET); the route is inert if unset.
 * Progress is stored as a synthetic position (readloop:<ppm>), so the device maps
 * the percentage to a real position from its own copy of the EPUB.
 */
export function readloopRoutes(db: DB) {
  const app = new Hono<AppEnv>();
  const SECRET = process.env.READLOOP_SEED_SECRET;

  app.post('/seed-progress', async (c) => {
    if (!SECRET || c.req.header('x-readloop-seed') !== SECRET) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let body: { username?: unknown; document?: unknown; percentage?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'bad json' }, 400);
    }
    const { username, document, percentage } = body;
    if (typeof username !== 'string' || typeof document !== 'string' || typeof percentage !== 'number') {
      return c.json({ error: 'username, document, percentage required' }, 400);
    }
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as
      | { id: number }
      | undefined;
    if (!user) return c.json({ error: 'unknown user' }, 404);

    // Never clobber a real device position: only seed when we have nothing yet.
    const existing = db
      .prepare('SELECT 1 FROM progress WHERE user_id = ? AND document = ? LIMIT 1')
      .get(user.id, document);
    if (existing) return c.json({ ok: true, skipped: 'already has progress' });

    const pct = Math.max(0, Math.min(1, percentage));
    upsertProgress(db, {
      userId: user.id,
      document,
      deviceId: 'readloop',
      device: 'Readloop',
      percentage: pct,
      progress: `readloop:${Math.round(pct * 1_000_000)}`,
      position: null,
      updatedAt: nowSeconds(),
      metadata: null,
    });
    return c.json({ ok: true, seeded: pct });
  });

  return app;
}
