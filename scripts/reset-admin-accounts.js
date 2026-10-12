import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requiredTables = [
  'admins',
  'main_admin_config',
  'otp_verifications',
  'auth_sessions',
  'admin_subject_assignments',
  'admin_audit_log',
  'admin_access_requests',
  'device_registry',
  'legacy_student_device_locks'
];
const requiredColumns = {
  admins: [
    'id', 'name', 'email', 'phone', 'password_hash', 'is_verified', 'is_active',
    'approval_status', 'must_change_password', 'last_login', 'last_successful_login',
    'last_password_change_at', 'failed_login_attempts', 'account_lock_until',
    'last_status_change_at', 'updated_at', 'removed_at'
  ],
  main_admin_config: ['singleton', 'admin_id', 'created_at'],
  otp_verifications: ['admin_id'],
  auth_sessions: ['admin_id'],
  admin_subject_assignments: ['admin_id'],
  admin_audit_log: ['admin_id', 'target_admin_id', 'affected_record', 'reason'],
  admin_access_requests: ['email', 'invite_admin_id', 'name', 'status', 'rejection_reason'],
  device_registry: ['id'],
  legacy_student_device_locks: ['student_key']
};

function resolveDatabasePath(databaseUrl) {
  const value = String(databaseUrl || './data/attendance.sqlite').trim();
  return path.resolve(projectRoot, value.replace(/^sqlite:/, ''));
}

function secretsMatch(candidate, expected) {
  if (typeof candidate !== 'string' || expected.length < 32) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(candidateBytes, expectedBytes);
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function validateSchema(db) {
  const tables = new Set(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all().map((row) => row.name));
  for (const table of requiredTables) {
    if (!tables.has(table)) throw new Error(`Expected table "${table}" is missing; no changes were made.`);
    const columns = new Set(db.pragma(`table_info(${quoteIdentifier(table)})`).map((column) => column.name));
    for (const column of requiredColumns[table]) {
      if (!columns.has(column)) throw new Error(`Expected column "${table}.${column}" is missing; no changes were made.`);
    }
  }
  const violations = db.pragma('foreign_key_check');
  if (violations.length) throw new Error('The database has foreign-key violations; resolve them before reset.');
}

function tableCounts(db) {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all().map((row) => row.name);
  return Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count
  ]));
}

