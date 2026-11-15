-- Public visitor reviews (published at once; the admin can hide, show or delete them).
-- Apply with: npx wrangler d1 migrations apply <your-db-name> --remote

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text TEXT NOT NULL,
  page TEXT NOT NULL DEFAULT '/',
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_status_idx ON reviews (status, id DESC);
