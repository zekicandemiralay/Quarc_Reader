const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Everything this app stores lives under DATA_DIR (one Docker volume): the
// SQLite database, and the uploaded PDFs in files/<user>/<sha256>.
const DATA_DIR = () => process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = () => process.env.DB_PATH || path.join(DATA_DIR(), 'reader.db');

// Millisecond-precision UTC timestamp, e.g. "2026-11-22 12:00:00.123" — the
// same format (and the same reasons) as Quarc Notes: pulls use an inclusive
// bound on it, so two writes in the same second can never slip through.
const NOW = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

let db;

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  return database;
}

function getDb() {
  if (!db) db = open(DB_PATH());
  return db;
}

// For tests: point at a fresh database file.
function resetDbForTests(file) {
  if (db) db.close();
  process.env.DB_PATH = file;
  db = open(file);
  return db;
}

function initDb() {
  const database = getDb();
  database.exec(`
    -- One row per document in a user's library. Only documents the user chose
    -- to sync ever reach this table: "local only" documents stay on the device.
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'Untitled',
      author TEXT,
      kind TEXT NOT NULL DEFAULT 'pdf',
      file_sha256 TEXT,            -- the file readers open (may be set before its upload finishes)
      file_size INTEGER,
      orig_sha256 TEXT,            -- the file before "replace original" — a safety net to revert to
      page_count INTEGER NOT NULL DEFAULT 0,
      sizes_json TEXT NOT NULL DEFAULT '[]',   -- run-length [[count, w, h], ...] in PDF points
      layout_json TEXT,                        -- NULL = the PDF's pages in order; else the page list incl. note pages
      thumb TEXT,                              -- small JPEG data URL of the cover
      progress_json TEXT,                      -- { page, offset, pct }
      progress_at TEXT,                        -- device clock; last writer wins
      bookmarks_json TEXT NOT NULL DEFAULT '[]',
      settings_json TEXT NOT NULL DEFAULT '{}',
      is_favorite INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_client_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_documents_user_updated ON documents(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents(user_id, file_sha256);

    -- What a person drew / highlighted / noted on one page of a document.
    -- page_key is 'p<index>' for a PDF page or 'n<id>' for an inserted note
    -- page, so reordering or inserting pages never moves anyone's ink.
    CREATE TABLE IF NOT EXISTS annotations (
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      page_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      ink_json TEXT NOT NULL DEFAULT '{"elements":[]}',   -- Excalidraw elements, page-local coordinates
      marks_json TEXT NOT NULL DEFAULT '[]',              -- text highlights / underlines / sticky notes
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      content_updated_at TEXT NOT NULL,
      last_client_id TEXT,
      PRIMARY KEY (doc_id, page_key)
    );
    CREATE INDEX IF NOT EXISTS idx_annotations_user_updated ON annotations(user_id, updated_at);

    -- Documents deleted forever: other devices drop their copy on the next
    -- pull, and a device that was offline can't resurrect them.
    CREATE TABLE IF NOT EXISTS deleted_documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deleted_documents_user ON deleted_documents(user_id, deleted_at);

    -- Uploaded files, per user (never shared between users: that would let one
    -- user claim another's file just by knowing its hash).
    CREATE TABLE IF NOT EXISTS files (
      user_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, sha256)
    );

    -- Share links: anyone who can reach the server and has the token can read.
    CREATE TABLE IF NOT EXISTS shares (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      include_annotations INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      views INTEGER NOT NULL DEFAULT 0,
      last_viewed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_shares_doc ON shares(doc_id);
    CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
  `);
}

module.exports = { getDb, initDb, resetDbForTests, DATA_DIR, NOW };