function prepareReset(db) {
  validateSchema(db);
  const accounts = db.prepare('SELECT id, email, removed_at FROM admins ORDER BY id').all();
  const adminIds = accounts.map(({ id }) => id);
  const placeholders = adminIds.map(() => '?').join(',');
  const countForAdminRows = (table) => adminIds.length
    ? db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE admin_id IN (${placeholders})`)
      .get(...adminIds).count
    : 0;
  const auditConditions = adminIds.length
    ? `admin_id IN (${placeholders}) OR target_admin_id IN (${placeholders})`
    : '0';
  const affectedAuditEvents = adminIds.length
    ? db.prepare(`SELECT COUNT(*) AS count FROM admin_audit_log WHERE ${auditConditions}`)
      .get(...adminIds, ...adminIds).count
    : 0;
  const accessRequestConditions = adminIds.length
    ? `invite_admin_id IN (${placeholders}) OR email IN (SELECT email FROM admins WHERE id IN (${placeholders}))`
    : '0';
  const affectedAccessRequests = adminIds.length
    ? db.prepare(`SELECT COUNT(*) AS count FROM admin_access_requests WHERE ${accessRequestConditions}`)
      .get(...adminIds, ...adminIds).count
    : 0;
  const auditEventIds = adminIds.length
    ? db.prepare(`SELECT id FROM admin_audit_log WHERE ${auditConditions} ORDER BY id`)
      .all(...adminIds, ...adminIds).map(({ id }) => id)
    : [];
  const accessRequestIds = adminIds.length
    ? db.prepare(`SELECT id FROM admin_access_requests WHERE ${accessRequestConditions} ORDER BY id`)
      .all(...adminIds, ...adminIds).map(({ id }) => id)
    : [];
  const assignment = db.prepare(`
    SELECT admin_id FROM main_admin_config WHERE singleton = 1
  `).get();
  if (!assignment) throw new Error('The Main Admin configuration row is missing; no changes were made.');
  const counts = tableCounts(db);
  const changedTables = new Set([
    'admins',
    'main_admin_config',
    'otp_verifications',
    'auth_sessions',
    'admin_subject_assignments',
    'admin_audit_log',
    'admin_access_requests'
  ]);
  const preservedTableRows = Object.fromEntries(
    Object.entries(counts).filter(([table]) => !changedTables.has(table))
  );

  return {
    adminCount: accounts.length,
    alreadyRemoved: accounts.filter((account) => account.removed_at).length,
    activeOrPendingAdminAccounts: accounts.filter((account) => !account.removed_at).length,
    adminRecordIds: accounts.map(({ id }) => id),
    mainAdminAssigned: !!assignment.admin_id,
    sessionsToDelete: countForAdminRows('auth_sessions'),
    otpChallengesToDelete: countForAdminRows('otp_verifications'),
    subjectAssignmentsToDelete: countForAdminRows('admin_subject_assignments'),
    auditEventsToRedact: affectedAuditEvents,
    auditEventIds,
    auditEventsPreserved: counts.admin_audit_log,
    accessRequestsToAnonymize: affectedAccessRequests,
    accessRequestIds,
    accessRequestRowsPreserved: counts.admin_access_requests,
    deviceRegistryRowsPreserved: counts.device_registry,
    legacyDeviceLocksPreserved: counts.legacy_student_device_locks,
    preservedTableRows,
    allTableCounts: counts
  };
}

function verifyBackup(backupPath, expectedCounts) {
  if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) {
    throw new Error('Database backup could not be verified; reset was not performed.');
  }
  const backupDb = new Database(backupPath, { readonly: true });
  try {
    const integrity = backupDb.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('Database backup failed SQLite integrity validation.');
    if (backupDb.pragma('foreign_key_check').length) {
      throw new Error('Database backup contains foreign-key violations; reset was not performed.');
    }
    const actualCounts = tableCounts(backupDb);
    if (JSON.stringify(actualCounts) !== JSON.stringify(expectedCounts)) {
      throw new Error('Database backup table counts differ from the source; reset was not performed.');
    }
  } finally {
    backupDb.close();
  }
  return backupPath;
}

function anonymizeAdmin(db, admin, now) {
  const anonymizedEmail = `removed+${admin.id}@removed.invalid`;
  db.prepare(`
    UPDATE admins SET
      name = 'Removed admin',
      email = ?,
      phone = NULL,
      password_hash = NULL,
      is_verified = 0,
      is_active = 0,
      approval_status = 'rejected',
      must_change_password = 0,
      last_login = NULL,
      last_successful_login = NULL,
      last_password_change_at = NULL,
      failed_login_attempts = 0,
      account_lock_until = NULL,
      last_status_change_at = ?,
      updated_at = ?,
      removed_at = COALESCE(removed_at, ?)
    WHERE id = ?
  `).run(anonymizedEmail, now, now, now, admin.id);
  db.prepare(`
    UPDATE admin_audit_log SET
      affected_record = 'Removed admin',
      reason = 'Account details were erased during authorized admin reset.'
    WHERE admin_id = ? OR target_admin_id = ?
  `).run(admin.id, admin.id);
  db.prepare(`
    UPDATE admin_access_requests SET
      name = 'Removed admin',
      email = ?,
      status = 'rejected',
      rejection_reason = 'Account details were erased during authorized admin reset.'
    WHERE invite_admin_id = ? OR email = ? COLLATE NOCASE
  `).run(anonymizedEmail, admin.id, admin.email);
}

export async function runAdminAccountsReset({
  databasePath,
  configuredSecret,
  suppliedSecret,
  backupOnly = false,
  apply = false
}) {
  if (!secretsMatch(suppliedSecret, String(configuredSecret || ''))) {
    throw new Error('Authorization failed. The configured bootstrap secret is required through the protected prompt.');
  }
  if (!databasePath || !fs.existsSync(databasePath)) {
    throw new Error('The configured SQLite database does not exist; no changes were made.');
  }

  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  try {
    const plan = prepareReset(db);
    if (backupOnly || !apply) {
      const backupPath = backupOnly ? await createVerifiedBackup(db, databasePath, plan.allTableCounts) : null;
      return {
        ...plan,
        changed: false,
        backupPath,
        message: backupOnly
          ? 'Verified database backup created; no admin records were changed.'
          : 'Dry run only; no admin records were changed.'
      };
    }

    const backupPath = await createVerifiedBackup(db, databasePath, plan.allTableCounts);
    const reset = db.transaction(() => {
      const currentPlan = prepareReset(db);
      if (currentPlan.adminCount !== plan.adminCount
        || JSON.stringify(currentPlan.allTableCounts) !== JSON.stringify(plan.allTableCounts)) {
        throw new Error('Database changed during reset preparation; no reset was performed.');
      }
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE main_admin_config SET admin_id = NULL, created_at = NULL WHERE singleton = 1
      `).run();
      const admins = db.prepare('SELECT id, email FROM admins').all();
      for (const admin of admins) anonymizeAdmin(db, admin, now);
      db.prepare('DELETE FROM auth_sessions').run();
      db.prepare('DELETE FROM otp_verifications').run();
      db.prepare('DELETE FROM admin_subject_assignments').run();

      const violations = db.pragma('foreign_key_check');
      if (violations.length) throw new Error('Reset would violate database foreign keys; transaction rolled back.');
      const afterCounts = tableCounts(db);
      for (const table of Object.keys(plan.allTableCounts)) {
        const preservedOrRetainedTable = [
          'admins',
          'auth_sessions',
          'otp_verifications',
          'admin_subject_assignments'
        ].includes(table);
        if (!preservedOrRetainedTable && afterCounts[table] !== plan.allTableCounts[table]) {
          throw new Error(`Reset unexpectedly changed row counts in "${table}"; transaction rolled back.`);
        }
      }
      if (afterCounts.admins !== plan.adminCount
        || afterCounts.admin_audit_log !== plan.auditEventsPreserved
        || afterCounts.admin_access_requests !== plan.accessRequestRowsPreserved
        || db.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get().admin_id !== null) {
        throw new Error('Reset integrity checks failed; transaction rolled back.');
      }
    });
    reset();
    return {
      ...plan,
      changed: true,
      backupPath,
      message: 'Admin accounts were disabled and anonymized. Admin audit events and unrelated records were preserved.'
    };
  } finally {
    db.close();
  }
}

