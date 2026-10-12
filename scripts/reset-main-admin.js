import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

function inspectDatabase(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  if (!tables.has('admins') || !tables.has('main_admin_config')) {
    throw new Error('The configured database does not contain the expected admin schema; no changes were made.');
  }
  const configColumns = new Set(db.pragma('table_info(main_admin_config)').map((column) => column.name));
  if (!configColumns.has('admin_id') || !configColumns.has('singleton')) {
    throw new Error('The Main Admin configuration schema is unexpected; no changes were made.');
  }
  const foreignKeyViolations = db.pragma('foreign_key_check');
  if (foreignKeyViolations.length) {
    throw new Error('The database has foreign-key violations; resolve them before resetting Main Admin assignment.');
  }

  const assignment = db.prepare(`
    SELECT main_admin_config.admin_id, main_admin_config.created_at,
      admins.is_verified, admins.is_active, admins.approval_status, admins.removed_at
    FROM main_admin_config
    LEFT JOIN admins ON admins.id = main_admin_config.admin_id
    WHERE main_admin_config.singleton = 1
  `).get();
  if (!assignment) throw new Error('The Main Admin configuration row is missing; no changes were made.');

  const counts = {
    admins: db.prepare('SELECT COUNT(*) AS count FROM admins').get().count,
    audit: tables.has('admin_audit_log')
      ? db.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').get().count
      : null,
    deviceRegistry: tables.has('device_registry')
      ? db.prepare('SELECT COUNT(*) AS count FROM device_registry').get().count
      : null
  };
  const eligibleClaimants = db.prepare(`
    SELECT COUNT(*) AS count FROM admins
    WHERE is_verified = 1 AND is_active = 1 AND approval_status = 'approved'
      AND removed_at IS NULL AND password_hash IS NOT NULL
  `).get().count;

  return { assignment, counts, eligibleClaimants };
}

export async function runAdminReset({
  databasePath,
  configuredSecret,
  suppliedSecret,
  backupOnly = false,
  apply = false
}) {
  if (!secretsMatch(suppliedSecret, String(configuredSecret || ''))) {
    throw new Error('Authorization failed. Set MAIN_ADMIN_BOOTSTRAP_SECRET in the environment and provide it through the protected prompt.');
  }
  if (!databasePath || !fs.existsSync(databasePath)) {
    throw new Error('The configured SQLite database does not exist; no changes were made.');
  }

  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  try {
    const report = inspectDatabase(db);
    const { assignment, counts, eligibleClaimants } = report;
    if (backupOnly) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${databasePath}.admin-reset-backup-${stamp}.bak`;
      await db.backup(backupPath);
      if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) {
        throw new Error('Database backup could not be verified.');
      }
      return {
        ...report,
        changed: false,
        backupPath,
        message: 'Verified database backup created; no records were changed.'
      };
    }
    if (!assignment.admin_id) {
      return { ...report, changed: false, message: 'No Main Admin is currently assigned; no reset is needed.' };
    }
    if (!eligibleClaimants) {
      throw new Error('No verified, active, approved admin can claim Main Admin after reset. Do not reset; recover an existing account first.');
    }
    if (!apply) {
      return {
        ...report,
        changed: false,
        message: 'Dry run only. A backup and Main Admin assignment reset would be required to proceed.'
      };
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${databasePath}.pre-main-admin-reset-${stamp}.bak`;
    await db.backup(backupPath);
    if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) {
      throw new Error('Database backup could not be verified; reset was not performed.');
    }

    const resetAssignment = db.transaction((expectedAdminId) => {
      const current = db.prepare(`
        SELECT admin_id FROM main_admin_config WHERE singleton = 1
      `).get();
      if (current?.admin_id !== expectedAdminId) {
        throw new Error('Main Admin assignment changed after inspection; reset was not performed.');
      }
      return db.prepare(`
        UPDATE main_admin_config SET admin_id = NULL, created_at = NULL
        WHERE singleton = 1 AND admin_id = ?
      `).run(expectedAdminId).changes;
    });
    const changedRows = resetAssignment(assignment.admin_id);
    if (changedRows !== 1) {
      throw new Error('Main Admin assignment was not reset; restore from the verified backup only if needed.');
    }

    const after = inspectDatabase(db);
    if (
      after.counts.admins !== counts.admins
      || after.counts.audit !== counts.audit
      || after.counts.deviceRegistry !== counts.deviceRegistry
      || after.assignment.admin_id !== null
    ) {
      throw new Error('Post-reset integrity check failed. Restore the verified backup before proceeding.');
    }
    return {
      ...report,
      changed: true,
      backupPath,
      message: 'Main Admin assignment reset. Existing accounts, audit logs, device records, and all other database rows were preserved.'
    };
  } finally {
    db.close();
  }
}

function parseMode(args) {
  const modes = args.filter((argument) => ['--backup-only', '--apply', '--dry-run'].includes(argument));
  if (args.some((argument) => !['--backup-only', '--apply', '--dry-run'].includes(argument)) || modes.length > 1) {
    throw new Error('Usage: node scripts/reset-main-admin.js [--backup-only|--dry-run|--apply]');
  }
  return { apply: modes[0] === '--apply', backupOnly: modes[0] === '--backup-only' };
}

async function main() {
  const { apply, backupOnly } = parseMode(process.argv.slice(2));
  const configuredSecret = String(process.env.MAIN_ADMIN_BOOTSTRAP_SECRET || '');
  const secretBuffer = [];
  if (process.stdin.isTTY) {
    process.stderr.write('Enter MAIN_ADMIN_BOOTSTRAP_SECRET to authorize this operation: ');
    process.stdin.setRawMode(true);
    for await (const chunk of process.stdin) {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') break;
        if (character === '\u0003') throw new Error('Cancelled.');
        if (character === '\u007f' || character === '\b') secretBuffer.pop();
        else secretBuffer.push(character);
      }
      if (chunk.toString('utf8').includes('\n') || chunk.toString('utf8').includes('\r')) break;
    }
    process.stdin.setRawMode(false);
    process.stderr.write('\n');
  } else {
    throw new Error('A protected interactive terminal is required so the bootstrap secret is not exposed in command arguments or logs.');
  }
  const result = await runAdminReset({
    databasePath: resolveDatabasePath(process.env.DATABASE_URL),
    configuredSecret,
    suppliedSecret: secretBuffer.join(''),
    backupOnly,
    apply
  });
  console.log(JSON.stringify({
    mode: backupOnly ? 'backup-only' : apply ? 'apply' : 'dry-run',
    mainAdminAssigned: !!result.assignment.admin_id,
    adminCount: result.counts.admins,
    auditRecordCount: result.counts.audit,
    deviceRegistryRecordCount: result.counts.deviceRegistry,
    eligibleMainAdminClaimants: result.eligibleClaimants,
    changed: result.changed,
    backupPath: result.backupPath || null,
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
