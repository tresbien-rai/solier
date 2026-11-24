/**
 * Migration 017 — Aux-model expression picking (Option B)
 *
 * Adds `settings.aux_expressions` (INTEGER, default 0): when enabled (and an
 * aux model with an API key is configured), expression instructions are omitted
 * from the main model's system prompt and the aux model picks the avatar pose
 * after each reply.
 *
 * Defaults OFF so existing behavior (main-model `[expression: name]` tags) is
 * unchanged until the user opts in.
 *
 * Idempotent: guarded by table + column existence (mirrors migration 013).
 */

/** @param {import('better-sqlite3').Database} db @param {string} table */
function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((col) => col.name === column);
}

/** @param {import('better-sqlite3').Database} db @param {string} table */
function hasTable(db, table) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
}

/** @param {import('better-sqlite3').Database} db */
function up(db) {
  if (!hasTable(db, 'settings')) return;
  if (!hasColumn(db, 'settings', 'aux_expressions')) {
    db.exec(`ALTER TABLE settings ADD COLUMN aux_expressions INTEGER DEFAULT 0`);
  }
}

module.exports = { up };