async function createVerifiedBackup(db, databasePath, expectedCounts) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${databasePath}.pre-admin-accounts-reset-${stamp}-${crypto.randomUUID().slice(0, 8)}.bak`;
  await db.backup(backupPath);
  verifyBackup(backupPath, expectedCounts);
  return backupPath;
}

function parseMode(args) {
  const modes = args.filter((argument) => ['--backup-only', '--apply', '--dry-run'].includes(argument));
  if (args.some((argument) => !['--backup-only', '--apply', '--dry-run'].includes(argument)) || modes.length > 1) {
    throw new Error('Usage: node scripts/reset-admin-accounts.js [--backup-only|--dry-run|--apply]');
  }
  return { apply: modes[0] === '--apply', backupOnly: modes[0] === '--backup-only' };
}

async function readSecretInteractively() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('A protected interactive terminal is required; do not pass the bootstrap secret as a command-line argument.');
  }
  process.stderr.write('Enter MAIN_ADMIN_BOOTSTRAP_SECRET to authorize this operation: ');
  process.stdin.setRawMode(true);
  const secret = [];
  try {
    for await (const chunk of process.stdin) {
      let completed = false;
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') {
          completed = true;
          break;
        }
        if (character === '\u0003') throw new Error('Cancelled.');
        if (character === '\u007f' || character === '\b') secret.pop();
        else secret.push(character);
      }
      if (completed) break;
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stderr.write('\n');
  }
  return secret.join('');
}

async function main() {
  const { apply, backupOnly } = parseMode(process.argv.slice(2));
  const result = await runAdminAccountsReset({
    databasePath: resolveDatabasePath(process.env.DATABASE_URL),
    configuredSecret: String(process.env.MAIN_ADMIN_BOOTSTRAP_SECRET || ''),
    suppliedSecret: await readSecretInteractively(),
    backupOnly,
    apply
  });
  console.log(JSON.stringify({
    mode: backupOnly ? 'backup-only' : apply ? 'apply' : 'dry-run',
    adminCount: result.adminCount,
    adminRecordIds: result.adminRecordIds,
    activeOrPendingAdminAccounts: result.activeOrPendingAdminAccounts,
    alreadyRemoved: result.alreadyRemoved,
    mainAdminAssignmentWillBeCleared: result.mainAdminAssigned,
    sessionsToDelete: result.sessionsToDelete,
    otpChallengesToDelete: result.otpChallengesToDelete,
    subjectAssignmentsToDelete: result.subjectAssignmentsToDelete,
    auditEventsToRedact: result.auditEventsToRedact,
    auditEventIds: result.auditEventIds,
    auditEventsPreserved: result.auditEventsPreserved,
    accessRequestsToAnonymize: result.accessRequestsToAnonymize,
    accessRequestIds: result.accessRequestIds,
    accessRequestRowsPreserved: result.accessRequestRowsPreserved,
    deviceRegistryRowsPreserved: result.deviceRegistryRowsPreserved,
    legacyDeviceLocksPreserved: result.legacyDeviceLocksPreserved,
    preservedTableRows: result.preservedTableRows,
    backupPath: result.backupPath,
    changed: result.changed,
    message: result.message
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
