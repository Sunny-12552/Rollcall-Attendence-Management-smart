import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runAdminReset } from '../scripts/reset-main-admin.js';

const bootstrapSecret = 'test-bootstrap-secret-that-is-at-least-32-characters';

function createDatabase(t, { eligible = true, assigned = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-admin-reset-'));
  const databasePath = path.join(directory, 'attendance.sqlite');
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE admins (
      id TEXT PRIMARY KEY,
      password_hash TEXT,
      is_verified INTEGER NOT NULL,
      is_active INTEGER NOT NULL,
      approval_status TEXT NOT NULL,
      removed_at TEXT
    );
    CREATE TABLE main_admin_config (
      singleton INTEGER PRIMARY KEY,
      admin_id TEXT REFERENCES admins(id),
      created_at TEXT
    );
    CREATE TABLE admin_audit_log (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES admins(id),
      action TEXT NOT NULL
    );
    CREATE TABLE device_registry (id TEXT PRIMARY KEY, student_key TEXT);
    CREATE TABLE attendance (id TEXT PRIMARY KEY, student_id TEXT NOT NULL);
  `);
  db.prepare(`
    INSERT INTO admins (id, password_hash, is_verified, is_active, approval_status)
    VALUES ('admin-1', 'unchanged-hash', ?, ?, 'approved')
  `).run(eligible ? 1 : 0, eligible ? 1 : 0);
  db.prepare(`
    INSERT INTO main_admin_config (singleton, admin_id, created_at)
    VALUES (1, ?, '2024-01-01T00:00:00.000Z')
  `).run(assigned ? 'admin-1' : null);
  db.prepare("INSERT INTO admin_audit_log VALUES ('audit-1', 'admin-1', 'admin_login')").run();
  db.prepare("INSERT INTO device_registry VALUES ('device-1', 'student-1')").run();
  db.prepare("INSERT INTO attendance VALUES ('attendance-1', 'student-1')").run();
  db.close();

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return databasePath;
}

function run(databasePath, options = {}) {
  return runAdminReset({
    databasePath,
    configuredSecret: bootstrapSecret,
    suppliedSecret: bootstrapSecret,
    ...options
  });
}

test('admin reset rejects missing or incorrect bootstrap authorization without changing data', async (t) => {
  const databasePath = createDatabase(t);
  await assert.rejects(runAdminReset({
    databasePath,
    configuredSecret: bootstrapSecret,
    suppliedSecret: 'wrong-bootstrap-secret'
  }), /Authorization failed/);
  const db = new Database(databasePath);
  assert.equal(db.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get().admin_id, 'admin-1');
  db.close();
});

test('admin reset dry-run reports impact and leaves all records unchanged', async (t) => {
  const databasePath = createDatabase(t);
  const result = await run(databasePath);
  assert.equal(result.changed, false);
  assert.equal(result.counts.admins, 1);
  assert.equal(result.counts.audit, 1);
  assert.equal(result.counts.deviceRegistry, 1);
  assert.equal(result.eligibleClaimants, 1);
  const db = new Database(databasePath);
  assert.equal(db.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get().admin_id, 'admin-1');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attendance').get().count, 1);
  db.close();
});

test('admin reset can create a verified standalone backup without making changes', async (t) => {
  const databasePath = createDatabase(t);
  const result = await run(databasePath, { backupOnly: true });
  assert.equal(result.changed, false);
  assert.ok(fs.existsSync(result.backupPath));
  const backup = new Database(result.backupPath);
  assert.equal(backup.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get().admin_id, 'admin-1');
  backup.close();
  const db = new Database(databasePath);
  assert.equal(db.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get().admin_id, 'admin-1');
  db.close();
});

test('admin reset refuses to remove the assignment when no eligible claimant exists', async (t) => {
  const databasePath = createDatabase(t, { eligible: false });
  await assert.rejects(run(databasePath, { apply: true }), /No verified, active, approved admin/);
  const db = new Database(databasePath);
  assert.equal(db.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get().admin_id, 'admin-1');
  db.close();
});

test('authorized admin reset backs up the database and preserves unrelated/admin history', async (t) => {
  const databasePath = createDatabase(t);
  const result = await run(databasePath, { apply: true });
  assert.equal(result.changed, true);
  assert.ok(fs.existsSync(result.backupPath));

  const backup = new Database(result.backupPath);
  assert.equal(backup.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get().admin_id, 'admin-1');
  backup.close();

  const db = new Database(databasePath);
  assert.equal(db.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get().admin_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admins').get().count, 1);
  assert.equal(db.prepare('SELECT password_hash FROM admins WHERE id = ?').get('admin-1').password_hash, 'unchanged-hash');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM device_registry').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attendance').get().count, 1);
  db.close();

  const repeated = await run(databasePath, { apply: true });
  assert.equal(repeated.changed, false, 'repeating the reset is a safe no-op');
  assert.match(repeated.message, /no reset is needed/i);
});

test('admin reset fails safely on databases with foreign-key violations', async (t) => {
  const databasePath = createDatabase(t);
  const db = new Database(databasePath);
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO admin_audit_log VALUES (?, ?, ?)").run(crypto.randomUUID(), 'missing-admin', 'legacy');
  db.close();
  await assert.rejects(run(databasePath), /foreign-key violations/);
});
