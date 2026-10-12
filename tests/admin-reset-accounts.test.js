import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runAdminAccountsReset } from '../scripts/reset-admin-accounts.js';

const bootstrapSecret = 'test-bootstrap-secret-that-is-at-least-32-characters';

function createDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-admin-accounts-reset-'));
  const databasePath = path.join(directory, 'attendance.sqlite');
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE admins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      password_hash TEXT,
      is_verified INTEGER NOT NULL,
      is_active INTEGER NOT NULL,
      approval_status TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      last_login TEXT,
      last_successful_login TEXT,
      last_password_change_at TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      account_lock_until INTEGER,
      last_status_change_at TEXT,
      updated_at TEXT NOT NULL,
      removed_at TEXT
    );
    CREATE TABLE main_admin_config (
      singleton INTEGER PRIMARY KEY,
      admin_id TEXT UNIQUE REFERENCES admins(id),
      created_at TEXT
    );
    CREATE TABLE otp_verifications (id TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id));
    CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id));
    CREATE TABLE admin_subject_assignments (
      admin_id TEXT NOT NULL REFERENCES admins(id),
      subject TEXT NOT NULL,
      assigned_by TEXT REFERENCES admins(id),
      PRIMARY KEY (admin_id, subject)
    );
    CREATE TABLE admin_audit_log (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES admins(id),
      target_admin_id TEXT,
      affected_record TEXT NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE TABLE admin_access_requests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL,
      rejection_reason TEXT,
      invite_admin_id TEXT REFERENCES admins(id),
      reviewed_by TEXT REFERENCES admins(id)
    );
    CREATE TABLE device_registry (id TEXT PRIMARY KEY);
    CREATE TABLE legacy_student_device_locks (student_key TEXT PRIMARY KEY);
    CREATE TABLE attendance (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, value TEXT);
    CREATE TABLE students (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE subjects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE unrelated_records (id TEXT PRIMARY KEY, value TEXT NOT NULL);

    INSERT INTO admins (
      id, name, email, phone, password_hash, is_verified, is_active, approval_status,
      must_change_password, last_login, last_successful_login, last_password_change_at,
      failed_login_attempts, account_lock_until, updated_at
    ) VALUES
      ('admin-a', 'Existing Main Admin', 'main@example.test', '+14155550101', 'hash-a', 1, 1, 'approved',
       0, 'login-a', 'success-a', 'password-a', 2, 9999999999999, 'updated-a'),
      ('admin-b', 'Pending Admin', 'pending@example.test', '+14155550102', 'hash-b', 0, 0, 'pending',
       0, NULL, NULL, NULL, 0, NULL, 'updated-b');
    INSERT INTO main_admin_config VALUES (1, 'admin-a', 'created');
    INSERT INTO otp_verifications VALUES ('otp-a', 'admin-a');
    INSERT INTO auth_sessions VALUES ('session-a', 'admin-a');
    INSERT INTO admin_subject_assignments VALUES ('admin-a', 'Math', 'admin-b');
    INSERT INTO admin_audit_log VALUES ('audit-a', 'admin-a', 'admin-b', 'pending@example.test', 'Updated pending@example.test');
    INSERT INTO admin_access_requests VALUES ('request-a', 'Pending Admin', 'pending@example.test', 'pending', NULL, 'admin-b', 'admin-a');
    INSERT INTO device_registry VALUES ('device-a');
    INSERT INTO legacy_student_device_locks VALUES ('student-key-a');
    INSERT INTO attendance VALUES ('attendance-a', 'student-a', 'present');
    INSERT INTO students VALUES ('student-a', 'Student One');
    INSERT INTO subjects VALUES ('subject-a', 'Math');
    INSERT INTO unrelated_records VALUES ('unrelated-a', 'unchanged');
  `);
  db.close();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return databasePath;
}

function run(databasePath, options = {}) {
  return runAdminAccountsReset({
    databasePath,
    configuredSecret: bootstrapSecret,
    suppliedSecret: bootstrapSecret,
    ...options
  });
}

test('admin-account reset requires bootstrap-secret authorization and never changes data on denial', async (t) => {
  const databasePath = createDatabase(t);
  await assert.rejects(runAdminAccountsReset({
    databasePath,
    configuredSecret: bootstrapSecret,
    suppliedSecret: 'incorrect-bootstrap-secret'
  }), /Authorization failed/);
  const db = new Database(databasePath);
  assert.equal(db.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get().admin_id, 'admin-a');
  assert.equal(db.prepare('SELECT is_active FROM admins WHERE id = ?').get('admin-a').is_active, 1);
  db.close();
});

test('admin-account reset dry-run identifies affected admin rows and preserves the database unchanged', async (t) => {
  const databasePath = createDatabase(t);
  const result = await run(databasePath);
  assert.equal(result.changed, false);
  assert.equal(result.adminCount, 2);
  assert.deepEqual(result.adminRecordIds, ['admin-a', 'admin-b']);
  assert.equal(result.activeOrPendingAdminAccounts, 2);
  assert.equal(result.sessionsToDelete, 1);
  assert.equal(result.otpChallengesToDelete, 1);
  assert.equal(result.subjectAssignmentsToDelete, 1);
  assert.equal(result.auditEventsToRedact, 1);
  assert.deepEqual(result.auditEventIds, ['audit-a']);
  assert.equal(result.auditEventsPreserved, 1);
  assert.equal(result.accessRequestsToAnonymize, 1);
  assert.deepEqual(result.accessRequestIds, ['request-a']);
  assert.equal(result.deviceRegistryRowsPreserved, 1);
  assert.equal(result.legacyDeviceLocksPreserved, 1);
  assert.equal(result.preservedTableRows.attendance, 1);
  assert.equal(result.preservedTableRows.students, 1);
  assert.equal(result.preservedTableRows.subjects, 1);
  assert.equal(result.preservedTableRows.unrelated_records, 1);
  const db = new Database(databasePath);
  assert.equal(db.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get().admin_id, 'admin-a');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attendance').get().count, 1);
  db.close();
});

test('admin-account reset creates a validated backup without changing source data', async (t) => {
  const databasePath = createDatabase(t);
  const result = await run(databasePath, { backupOnly: true });
  assert.equal(result.changed, false);
  assert.ok(fs.existsSync(result.backupPath));
  const backup = new Database(result.backupPath, { readonly: true });
  assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(backup.pragma('foreign_key_check'), []);
  assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM admins').get().count, 2);
  backup.close();
  const source = new Database(databasePath);
  assert.equal(source.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get().admin_id, 'admin-a');
  source.close();
});

test('authorized admin-account reset preserves linked audit and unrelated records, and is repeatable', async (t) => {
  const databasePath = createDatabase(t);
  const result = await run(databasePath, { apply: true });
  assert.equal(result.changed, true);
  assert.ok(fs.existsSync(result.backupPath));

  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get().admin_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admins').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admins WHERE removed_at IS NOT NULL AND is_active = 0 AND is_verified = 0').get().count, 2);
  assert.equal(db.prepare('SELECT password_hash FROM admins WHERE id = ?').get('admin-a').password_hash, null);
  assert.equal(db.prepare('SELECT email FROM admins WHERE id = ?').get('admin-a').email, 'removed+admin-a@removed.invalid');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM otp_verifications').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_subject_assignments').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').get().count, 1);
  assert.equal(db.prepare('SELECT affected_record, reason FROM admin_audit_log WHERE id = ?').get('audit-a').affected_record, 'Removed admin');
  assert.equal(db.prepare('SELECT email, status, invite_admin_id, reviewed_by FROM admin_access_requests WHERE id = ?').get('request-a').email,
    'removed+admin-b@removed.invalid');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM device_registry').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM legacy_student_device_locks').get().count, 1);
  assert.equal(db.prepare('SELECT value FROM attendance WHERE id = ?').get('attendance-a').value, 'present');
  assert.equal(db.prepare('SELECT name FROM students WHERE id = ?').get('student-a').name, 'Student One');
  assert.equal(db.prepare('SELECT name FROM subjects WHERE id = ?').get('subject-a').name, 'Math');
  assert.equal(db.prepare('SELECT value FROM unrelated_records WHERE id = ?').get('unrelated-a').value, 'unchanged');
  db.close();

  const repeated = await run(databasePath, { apply: true });
  assert.equal(repeated.changed, true, 'reset may be safely repeated with tombstoned admin rows retained');
  const verify = new Database(databasePath);
  assert.deepEqual(verify.pragma('foreign_key_check'), []);
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').get().count, 1);
  verify.close();
});
