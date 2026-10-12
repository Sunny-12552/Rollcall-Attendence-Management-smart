import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';
import { google } from 'googleapis';
import { calendarDatesBetween, isCountedClassStatus, isHolidayDate, newestFirstDates, statusForUnmarkedDate } from './attendance-calendar.js';
import {
  bindDevice,
  checkDeviceOwner,
  importLegacyStudentLocks,
  initializeDeviceRegistry,
  listAdminAuditLog,
  listDeviceRegistry,
  recordDeviceAttendance,
  releaseNewDeviceBinding,
  unlockDevice
} from './device-registry.js';
import { resolvePublicUrl as buildPublicUrl } from './public-url.js';
import { mayReplaceClosedAbsence, recoverClosedSession } from './qr-session-lifecycle.js';
import { loadGoogleServiceAccountCredentials } from './google-service-account.js';
import {
  columnName,
  readSecuritySheetSchema,
  securitySheetHeaders,
  syncSheetRowsById
} from './admin-sheet-sync.js';
import {
  emailDeliveryErrorMessage,
  emailConfigurationMessage,
  isEmailConfigured,
  sendAccountStatusEmail,
  sendAbsenceNotification,
  sendAdminInvitation,
  sendAdminOtp,
  sendAttendanceNotification,
  sendAttendanceSummary,
  sendPasswordResetOtp,
  sendWelcomeEmail
} from './email-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const httpsEnabled = process.env.HTTPS === 'true' && !!process.env.SSL_CERT_PATH && !!process.env.SSL_KEY_PATH;
const httpsOptions = httpsEnabled
  ? { key: fs.readFileSync(process.env.SSL_KEY_PATH, 'utf8'), cert: fs.readFileSync(process.env.SSL_CERT_PATH, 'utf8') }
  : null;
if (process.env.HTTPS === 'true' && !httpsEnabled) {
  console.warn('HTTPS requested but SSL_CERT_PATH/SSL_KEY_PATH are missing. Falling back to HTTP for local testing.');
}
const subjects = (process.env.SUBJECTS || 'AI-Native Full Stack,GenAI & Agentic AI,Python Full Stack,Java Full Stack,Data Science,MERN Stack Development,Frontend Development,Backend Development,DevOps & Cloud,Data Analytics').split(',').map((subject) => String(subject || '').trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 10);
const batches = [...Array.from({ length: 10 }, (_, i) => `P${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `J${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `D${i + 1}`)];
const courseFor = (batch) => batch.startsWith('P') ? 'Python Full Stack' : batch.startsWith('J') ? 'Java Full Stack' : 'Data Science';
const sheetHeaders = ['Date', 'Time', 'Student Name', 'Batch', 'Course', 'Subject', 'Status', 'Attendance Source', 'Session ID'];
const sessions = new Map();
const studentRegistrationLocks = new Map();
const deviceAttendanceLocks = new Map();
const activeDeviceLockClaims = new Map();
const DEVICE_LOCKS_PATH = process.env.DEVICE_LOCKS_PATH
  ? path.resolve(__dirname, process.env.DEVICE_LOCKS_PATH)
  : path.join(__dirname, '.device-locks.json');
const LEGACY_ADMIN_ACCOUNT_PATH = path.join(__dirname, '.admin-account.json');
const configuredSessionSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET || '';
const sessionSecret = configuredSessionSecret || crypto.randomBytes(32).toString('hex');
const mainAdminBootstrapSecret = String(process.env.MAIN_ADMIN_BOOTSTRAP_SECRET || '');
if (mainAdminBootstrapSecret && mainAdminBootstrapSecret.length < 32) {
  throw new Error('MAIN_ADMIN_BOOTSTRAP_SECRET must contain at least 32 characters.');
}
const scrypt = promisify(crypto.scrypt);
const qrMinutes = Number(process.env.QR_MINUTES || 30);
const allowedQrMinutes = new Set([5, 10, 20, 30]);
if (!allowedQrMinutes.has(qrMinutes)) {
  throw new Error('QR_MINUTES must be one of 5, 10, 20, or 30.');
}
const minAttendancePercentage = Number(process.env.MIN_ATTENDANCE_PERCENTAGE || 75);
const databaseUrl = String(process.env.DATABASE_URL || './data/attendance.sqlite').trim();
const databasePath = path.resolve(__dirname, databaseUrl.replace(/^sqlite:/, ''));
let authDb = null;
const authRateLimits = new Map();
const deviceRegistrySheetSyncs = new Map();
const dummyPasswordHash = bcrypt.hashSync(`invalid-password-${crypto.randomBytes(32).toString('hex')}`, 12);
const attendanceValidationRule = { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Present' }, { userEnteredValue: 'Absent' }, { userEnteredValue: 'Holiday' }] }, showCustomUi: true, strict: false };
const holidays = new Set((process.env.HOLIDAYS || '').split(',').map((date) => date.trim()).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
const deviceLockMessage = 'Attendance Limit Reached. This device has already marked attendance for this subject.';
const deviceTokenPattern = /^[A-Za-z0-9._:-]{12,128}$/;

function ledgerSheetName(subject) { return `${subject} Ledger`; }

function resolvePublicUrl(req) {
  return buildPublicUrl(req, {
    configuredUrl: process.env.APP_URL,
    httpsEnabled: !!httpsOptions,
    port
  });
}

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || (process.env.NODE_ENV === 'production' ? 1 : 0));
if (!Number.isSafeInteger(trustProxyHops) || trustProxyHops < 0) {
  throw new Error('TRUST_PROXY_HOPS must be a non-negative whole number.');
}
app.set('trust proxy', trustProxyHops);

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('hex');
}
function hashDeviceToken(deviceToken) {
  return crypto.createHash('sha256').update(String(deviceToken).trim()).digest('hex');
}
function isValidDeviceToken(deviceToken) {
  return typeof deviceToken === 'string' && deviceTokenPattern.test(deviceToken.trim());
}
function clientIpAddress(req) {
  const forwarded = String(req.ip || '').split('%')[0].toLowerCase();
  if (forwarded.startsWith('::ffff:') && isIP(forwarded.slice(7)) === 4) return forwarded.slice(7);
  return isIP(forwarded) ? forwarded : '';
}
function getDeviceLockKey(date, deviceToken, qrSessionId) {
  return `${String(date || '').trim()}|${String(qrSessionId || '').trim()}|${hashDeviceToken(deviceToken)}`;
}
async function loadDeviceLocksFromDisk() {
  try {
    const raw = await fs.promises.readFile(DEVICE_LOCKS_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const savedDeviceLocks = parsed.deviceAttendanceLocks || parsed;
    for (const [key, value] of Object.entries(savedDeviceLocks || {})) {
      if (!value || typeof value !== 'object') continue;
      const parts = key.split('|');
      const qrSessionId = String(value.qrSessionId || parts[1] || '').trim();
      const deviceTokenHash = value.deviceTokenHash || parts[2] || '';
      if (!qrSessionId || !deviceTokenHash) continue;
      deviceAttendanceLocks.set(key, { ...value, qrSessionId, deviceTokenHash });
    }
    importLegacyStudentLocks(authDb, parsed.studentDeviceLocks);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Unable to read the existing device-lock store: ${error.message}`, { cause: error });
  }
}
async function persistDeviceLocks() {
  fs.mkdirSync(path.dirname(DEVICE_LOCKS_PATH), { recursive: true });
  await fs.promises.writeFile(DEVICE_LOCKS_PATH, JSON.stringify({
    deviceAttendanceLocks: Object.fromEntries(deviceAttendanceLocks)
  }, null, 2), 'utf8');
}
async function isDeviceSessionAttendanceLocked(date, deviceToken, qrSessionId) {
  if (!isValidDeviceToken(deviceToken)) return true;
  return deviceAttendanceLocks.has(getDeviceLockKey(date, deviceToken, qrSessionId));
}
async function claimDeviceSessionAttendanceLock({ date, deviceToken, qrSessionId, subject, studentIdentifier }) {
  if (!isValidDeviceToken(deviceToken)) {
    return { allowed: false, reason: 'Unable to identify this device. Please refresh the page and try again.' };
  }

  const key = getDeviceLockKey(date, deviceToken, qrSessionId);
  const pending = activeDeviceLockClaims.get(key);
  if (pending) {
    await pending;
    return { allowed: false, reason: deviceLockMessage };
  }

  const attempt = (async () => {
    if (deviceAttendanceLocks.has(key)) {
      return { allowed: false, reason: deviceLockMessage };
    }
    const record = { date: String(date || '').trim(), qrSessionId: String(qrSessionId || '').trim(), subject: normalizeSubjectName(subject), deviceTokenHash: hashDeviceToken(deviceToken), studentIdentifier: String(studentIdentifier || '').trim(), createdAt: Date.now() };
    deviceAttendanceLocks.set(key, record);
    await persistDeviceLocks();
    return { allowed: true, record };
  })();

  activeDeviceLockClaims.set(key, attempt);
  try {
    return await attempt;
  } finally {
    activeDeviceLockClaims.delete(key);
  }
}
async function releaseDeviceSessionAttendanceLock(date, deviceToken, qrSessionId) {
  if (!isValidDeviceToken(deviceToken)) return false;
  const key = getDeviceLockKey(date, deviceToken, qrSessionId);
  if (!deviceAttendanceLocks.has(key)) return false;
  deviceAttendanceLocks.delete(key);
  await persistDeviceLocks();
  return true;
}
function instructorCookie(adminId) {
  const sessionId = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  authDb.prepare('INSERT INTO auth_sessions (token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    crypto.createHash('sha256').update(sessionId).digest('hex'),
    adminId,
    expiresAt,
    new Date().toISOString()
  );
  return `${sessionId}.${sign(sessionId)}`;
}
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function backupBeforeAdminApprovalMigration(schemaVersion) {
  if (schemaVersion < 1 || schemaVersion >= 7 || !fs.existsSync(databasePath)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${databasePath}.pre-v7-${stamp}-${crypto.randomUUID().slice(0, 8)}.bak`;
  const escapedPath = backupPath.replace(/'/g, "''");
  authDb.exec(`VACUUM INTO '${escapedPath}'`);
}
function initializeAuthDatabase() {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  authDb = new Database(databasePath);
  authDb.pragma('journal_mode = WAL');
  authDb.pragma('foreign_keys = ON');
  authDb.pragma('busy_timeout = 5000');
  let schemaVersion = authDb.pragma('user_version', { simple: true });
  if (schemaVersion > 7) throw new Error(`Unsupported attendance auth database version ${schemaVersion}.`);
  backupBeforeAdminApprovalMigration(schemaVersion);
  if (schemaVersion < 1) {
    const migrate = authDb.transaction(() => {
      authDb.exec(`
        CREATE TABLE admins (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT,
          role TEXT NOT NULL DEFAULT 'ADMIN' CHECK (role = 'ADMIN'),
          is_verified INTEGER NOT NULL DEFAULT 0 CHECK (is_verified IN (0, 1)),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login TEXT
        );
        CREATE TABLE otp_verifications (
          id TEXT PRIMARY KEY,
          admin_id TEXT NOT NULL UNIQUE REFERENCES admins(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'invite', 'reset')),
          otp_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_sent_at INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE auth_sessions (
          token_hash TEXT PRIMARY KEY,
          admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX auth_sessions_admin_idx ON auth_sessions(admin_id);
        CREATE INDEX otp_verifications_expiry_idx ON otp_verifications(expires_at);
      `);
      authDb.pragma('user_version = 1');
    });
    migrate();
  }
  if (schemaVersion < 2) {
    const hasVerificationFlag = authDb.pragma('table_info(otp_verifications)').some((column) => column.name === 'verified');
    const migrateOtpVerificationState = authDb.transaction(() => {
      if (!hasVerificationFlag) {
        authDb.exec('ALTER TABLE otp_verifications ADD COLUMN verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1))');
      }
      authDb.pragma('user_version = 2');
    });
    migrateOtpVerificationState();
  }
  schemaVersion = authDb.pragma('user_version', { simple: true });
  if (schemaVersion < 3) {
    const migrateDeviceSecurity = authDb.transaction(() => {
      for (const [column, declaration] of [
        ['failed_login_attempts', 'INTEGER NOT NULL DEFAULT 0'],
        ['last_successful_login', 'TEXT'],
        ['last_password_change_at', 'TEXT'],
        ['account_lock_until', 'INTEGER']
      ]) {
        if (!authDb.pragma('table_info(admins)').some((entry) => entry.name === column)) {
          authDb.exec(`ALTER TABLE admins ADD COLUMN ${column} ${declaration}`);
        }
      }
      authDb.exec(`
        UPDATE admins SET last_password_change_at = created_at
        WHERE last_password_change_at IS NULL AND password_hash IS NOT NULL;
      `);
      initializeDeviceRegistry(authDb);
      authDb.pragma('user_version = 3');
    });
    migrateDeviceSecurity();
  } else {
    initializeDeviceRegistry(authDb);
  }
  schemaVersion = authDb.pragma('user_version', { simple: true });
  if (schemaVersion < 4) {
    const migrateMainAdmin = authDb.transaction(() => {
      authDb.exec(`
        CREATE TABLE IF NOT EXISTS main_admin_config (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          admin_id TEXT UNIQUE REFERENCES admins(id),
          created_at TEXT
        );
        INSERT OR IGNORE INTO main_admin_config (singleton, admin_id, created_at) VALUES (1, NULL, NULL);
      `);
      for (const [column, declaration] of [
        ['acting_admin_role', "TEXT NOT NULL DEFAULT 'ADMIN'"],
        ['target_admin_id', 'TEXT'],
        ['result', "TEXT NOT NULL DEFAULT 'success'"],
        ['last_status_change_at', 'TEXT'],
        ['removed_at', 'TEXT']
      ]) {
        const table = ['last_status_change_at', 'removed_at'].includes(column) ? 'admins' : 'admin_audit_log';
        if (!authDb.pragma(`table_info(${table})`).some((entry) => entry.name === column)) {
          authDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
        }
      }
      authDb.pragma('user_version = 4');
    });
    migrateMainAdmin();
  }
  schemaVersion = authDb.pragma('user_version', { simple: true });
  if (schemaVersion < 5) {
    const migrateAdminAccessRequests = authDb.transaction(() => {
      authDb.exec(`
        CREATE TABLE IF NOT EXISTS admin_access_requests (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL COLLATE NOCASE,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
          created_at TEXT NOT NULL,
          reviewed_at TEXT,
          reviewed_by TEXT REFERENCES admins(id),
          rejection_reason TEXT,
          invite_admin_id TEXT REFERENCES admins(id)
        );
        CREATE INDEX IF NOT EXISTS admin_access_requests_status_idx
          ON admin_access_requests(status, created_at);
      `);
      authDb.pragma('user_version = 5');
    });
    migrateAdminAccessRequests();
  }
  schemaVersion = authDb.pragma('user_version', { simple: true });
  if (schemaVersion < 6) {
    const migrateTemporaryAdminPasswords = authDb.transaction(() => {
      if (!authDb.pragma('table_info(admins)').some((column) => column.name === 'must_change_password')) {
        authDb.exec('ALTER TABLE admins ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1))');
      }
      authDb.pragma('user_version = 6');
    });
    migrateTemporaryAdminPasswords();
  }
  schemaVersion = authDb.pragma('user_version', { simple: true });
  if (schemaVersion < 7) {
    const migrateAdminApprovalAndSubjects = authDb.transaction(() => {
      for (const [column, declaration] of [
        ['phone', 'TEXT'],
        ['approval_status', "TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected'))"],
        ['approval_reviewed_at', 'TEXT'],
        ['approval_reviewed_by', 'TEXT REFERENCES admins(id)']
      ]) {
        if (!authDb.pragma('table_info(admins)').some((entry) => entry.name === column)) {
          authDb.exec(`ALTER TABLE admins ADD COLUMN ${column} ${declaration}`);
        }
      }
      authDb.exec(`
        CREATE TABLE IF NOT EXISTS admin_subject_assignments (
          admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
          subject TEXT NOT NULL,
          assigned_at TEXT NOT NULL,
          assigned_by TEXT REFERENCES admins(id),
          PRIMARY KEY (admin_id, subject)
        );
        CREATE INDEX IF NOT EXISTS admin_subject_assignments_subject_idx
          ON admin_subject_assignments(subject);
      `);
      authDb.exec('CREATE UNIQUE INDEX IF NOT EXISTS admins_phone_unique_idx ON admins(phone) WHERE phone IS NOT NULL');
      const assignLegacySubjects = authDb.prepare(`
        INSERT OR IGNORE INTO admin_subject_assignments (admin_id, subject, assigned_at)
        SELECT id, ?, created_at FROM admins
      `);
      for (const subject of subjects) assignLegacySubjects.run(subject);
      authDb.pragma('user_version = 7');
    });
    migrateAdminApprovalAndSubjects();
  }
  migrateLegacyAdminAccount();
  scrubPreviouslyRemovedAdminAccounts();
}
function anonymizeRemovedAdminData(target) {
  const anonymizedEmail = `removed+${target.id}@removed.invalid`;
  authDb.prepare(`
    UPDATE admins SET
      name = 'Removed admin', email = ?, phone = NULL, password_hash = NULL,
      is_verified = 0, is_active = 0, approval_status = 'rejected',
      must_change_password = 0, last_login = NULL, last_successful_login = NULL,
      last_password_change_at = NULL, failed_login_attempts = 0, account_lock_until = NULL
    WHERE id = ?
  `).run(anonymizedEmail, target.id);
  authDb.prepare('DELETE FROM auth_sessions WHERE admin_id = ?').run(target.id);
  authDb.prepare('DELETE FROM otp_verifications WHERE admin_id = ?').run(target.id);
  authDb.prepare('DELETE FROM admin_subject_assignments WHERE admin_id = ?').run(target.id);
  authDb.prepare(`
    UPDATE admin_audit_log SET
      affected_record = 'Removed admin',
      reason = 'Account details were erased during admin removal.'
    WHERE admin_id = ? OR target_admin_id = ?
  `).run(target.id, target.id);
  authDb.prepare(`
    UPDATE admin_access_requests SET
      name = 'Removed admin', email = ?, status = 'rejected',
      rejection_reason = 'Account details were erased during admin removal.'
    WHERE invite_admin_id = ? OR email = ? COLLATE NOCASE
  `).run(anonymizedEmail, target.id, target.email);
}
function scrubPreviouslyRemovedAdminAccounts() {
  const removedAdmins = authDb.prepare(`
    SELECT id, email FROM admins
    WHERE removed_at IS NOT NULL
      AND (name != 'Removed admin' OR email NOT LIKE 'removed+%@removed.invalid'
        OR phone IS NOT NULL OR password_hash IS NOT NULL OR last_login IS NOT NULL
        OR last_successful_login IS NOT NULL OR last_password_change_at IS NOT NULL)
  `).all();
  if (!removedAdmins.length) return;
  authDb.transaction(() => {
    for (const admin of removedAdmins) anonymizeRemovedAdminData(admin);
  })();
  console.info(`Erased personal and login details for ${removedAdmins.length} previously removed admin account(s).`);
}
function migrateLegacyAdminAccount() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(LEGACY_ADMIN_ACCOUNT_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`Unable to read legacy admin account: ${error.message}`);
  }
  if (!data || !isValidEmail(normalizeEmail(data.email)) || typeof data.salt !== 'string' || typeof data.passwordHash !== 'string') {
    throw new Error('The legacy admin account file has an invalid format.');
  }
  const now = new Date().toISOString();
  authDb.prepare(`
    INSERT OR IGNORE INTO admins
      (id, name, email, password_hash, role, is_verified, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'ADMIN', 1, 1, ?, ?)
  `).run(crypto.randomUUID(), String(data.name || 'Admin'), normalizeEmail(data.email), `scrypt$${data.salt}$${data.passwordHash}`, now, now);
  const legacyAdmin = authDb.prepare('SELECT id FROM admins WHERE email = ? COLLATE NOCASE').get(normalizeEmail(data.email));
  const assignLegacySubject = authDb.prepare(`
    INSERT OR IGNORE INTO admin_subject_assignments (admin_id, subject, assigned_at)
    VALUES (?, ?, ?)
  `);
  for (const subject of subjects) assignLegacySubject.run(legacyAdmin.id, subject, now);
}
function validPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}
function passwordDigest(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}
async function hashPassword(password) {
  return `bcrypt-sha256:${await bcrypt.hash(passwordDigest(password), 12)}`;
}
async function verifyStoredPassword(password, storedHash) {
  if (storedHash.startsWith('bcrypt-sha256:')) return bcrypt.compare(passwordDigest(password), storedHash.slice('bcrypt-sha256:'.length));
  return bcrypt.compare(password, storedHash);
}
function rateLimit(key, maximum, windowMs) {
  const now = Date.now();
  const recent = (authRateLimits.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  if (authRateLimits.size > 5000) {
    for (const [storedKey, timestamps] of authRateLimits) {
      const active = timestamps.filter((timestamp) => now - timestamp < 60 * 60 * 1000);
      if (active.length) authRateLimits.set(storedKey, active);
      else authRateLimits.delete(storedKey);
    }
  }
  if (recent.length >= maximum) {
    authRateLimits.set(key, recent);
    return false;
  }
  recent.push(now);
  authRateLimits.set(key, recent);
  return true;
}
function rateLimitKey(req, operation, email = '') {
  return `${operation}:${req.ip}:${normalizeEmail(email)}`;
}
async function generateTemporaryPassword(name, previousPasswordHash = '') {
  const namePrefix = String(name || '').trim().split(/\s+/)[0]
    .normalize('NFKD').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'Admin';
  const firstSuffix = crypto.randomInt(0, 1000);
  for (let offset = 0; offset < 1000; offset += 1) {
    const randomSuffix = ((firstSuffix + offset) % 1000).toString().padStart(3, '0');
    const candidate = `${namePrefix}${randomSuffix}`;
    if (!previousPasswordHash || !(await verifyStoredPassword(candidate, previousPasswordHash))) return candidate;
  }
  throw new Error('Unable to generate a new temporary administrator password.');
}
const otpOperationQueues = new Map();
async function withOtpOperationLock(adminId, operation) {
  const previous = otpOperationQueues.get(adminId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  otpOperationQueues.set(adminId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (otpOperationQueues.get(adminId) === current) otpOperationQueues.delete(adminId);
  }
}

async function createOtpUnlocked(adminId, purpose, { temporaryPassword } = {}) {
  const admin = authDb.prepare('SELECT name, email, role FROM admins WHERE id = ?').get(adminId);
  if (!admin) throw new Error('The administrator account is no longer available.');
  const previous = authDb.prepare('SELECT * FROM otp_verifications WHERE admin_id = ?').get(adminId);
  if (previous && Date.now() - previous.last_sent_at < 60_000) {
    const error = new Error('Please wait one minute before requesting another code.');
    error.code = 'OTP_RATE_LIMITED';
    throw error;
  }
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const otpHash = await bcrypt.hash(code, 10);
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const createdAt = new Date().toISOString();
  const challengeId = crypto.randomUUID();
  authDb.prepare(`
    INSERT INTO otp_verifications (id, admin_id, purpose, otp_hash, expires_at, attempts, last_sent_at, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(admin_id) DO UPDATE SET
      id = excluded.id,
      purpose = excluded.purpose,
      otp_hash = excluded.otp_hash,
      expires_at = excluded.expires_at,
      attempts = 0,
      last_sent_at = excluded.last_sent_at,
      created_at = excluded.created_at
  `).run(challengeId, adminId, purpose, otpHash, expiresAt, Date.now(), createdAt);
  try {
    const emailDetails = {
      to: admin.email,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      otp: code,
      expiryMinutes: 10,
      temporaryPassword
    };
    if (purpose === 'reset') await sendPasswordResetOtp(emailDetails);
    else if (purpose === 'invite') await sendAdminInvitation(emailDetails);
    else await sendAdminOtp(emailDetails);
  } catch (error) {
    if (previous) {
      authDb.prepare(`
        INSERT INTO otp_verifications
          (id, admin_id, purpose, otp_hash, expires_at, attempts, last_sent_at, created_at, verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(admin_id) DO UPDATE SET
          id = excluded.id, purpose = excluded.purpose, otp_hash = excluded.otp_hash,
          expires_at = excluded.expires_at, attempts = excluded.attempts,
          last_sent_at = excluded.last_sent_at, created_at = excluded.created_at,
          verified = excluded.verified
      `).run(
        previous.id,
        previous.admin_id,
        previous.purpose,
        previous.otp_hash,
        previous.expires_at,
        previous.attempts,
        previous.last_sent_at,
        previous.created_at,
        previous.verified
      );
    } else {
      authDb.prepare('DELETE FROM otp_verifications WHERE admin_id = ? AND id = ?').run(adminId, challengeId);
    }
    throw error;
  }
}
async function createOtp(adminId, purpose, options) {
  return withOtpOperationLock(adminId, () => createOtpUnlocked(adminId, purpose, options));
}
function sessionAdmin(req) {
  const raw = req.headers.cookie?.match(/(?:^|; )instructor=([^;]+)/)?.[1];
  if (!raw) return null;
  const lastDot = raw.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const sessionId = raw.slice(0, lastDot);
  const received = Buffer.from(raw.slice(lastDot + 1));
  const expected = Buffer.from(sign(sessionId));
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  return authDb.prepare(`
    SELECT admins.id, admins.name, admins.email, admins.must_change_password AS mustChangePassword,
      CASE WHEN main_admin_config.admin_id = admins.id THEN 'MAIN_ADMIN' ELSE 'ADMIN' END AS role
    FROM auth_sessions
    JOIN admins ON admins.id = auth_sessions.admin_id
    LEFT JOIN main_admin_config ON main_admin_config.singleton = 1
    WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
      AND admins.is_verified = 1 AND admins.is_active = 1
      AND admins.approval_status = 'approved'
      AND admins.removed_at IS NULL
  `).get(crypto.createHash('sha256').update(sessionId).digest('hex'), Date.now()) || null;
}
function requireInstructor(req, res, next) {
  const admin = sessionAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Admin login required.' });
  if (admin.mustChangePassword) return res.status(403).json({ error: 'Change your temporary password before using the dashboard.' });
  req.admin = admin;
  next();
}
function requireMainAdmin(req, res, next) {
  if (req.admin.role !== 'MAIN_ADMIN') return res.status(403).json({ error: 'Main Admin access required.' });
  next();
}
function assignedSubjects(admin) {
  if (admin.role === 'MAIN_ADMIN') return subjects;
  return authDb.prepare('SELECT subject FROM admin_subject_assignments WHERE admin_id = ? ORDER BY subject').all(admin.id)
    .map((entry) => entry.subject)
    .filter((subject) => subjects.includes(subject));
}
function canAccessSubject(admin, subject) {
  return subjects.includes(subject) && assignedSubjects(admin).includes(subject);
}
function sessionIssuerCanAccess(session) {
  const adminIds = [...new Set([session?.createdBy, session?.recoveredBy].filter(Boolean))];
  if (!adminIds.length) return false;
  const authorizedAdmins = authDb.prepare(`
    SELECT admins.id,
      CASE WHEN main_admin_config.admin_id = admins.id THEN 'MAIN_ADMIN' ELSE 'ADMIN' END AS role
    FROM admins CROSS JOIN main_admin_config
    WHERE admins.id IN (${adminIds.map(() => '?').join(', ')})
      AND admins.is_verified = 1 AND admins.is_active = 1
      AND admins.approval_status = 'approved' AND admins.removed_at IS NULL
  `).all(...adminIds);
  return authorizedAdmins.some((admin) => canAccessSubject(admin, session.subject));
}
function requireSubjectAccess(req, res, subject) {
  if (!canAccessSubject(req.admin, subject)) {
    bad(res, 403, 'You are not assigned to this subject.');
    return false;
  }
  return true;
}
function bootstrapSecretMatches(candidate) {
  if (mainAdminBootstrapSecret.length < 32 || typeof candidate !== 'string') return false;
  const expected = Buffer.from(mainAdminBootstrapSecret);
  const received = Buffer.from(candidate);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}
function normalizeSubjectName(subject) {
  return String(subject || '').trim().replace(/\s+/g, ' ');
}
function resolveSubjectSheetTitle(subject) {
  const requested = normalizeSubjectName(subject);
  if (!requested) return requested;
  const exactMatches = subjects.filter((entry) => normalizeSubjectName(entry) === requested);
  if (exactMatches.length) return exactMatches[0];
  const normalizedRequested = requested.toLowerCase();
  const partialMatches = subjects.filter((entry) => normalizeSubjectName(entry).toLowerCase() === normalizedRequested || normalizeSubjectName(entry).toLowerCase().includes(normalizedRequested) || normalizedRequested.includes(normalizeSubjectName(entry).toLowerCase()));
  if (partialMatches.length) return partialMatches[0];
  return requested;
}
function serverDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TIMEZONE || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}
function serverNow() {
  const p = serverDateParts();
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
function sessionToken(id) { return `${id}.${sign(id)}`; }
function readSession(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  const id = token.slice(0, dot);
  if (dot < 1 || token.slice(dot + 1) !== sign(id)) return null;
  const session = sessions.get(id);
  return session ? session : null;
}
function isSessionActive(session) {
  return !!session && session.status === 'active' && session.expiresAt > Date.now();
}
function bad(res, status, error) { return res.status(status).json({ error }); }

let sheets;
let layoutPromise;
function getSheets() {
  if (sheets) return sheets;
  if (!process.env.GOOGLE_SPREADSHEET_ID) throw new Error('Google Sheets is not configured.');
  const credentials = loadGoogleServiceAccountCredentials();
  if (!credentials) throw new Error('Google service-account credentials are not configured.');
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}
async function retrySheetsQuota(request) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      const status = error.response?.status || error.code;
      const errorDetails = `${error.message || ''} ${JSON.stringify(error.response?.data || {})}`;
      const isQuotaLimit = [403, 429].includes(Number(status))
        && /quota|rate.?limit|resource_exhausted/i.test(errorDetails);
      if (!isQuotaLimit || attempt >= 3) throw error;
      const retryAfterHeader = error.response?.headers?.['retry-after']
        || error.response?.headers?.get?.('retry-after');
      const retryAfterMs = Number(retryAfterHeader) * 1000;
      const waitMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.max(retryAfterMs, 15_000)
        : 15_000 * (attempt + 1);
      console.warn(`Google Sheets read quota reached; retrying in ${Math.ceil(waitMs / 1000)} seconds.`);
      await delay(waitMs);
    }
  }
}
function readSheetsBatch(ranges) {
  return retrySheetsQuota(() => getSheets().spreadsheets.values.batchGet({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    ranges
  }));
}
function readSheetsMetadata(fields) {
  return retrySheetsQuota(() => getSheets().spreadsheets.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    fields
  }));
}
async function ensureSheetLayout() {
  if (layoutPromise) return layoutPromise;
  layoutPromise = (async () => {
    const service = getSheets();
    const metadata = await readSheetsMetadata('sheets.properties.title,sheets.properties.sheetId');
    const sheetIds = new Map(metadata.data.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
    const existing = new Set(metadata.data.sheets.map((sheet) => sheet.properties.title));
    const required = ['Students', 'Percentage', ...subjects];
    const renameRequests = [];
    const usedLegacyTitles = new Set();
    for (let i = 0; i < subjects.length; i += 1) {
      const desiredTitle = subjects[i];
      if (existing.has(desiredTitle)) continue;

      const legacyCandidates = [`Subject ${i + 1}`, `Sheet${i + 1}`, 'Sheet1'];
      const legacyTitle = legacyCandidates.find((candidate) => existing.has(candidate) && !usedLegacyTitles.has(candidate) && candidate !== desiredTitle);
      if (!legacyTitle) continue;

      const sheetId = sheetIds.get(legacyTitle);
      if (sheetId !== undefined) {
        renameRequests.push({ updateSheetProperties: { properties: { sheetId, title: desiredTitle }, fields: 'title' } });
        usedLegacyTitles.add(legacyTitle);
      }
    }
    if (renameRequests.length) {
      await service.spreadsheets.batchUpdate({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, requestBody: { requests: renameRequests } });
    }
    const updatedMetadata = await readSheetsMetadata('sheets.properties.title');
    const refreshedExisting = new Set(updatedMetadata.data.sheets.map((sheet) => sheet.properties.title));
    const missing = required.filter((title) => !refreshedExisting.has(title));
    if (missing.length) {
      await service.spreadsheets.batchUpdate({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) } });
    }
    const headers = [
      ['Students', ['Student ID', 'Student Name', 'Batch', 'Email']],
      ['Percentage', ['Student Name', 'Batch', 'Course', 'Subject', 'Attended Classes', 'Total Classes', 'Subject Percentage', 'Full-Course / Overall Percentage']],
      ...subjects.map((subject) => [subject, ['Student ID', 'Student Name', 'Batch']])
    ];
    await service.spreadsheets.values.batchUpdate({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, requestBody: { valueInputOption: 'USER_ENTERED', data: headers.map(([title, values]) => ({ range: `'${title}'!A1`, values: [values] })) } });
  })();
  return layoutPromise;
}
async function ensureSecuritySheets() {
  await ensureSheetLayout();
  const service = getSheets();
  let metadata = await readSheetsMetadata('sheets.properties.title,sheets.properties.sheetId');
  let sheetsByTitle = new Map(metadata.data.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
  const missing = Object.keys(securitySheetHeaders).filter((title) => !sheetsByTitle.has(title));
  if (missing.length) {
    await service.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }
    });
    metadata = await readSheetsMetadata('sheets.properties.title,sheets.properties.sheetId');
    sheetsByTitle = new Map(metadata.data.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
  }
  const schemas = new Map();
  for (const title of Object.keys(securitySheetHeaders)) {
    const schema = await readSecuritySheetSchema(service, process.env.GOOGLE_SPREADSHEET_ID, title);
    schemas.set(title, schema.supported ? schema : null);
    if (!schema.supported) {
      console.warn(`Skipping Google Sheets sync for "${title}": ${schema.reason}; no cells were modified.`);
    }
  }
  return { schemas };
}
function deviceRegistrySheetFields(item) {
  return {
    'Student ID': item.studentId || '',
    'Student Name': item.studentName,
    Batch: item.batch,
    Course: item.course,
    'Device ID Hash': item.deviceHash,
    'Registered IP Address': item.registeredIp,
    'First Registered At': item.firstRegisteredAt,
    'Last Seen At': item.lastSeenAt,
    'Device Status': item.status,
    'Last Attendance Subject': item.lastAttendanceSubject,
    'Last Attendance Date': item.lastAttendanceDate,
    'Admin Unlock Timestamp': item.adminUnlockTimestamp || '',
    'Unlock Reason': item.unlockReason || ''
  };
}
async function writeDeviceRegistrySheetRow(record, knownSchema) {
  const schema = knownSchema || (await ensureSecuritySheets()).schemas.get('Device Registry');
  await syncSheetRowsById({
    service: getSheets(),
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    title: 'Device Registry',
    schema,
    idHeader: 'Device ID Hash',
    records: [record],
    fieldsForRecord: deviceRegistrySheetFields,
    onDuplicate: (count) => console.warn(`Skipping duplicate Device ID Hash entries in "Device Registry" (${count} duplicates).`),
    onSkipped: (reason) => console.warn(`Skipping Google Sheets sync for "Device Registry": ${reason}; no cells were modified.`)
  });
}
async function upsertDeviceRegistrySheetRow(record, knownSchema) {
  const pending = deviceRegistrySheetSyncs.get(record.deviceHash);
  if (pending) {
    await pending;
    return upsertDeviceRegistrySheetRow(record, knownSchema);
  }
  const sync = writeDeviceRegistrySheetRow(record, knownSchema);
  deviceRegistrySheetSyncs.set(record.deviceHash, sync);
  try {
    return await sync;
  } finally {
    if (deviceRegistrySheetSyncs.get(record.deviceHash) === sync) {
      deviceRegistrySheetSyncs.delete(record.deviceHash);
    }
  }
}
async function syncDeviceRegistrySheet() {
  const { schemas } = await ensureSecuritySheets();
  const latestRecords = new Map();
  for (const record of listDeviceRegistry(authDb)) {
    const existing = latestRecords.get(record.deviceHash);
    if (!existing || record.status === 'active' || (
      existing.status !== 'active'
      && record.lastSeenAt > existing.lastSeenAt
    )) {
      latestRecords.set(record.deviceHash, record);
    }
  }
  await syncSheetRowsById({
    service: getSheets(),
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    title: 'Device Registry',
    schema: schemas.get('Device Registry'),
    idHeader: 'Device ID Hash',
    records: [...latestRecords.values()],
    fieldsForRecord: deviceRegistrySheetFields,
    onDuplicate: (count) => console.warn(`Skipping duplicate Device ID Hash entries in "Device Registry" (${count} duplicates).`),
    onSkipped: (reason) => console.warn(`Skipping Google Sheets sync for "Device Registry": ${reason}; no cells were modified.`)
  });
}
async function syncAdminAccountsSheet() {
  const { schemas } = await ensureSecuritySheets();
  const schema = schemas.get('Admin Accounts');
  if (!schema) return;
  const rows = authDb.prepare(`
    SELECT admins.id, admins.name, admins.email, admins.role, admins.is_verified, admins.is_active, admins.approval_status,
      admins.removed_at,
      admins.created_at, admins.last_login, admins.last_status_change_at,
      admins.last_password_change_at, admins.failed_login_attempts,
      admins.last_successful_login, admins.account_lock_until,
      CASE WHEN main_admin_config.admin_id = admins.id THEN 'MAIN_ADMIN' ELSE 'ADMIN' END AS effective_role
    FROM admins LEFT JOIN main_admin_config ON main_admin_config.singleton = 1
    ORDER BY created_at
  `).all();
  await syncSheetRowsById({
    service: getSheets(),
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    title: 'Admin Accounts',
    schema,
    idHeader: 'Admin ID',
    records: rows,
    fieldsForRecord: (admin) => ({
      'Admin ID': admin.id,
      'Admin Email': admin.removed_at ? 'Removed' : admin.email,
      'Admin Name': admin.removed_at ? 'Removed' : admin.name,
      'Admin Role': admin.effective_role,
      'Account Status': admin.removed_at ? 'Removed'
        : !admin.is_verified ? 'Pending verification'
          : admin.approval_status === 'pending' ? 'Pending approval'
            : admin.approval_status === 'rejected' ? 'Rejected'
              : admin.is_active ? 'Active' : 'Inactive',
      'Created At': admin.created_at,
      'Last Login At': admin.last_login || '',
      'Last Status Change At': admin.last_status_change_at || '',
      'Last Password Change At': admin.last_password_change_at || '',
      'Failed Login Attempts': admin.failed_login_attempts,
      'Last Successful Login': admin.last_successful_login || '',
      'Account Lock Status': admin.account_lock_until > Date.now() ? 'Locked' : 'Not locked'
    }),
    onDuplicate: (count) => console.warn(`Skipping duplicate Admin ID entries in "Admin Accounts" (${count} duplicates).`),
    onSkipped: (reason) => console.warn(`Skipping Google Sheets sync for "Admin Accounts": ${reason}; no cells were modified.`)
  });
}
async function syncAdminAuditSheet() {
  const { schemas } = await ensureSecuritySheets();
  const schema = schemas.get('Admin Audit Log');
  if (!schema) return;
  const entries = listAdminAuditLog(authDb, 10000).reverse();
  await syncSheetRowsById({
    service: getSheets(),
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    title: 'Admin Audit Log',
    schema,
    idHeader: 'Audit ID',
    records: entries,
    fieldsForRecord: (entry) => ({
      'Audit ID': entry.id,
      Timestamp: entry.timestamp,
      'Admin ID': entry.adminId,
      'Admin Email': entry.adminEmail,
      Action: entry.action,
      'Affected Record': entry.affectedRecord,
      Reason: entry.reason,
      'Acting Admin Role': entry.actingAdminRole || 'ADMIN',
      'Target Admin ID': entry.targetAdminId || '',
      Result: entry.result || 'success'
    }),
    onDuplicate: (count) => console.warn(`Skipping duplicate Audit ID entries in "Admin Audit Log" (${count} duplicates).`),
    onSkipped: (reason) => console.warn(`Skipping Google Sheets sync for "Admin Audit Log": ${reason}; no cells were modified.`)
  });
}
async function styleAttendanceSheets() {
  const metadata = await readSheetsMetadata('sheets.properties.title,sheets.properties.sheetId');
  const ranges = new Map(metadata.data.sheets.map((entry) => [entry.properties.title, entry.properties.sheetId]));
  const sheetTitles = [['Students', 4], ...subjects.map((subject) => [subject, 26])];
  const requests = [];
  for (const [title, endColumnIndex] of sheetTitles) {
    const sheetId = ranges.get(title);
    if (sheetId === undefined) continue;
    const bodyRange = { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex };
    requests.push({
      repeatCell: {
        range: bodyRange,
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 1, blue: 1 },
            textFormat: { foregroundColor: { red: 0.09, green: 0.2, blue: 0.2 }, bold: false },
            verticalAlignment: 'MIDDLE',
            borders: { bottom: { style: 'SOLID', color: { red: 0.88, green: 0.91, blue: 0.9 } } }
          }
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,borders)'
      }
    });
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 1000 },
        properties: { pixelSize: 30 },
        fields: 'pixelSize'
      }
    });
  }
  if (!requests.length) return;
  await getSheets().spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    requestBody: { requests }
  });
}
async function ensureAttendanceCalendar(date = serverNow().date) {
  await ensureSheetLayout();
  const ranges = subjects.map((subject) => `'${subject}'!A1:ZZ10000`);
  const result = await readSheetsBatch(ranges);
  const matrices = new Map(subjects.map((subject, index) => [
    subject,
    result.data.valueRanges[index]?.values || [['Student ID', 'Student Name', 'Batch']]
  ]));
  const recordedDates = [...matrices.values()].flatMap((matrix) =>
    (matrix[0] || []).slice(3).map((value) => String(value || '').trim()).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= date)
  );
  const firstDate = recordedDates.length ? recordedDates.sort()[0] : date;
  const calendarDates = calendarDatesBetween(firstDate, date);
  const metadata = await readSheetsMetadata('sheets.properties.title,sheets.properties.sheetId');
  const sheetIds = new Map(metadata.data.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
  const requests = [];
  const headerUpdates = [];

  for (const subject of subjects) {
    const matrix = matrices.get(subject) || [];
    const header = matrix[0] || [];
    const existingDates = new Set(header.slice(3).map((value) => String(value || '').trim()));
    const missingDates = calendarDates.filter((calendarDate) => !existingDates.has(calendarDate));
    if (missingDates.length) {
      const sheetId = sheetIds.get(subject);
      if (sheetId === undefined) throw new Error(`Subject sheet not found: ${subject}`);
      const destinationStart = Math.max(3, header.length);
      const destinationEnd = destinationStart + missingDates.length;
      const dateIndexes = header.map((value, index) =>
        index >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim()) ? index : -1
      ).filter((index) => index >= 0);
      const requestsForColumns = [{
        insertDimension: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: destinationStart, endIndex: destinationEnd },
          inheritFromBefore: false
        }
      }];
      if (dateIndexes.length) {
        const sourceIndex = dateIndexes[dateIndexes.length - 1];
        for (let offset = 0; offset < missingDates.length; offset += 1) {
          const destinationIndex = destinationStart + offset;
          requestsForColumns.push({
            copyPaste: {
              source: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: sourceIndex, endColumnIndex: sourceIndex + 1 },
              destination: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: destinationIndex, endColumnIndex: destinationIndex + 1 },
              pasteType: 'PASTE_FORMAT'
            }
          });
        }
      }
      requestsForColumns.push(
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: destinationStart, endIndex: destinationEnd },
            properties: { pixelSize: 100 },
            fields: 'pixelSize'
          }
        },
        {
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, endRowIndex: Math.max(matrix.length, 1000), startColumnIndex: destinationStart, endColumnIndex: destinationEnd },
            rule: attendanceValidationRule
          }
        },
        ...[
          ['Present', { red: 0.86, green: 0.95, blue: 0.88 }],
          ['Absent', { red: 0.98, green: 0.88, blue: 0.86 }],
          ['Holiday', { red: 0.86, green: 0.92, blue: 0.98 }]
        ].map(([status, backgroundColor]) => ({
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: destinationStart, endColumnIndex: destinationEnd }],
              booleanRule: {
                condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: status }] },
                format: { backgroundColor }
              }
            },
            index: 0
          }
        }))
      );
      requests.push(...requestsForColumns);
      headerUpdates.push({
        range: `'${subject}'!${columnName(destinationStart)}1`,
        values: [missingDates]
      });
    }
  }

  if (requests.length) {
    await getSheets().spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      requestBody: { requests }
    });
  }
  if (headerUpdates.length) {
    await getSheets().spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: headerUpdates }
    });
  }

  const refreshed = await readSheetsBatch(ranges);
  const dateUpdates = [];
  for (const [index, subject] of subjects.entries()) {
    const matrix = refreshed.data.valueRanges[index]?.values || [];
    const header = matrix[0] || [];
    const dateColumns = new Map();
    for (let columnIndex = 3; columnIndex < header.length; columnIndex += 1) {
      const currentDate = String(header[columnIndex] || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(currentDate)) dateColumns.set(currentDate, columnIndex);
    }
    const orderedDates = newestFirstDates(dateColumns.keys());
    const defaultStatuses = new Map(orderedDates.map((currentDate) => [
      currentDate,
      statusForUnmarkedDate(
        matrix.slice(1)
          .filter((row) => normalizeName(row[1]) && String(row[2] || '').trim())
          .map((row) => row[dateColumns.get(currentDate)]),
        isHolidayDate(currentDate, holidays)
      )
    ]));
    const values = [orderedDates];
    for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
      const row = matrix[rowIndex] || [];
      values.push(orderedDates.map((currentDate) => {
        const status = String(row[dateColumns.get(currentDate)] || '').trim();
        if (!normalizeName(row[1]) || !String(row[2] || '').trim()) return status;
        if (isHolidayDate(currentDate, holidays)) return 'Holiday';
        if (status && status !== 'Not Marked') return status;
        return defaultStatuses.get(currentDate) || '';
      }));
    }
    const currentDates = header.slice(3).map((value) => String(value || '').trim());
    const datesInOrder = currentDates.length === orderedDates.length
      && currentDates.every((currentDate, dateIndex) => currentDate === orderedDates[dateIndex]);
    const statusesMatch = values.slice(1).every((rowValues, rowIndex) =>
      rowValues.every((value, dateIndex) =>
        String(value || '').trim() === String(matrix[rowIndex + 1]?.[dateColumns.get(orderedDates[dateIndex])] || '').trim()
      )
    );
    if (!datesInOrder || !statusesMatch) {
      dateUpdates.push({
        range: `'${subject}'!D1`,
        values
      });
    }
  }
  if (dateUpdates.length) {
    await getSheets().spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: dateUpdates }
    });
  }
}
async function syncAttendanceValidation() {
  const metadata = await readSheetsMetadata('sheets.properties.title,sheets.properties.sheetId');
  const matrixRanges = subjects.map((subject) => `'${subject}'!A1:ZZ10000`);
  const matrixResponse = await readSheetsBatch(matrixRanges);
  const matrices = new Map(matrixResponse.data.valueRanges.map((range, index) => [subjects[index], range.values || []]));
  const requests = [];
  for (const sheet of metadata.data.sheets) {
    if (!subjects.includes(sheet.properties.title)) continue;
    const values = matrices.get(sheet.properties.title) || [];
    const headers = values[0] || [];
    const dateIndexes = headers.map((value, index) => index >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim()) ? index : -1).filter((index) => index >= 0);
    for (const dateIndex of dateIndexes) {
      requests.push({
        setDataValidation: {
          range: { sheetId: sheet.properties.sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: dateIndex, endColumnIndex: dateIndex + 1 },
          rule: attendanceValidationRule
        }
      });
    }
  }
  for (let index = 0; index < requests.length; index += 500) await getSheets().spreadsheets.batchUpdate({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, requestBody: { requests: requests.slice(index, index + 500) } });
}
async function copyDateColumnFormatting(subject, sourceIndex, destinationIndex, insertColumn = false, validationEndRow = 1000, knownSheetId = null) {
  const targetSheet = resolveSubjectSheetTitle(subject);
  let sheetId = knownSheetId;
  if (sheetId === null) {
    const metadata = await readSheetsMetadata('sheets.properties');
    const sheet = metadata.data.sheets.find((entry) => entry.properties.title === targetSheet);
    if (!sheet) throw new Error(`Subject sheet not found: ${targetSheet}`);
    sheetId = sheet.properties.sheetId;
  }
  await getSheets().spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    requestBody: {
      requests: [
        ...(insertColumn ? [{ insertDimension: { range: { sheetId, dimension: 'COLUMNS', startIndex: destinationIndex, endIndex: destinationIndex + 1 }, inheritFromBefore: false } }] : []),
        {
          copyPaste: {
            source: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: sourceIndex, endColumnIndex: sourceIndex + 1 },
            destination: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: destinationIndex, endColumnIndex: destinationIndex + 1 },
            pasteType: 'PASTE_FORMAT'
          }
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: destinationIndex, endIndex: destinationIndex + 1 },
            properties: { pixelSize: 100 },
            fields: 'pixelSize'
          }
        },
        {
          setBasicFilter: {
            filter: { range: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 26 } }
          }
        },
        {
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, endRowIndex: validationEndRow, startColumnIndex: destinationIndex, endColumnIndex: destinationIndex + 1 },
            rule: attendanceValidationRule
          }
        },
        ...['Present', 'Absent', 'Late', 'Leave', 'Holiday'].map((status) => ({
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: destinationIndex, endColumnIndex: destinationIndex + 1 }],
              booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: status }] }, format: { backgroundColor: status === 'Present' ? { red: 0.86, green: 0.95, blue: 0.88 } : status === 'Absent' ? { red: 0.98, green: 0.88, blue: 0.86 } : status === 'Late' ? { red: 1, green: 0.93, blue: 0.76 } : status === 'Leave' ? { red: 1, green: 0.96, blue: 0.78 } : { red: 0.86, green: 0.92, blue: 0.98 } } }
            },
            index: 0
          }
        }))
      ]
    }
  });
}
async function addAttendanceValidationToRow(subject, rowIndex, dateIndexes) {
  const targetSheet = resolveSubjectSheetTitle(subject);
  const metadata = await getSheets().spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, fields: 'sheets.properties.title,sheets.properties.sheetId' });
  const sheet = metadata.data.sheets.find((entry) => entry.properties.title === targetSheet);
  if (!sheet) return;
  await getSheets().spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    requestBody: {
      requests: dateIndexes.map((dateIndex) => ({
        setDataValidation: {
          range: { sheetId: sheet.properties.sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: dateIndex, endColumnIndex: dateIndex + 1 },
          rule: attendanceValidationRule
        }
      }))
    }
  });
}
async function appendRow(subject, values) {
  const targetSheet = resolveSubjectSheetTitle(subject);
  await ensureSheetLayout();
  const result = await getSheets().spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: `'${targetSheet}'!A1:ZZ10000` });
  const matrix = result.data.values || [['Student ID', 'Student Name', 'Batch']];
  const header = matrix[0].length >= 3 ? [...matrix[0]] : ['Student ID', 'Student Name', 'Batch'];
  const date = String(values[0] || '').trim();
  let dateIndex = header.indexOf(date);
  const newDateColumn = dateIndex < 3;
  if (dateIndex < 3) {
    dateIndex = 3;
  }
  const name = normalizeName(values[2]);
  const batch = String(values[3] || '').trim();
  const registeredStudent = (await getStudents()).find((entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.batch === batch);
  const rowIndex = registeredStudent?.id
    ? matrix.findIndex((row, index) => index > 0 && String(row[0] || '').trim() === registeredStudent.id)
    : matrix.findIndex((row, index) => index > 0 && normalizeName(row[1]).toLowerCase() === name.toLowerCase() && String(row[2] || '').trim() === batch);
  const targetRow = rowIndex >= 1 ? rowIndex : matrix.length;
  if (newDateColumn) {
    await copyDateColumnFormatting(targetSheet, 4, dateIndex, true, Math.max(matrix.length, targetRow + 1));
    await getSheets().spreadsheets.values.update({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: `'${targetSheet}'!${columnName(dateIndex)}1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[date]] } });
  }
  await getSheets().spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range: `'${targetSheet}'!A${targetRow + 1}:C${targetRow + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[registeredStudent?.id || matrix[targetRow]?.[0] || '', name, batch]] }
  });
  const attendanceUpdates = [{
    range: `'${targetSheet}'!${columnName(dateIndex)}${targetRow + 1}`,
    values: [[values[6] || 'Absent']]
  }];
  if (rowIndex < 1) {
    const existingDateIndexes = header.map((value, index) => index >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim()) ? index : -1).filter((index) => index >= 0);
    const validationDateIndexes = [...existingDateIndexes.map((index) => newDateColumn ? index + 1 : index), dateIndex];
    await addAttendanceValidationToRow(targetSheet, targetRow, [...new Set(validationDateIndexes)]);
    for (const existingDateIndex of existingDateIndexes) {
      const existingDate = String(header[existingDateIndex] || '').trim();
      if (existingDate >= date || existingDate > serverNow().date) continue;
      attendanceUpdates.push({
        range: `'${targetSheet}'!${columnName(newDateColumn ? existingDateIndex + 1 : existingDateIndex)}${targetRow + 1}`,
        values: [[isHolidayDate(existingDate, holidays) ? 'Holiday' : 'Absent']]
      });
    }
  }
  await getSheets().spreadsheets.values.batchUpdate({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, requestBody: { valueInputOption: 'USER_ENTERED', data: attendanceUpdates } });
}
async function updateRecoveredSessionAbsence(session, name, batch) {
  const targetSheet = resolveSubjectSheetTitle(session.subject);
  const response = await getSheets().spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range: `'${targetSheet}'!A1:ZZ10000`
  });
  const matrix = response.data.values || [];
  const header = matrix[0] || [];
  const dateIndex = header.findIndex((value) => String(value || '').trim() === session.attendanceDate);
  const rowIndex = matrix.findIndex((row, index) => index > 0
    && normalizeName(row[1]).toLowerCase() === name.toLowerCase()
    && String(row[2] || '').trim() === batch);
  if (dateIndex < 3 || rowIndex < 1 || String(matrix[rowIndex][dateIndex] || '').trim() !== 'Absent') {
    return false;
  }
  await getSheets().spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range: `'${targetSheet}'!${columnName(dateIndex)}${rowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Present']] }
  });
  return true;
}
async function readRows(tab) {
  await ensureSheetLayout();
  const normalized = String(tab || '').trim();
  if (!normalized) return [];

  const resolvedTab = normalized === 'Students' || normalized === 'Percentage' ? normalized : resolveSubjectSheetTitle(normalized);
  if (resolvedTab === 'Students' || resolvedTab === 'Percentage') return (await getSheets().spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range: `'${resolvedTab}'!A1:K10000`
  })).data.values || [];

  const result = await getSheets().spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range: `'${resolvedTab}'!A1:ZZ10000`
  });
  if (!subjects.includes(resolvedTab)) return result.data.values || [];
  const matrix = result.data.values || [];
  const rows = [sheetHeaders];
  for (const row of matrix.slice(1)) {
    for (let index = 3; index < (matrix[0] || []).length; index += 1) {
      if (row[index]) rows.push([matrix[0][index], '', row[1], row[2], courseFor(row[2]), normalized, row[index], 'Matrix', '']);
    }
  }
  return rows;
}
async function getStudents() {
  const rows = await readRows('Students');
  return rows.slice(1).map((r) => ({
    id: String(r[0] || '').trim(),
    name: normalizeName(r[1] || r[0]),
    batch: String(r[2] || r[1] || '').trim(),
    course: courseFor(String(r[2] || r[1] || '').trim()),
    email: normalizeEmail(r[3] || '')
  })).filter((s) => s.name && batches.includes(s.batch));
}
async function registerStudent(name, batch, email = '') {
  const normalizedName = normalizeName(name);
  const normalizedEmail = normalizeEmail(email);
  const key = `${normalizedName.toLowerCase()}|${batch}`;
  if (studentRegistrationLocks.has(key)) return studentRegistrationLocks.get(key);

  const registration = (async () => {
    const existing = (await getStudents()).find((student) => student.name.toLowerCase() === normalizedName.toLowerCase() && student.batch === batch);
    if (existing) {
      if (!existing.email && normalizedEmail) {
        const rows = await readRows('Students');
        const rowIndex = rows.findIndex((row, index) => index > 0
          && normalizeName(row[1]).toLowerCase() === normalizedName.toLowerCase()
          && String(row[2] || '').trim() === batch);
        if (rowIndex > 0) {
          await getSheets().spreadsheets.values.update({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: `Students!D${rowIndex + 1}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[normalizedEmail]] }
          });
          existing.email = normalizedEmail;
        }
      }
      return existing;
    }

    await getSheets().spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      range: 'Students!A:D',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      includeValuesInResponse: false,
      requestBody: {
        values: [[`=IF(OR(INDEX(B:B,ROW())="",INDEX(C:C,ROW())=""),"","STU-"&TEXT(ROW()-1,"000000"))`, normalizedName, batch, normalizedEmail]]
      }
    });

    const registered = (await getStudents()).find((student) => student.name.toLowerCase() === normalizedName.toLowerCase() && student.batch === batch);
    if (!registered) throw new Error('Unable to register the student in the Students sheet.');
    await syncRosterToSubjectSheets();
    return registered;
  })();
  studentRegistrationLocks.set(key, registration);
  try {
    return await registration;
  } finally {
    studentRegistrationLocks.delete(key);
  }
}
async function getSubjectStudents(subject) {
  const result = await getSheets().spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: `'${subject}'!A1:ZZ10000` });
  return (result.data.values || []).slice(1).map((row) => ({
    id: String(row[0] || '').trim(),
    name: normalizeName(row[1]),
    batch: String(row[2] || '').trim(),
    course: courseFor(String(row[2] || '').trim())
  })).filter((student) => student.name && batches.includes(student.batch));
}
async function syncAllSubjectStudentIds() {
  await ensureSheetLayout();
  const ranges = ['Students!A:D', ...subjects.map((subject) => `'${subject}'!A1:ZZ10000`)];
  const result = await readSheetsBatch(ranges);
  const studentsMatrix = result.data.valueRanges[0]?.values || [['Student ID', 'Student Name', 'Batch', 'Email']];
  const subjectMatrices = new Map(subjects.map((subject, index) => [
    subject,
    result.data.valueRanges[index + 1]?.values || []
  ]));
  const roster = new Map();
  for (const row of studentsMatrix.slice(1)) {
    const name = normalizeName(row[1]);
    const batch = String(row[2] || '').trim();
    if (!name || !batches.includes(batch)) continue;
    roster.set(`${name.toLowerCase()}|${batch}`, {
      id: String(row[0] || '').trim(),
      name,
      batch
    });
  }

  const missingStudents = new Map();
  for (const [subject, matrix] of subjectMatrices) {
    for (const row of matrix.slice(1)) {
      const name = normalizeName(row[1]);
      const batch = String(row[2] || '').trim();
      const hasAttendance = row.slice(3).some((value) => String(value || '').trim());
      if (!name || !batches.includes(batch) || !hasAttendance) continue;
      const key = `${name.toLowerCase()}|${batch}`;
      if (!roster.has(key) && !missingStudents.has(key)) missingStudents.set(key, { name, batch });
    }
  }

  if (missingStudents.size) {
    const additions = [...missingStudents.values()];
    const firstStudentRow = studentsMatrix.length + 1;
    await getSheets().spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      range: 'Students!A:D',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      includeValuesInResponse: false,
      requestBody: {
        values: additions.map((student, index) => [
          `=IF(OR(INDEX(B:B,ROW())="",INDEX(C:C,ROW())=""),"","STU-"&TEXT(ROW()-1,"000000"))`,
          student.name,
          student.batch,
          ''
        ])
      }
    });
    additions.forEach((student, index) => {
      roster.set(`${student.name.toLowerCase()}|${student.batch}`, {
        ...student,
        id: `STU-${String(firstStudentRow + index - 1).padStart(6, '0')}`
      });
    });
  }

  const updates = [];
  for (const [subject, matrix] of subjectMatrices) {
    for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
      const row = matrix[rowIndex];
      const name = normalizeName(row[1]);
      const batch = String(row[2] || '').trim();
      const hasAttendance = row.slice(3).some((value) => String(value || '').trim());
      if (!name || !batches.includes(batch) || !hasAttendance) continue;
      const student = roster.get(`${name.toLowerCase()}|${batch}`);
      if (student?.id && student.id !== String(row[0] || '').trim()) {
        updates.push({
          range: `'${subject}'!A${rowIndex + 1}`,
          values: [[student.id]]
        });
      }
    }
  }
  if (updates.length) {
    await getSheets().spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates }
    });
  }
}
async function syncRosterToSubjectSheets() {
  const students = await getStudents();
  const ranges = subjects.map((subject) => `'${subject}'!A1:ZZ10000`);
  const result = await readSheetsBatch(ranges);
  for (const [index, subject] of subjects.entries()) {
    const matrix = result.data.valueRanges[index]?.values || [];
    const existing = new Set(matrix.slice(1).map((row) =>
      `${normalizeName(row[1]).toLowerCase()}|${String(row[2] || '').trim()}`
    ));
    const missing = students.filter((student) =>
      !existing.has(`${student.name.toLowerCase()}|${student.batch}`)
    );
    if (!missing.length) continue;
    await getSheets().spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      range: `'${subject}'!A:C`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      includeValuesInResponse: false,
      requestBody: {
        values: missing.map((student) => [student.id, student.name, student.batch])
      }
    });
  }
}
async function findExisting(subject, date, name, batch) {
  const rows = await readRows(subject);
  return rows.slice(1).some((r) => {
    const rowDate = String(r[0] || '').trim();
    const rowName = normalizeName(r[2]);
    const rowBatch = String(r[3] || '').trim();
    const rowId = String(r[1] || '').trim();
    const normalizedName = normalizeName(name);
    const sameDate = rowDate === date;
    const sameName = rowName.toLowerCase() === normalizedName.toLowerCase();
    const sameBatch = rowBatch === batch;
    const sameStudentId = !!rowId && rowId === batch;
    return sameDate && sameName && sameBatch && !sameStudentId
      && (isCountedClassStatus(r[6]) || r[6] === 'Holiday');
  });
}
async function syncPercentage() {
  const all = [];
  for (const subject of subjects) {
    const rows = await readRows(subject);
    rows.slice(1).forEach((r) => all.push({ date: r[0], name: normalizeName(r[2]), batch: r[3], course: r[4], subject, status: r[6] }));
  }
  const identities = new Map();
  const classDates = new Map();
  for (const row of all) {
    if (!row.name || !row.batch || !row.date || !isCountedClassStatus(row.status)) continue;
    const identity = `${row.name.toLowerCase()}|${row.batch}|${row.subject}`;
    if (!identities.has(identity)) identities.set(identity, { name: row.name, batch: row.batch, course: row.course, subject: row.subject, attended: 0 });
    if (row.status === 'Present') identities.get(identity).attended += 1;
    classDates.set(`${row.batch}|${row.subject}|${row.date}`, true);
  }
  const overall = new Map();
  const output = [['Student Name', 'Batch', 'Course', 'Subject', 'Attended Classes', 'Total Classes', 'Subject Percentage', 'Full-Course / Overall Percentage']];
  for (const item of identities.values()) {
    const total = [...classDates.keys()].filter((key) => key.startsWith(`${item.batch}|${item.subject}|`)).length;
    const key = `${item.name.toLowerCase()}|${item.batch}`;
    if (!overall.has(key)) overall.set(key, { attended: 0, total: 0 });
    overall.get(key).attended += item.attended;
    overall.get(key).total += total;
    output.push([item.name, item.batch, item.course, item.subject, item.attended, total, total ? `${((item.attended / total) * 100).toFixed(2)}%` : '0.00%', '']);
  }
  for (let i = 1; i < output.length; i += 1) {
    const totals = overall.get(`${output[i][0].toLowerCase()}|${output[i][1]}`);
    output[i][7] = totals.total ? `${((totals.attended / totals.total) * 100).toFixed(2)}%` : '0.00%';
  }
  await getSheets().spreadsheets.values.clear({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: 'Percentage!A:H' });
  await getSheets().spreadsheets.values.update({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: 'Percentage!A1', valueInputOption: 'USER_ENTERED', requestBody: { values: output } });
}

app.post('/api/auth/signup', async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(req.body.email);
  const rawPhone = String(req.body.phone || '').trim();
  const phoneDigits = rawPhone.replace(/\D/g, '');
  const phone = rawPhone.startsWith('+') ? `+${phoneDigits}` : phoneDigits;
  const password = req.body.password;
  if (!rateLimit(`signup-ip:${req.ip}`, 20, 60 * 60 * 1000) || !rateLimit(rateLimitKey(req, 'signup', email), 5, 60 * 60 * 1000)) {
    return bad(res, 429, 'Too many signup attempts. Try again later.');
  }
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,99}$/u.test(name) || !isValidEmail(email)) return bad(res, 400, 'Enter a valid full name and email address.');
  if (!/^[+]?[\d\s().-]{7,24}$/.test(rawPhone) || phoneDigits.length < 7 || phoneDigits.length > 15) return bad(res, 400, 'Enter a valid phone number.');
  if (!validPassword(password) || password !== req.body.confirmPassword) return bad(res, 400, 'Enter matching passwords of at least 8 characters.');

  if (authDb.prepare('SELECT 1 FROM admins WHERE email = ? COLLATE NOCASE').get(email)) return bad(res, 409, 'An account with this email already exists.');
  if (authDb.prepare('SELECT 1 FROM admins WHERE phone = ?').get(phone)) return bad(res, 409, 'An account with this phone number already exists.');

  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  const adminId = crypto.randomUUID();
  try {
    authDb.prepare(`
      INSERT INTO admins
        (id, name, email, phone, password_hash, role, is_verified, is_active, approval_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ADMIN', 0, 0, 'pending', ?, ?)
    `).run(adminId, name, email, phone, passwordHash, now, now);
    await createOtp(adminId, 'verify');
    res.status(201).json({ ok: true, requiresOtp: true, otpPurpose: 'verify' });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return bad(res, 409, 'An account with this email already exists.');
    authDb.prepare('DELETE FROM admins WHERE id = ? AND is_verified = 0').run(adminId);
    console.error('Unable to create admin signup:', error.message);
    bad(res, 503, emailDeliveryErrorMessage(error));
  }
});
app.post('/api/auth/resend-otp', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  let purpose = String(req.body.purpose || 'verify');
  if (!['verify', 'invite', 'reset'].includes(purpose) || !isValidEmail(email)) return bad(res, 400, 'Enter a valid email address.');
  if (!rateLimit(`otp-ip:${req.ip}`, 10, 60 * 60 * 1000) || !rateLimit(rateLimitKey(req, 'otp-email', email), 5, 60 * 60 * 1000)) {
    return bad(res, 429, 'Too many verification requests. Try again later.');
  }
  const admin = authDb.prepare(`
    SELECT id, name, email, is_verified, is_active, password_hash, must_change_password
    FROM admins WHERE email = ? COLLATE NOCASE
  `).get(email);
  if (!admin) return res.json({ ok: true });
  const activeChallenge = authDb.prepare('SELECT purpose FROM otp_verifications WHERE admin_id = ?').get(admin.id);
  if (purpose === 'verify' && activeChallenge?.purpose === 'invite') purpose = 'invite';
  const invitationActor = purpose === 'invite' ? sessionAdmin(req) : null;
  if (purpose === 'invite' && !invitationActor) return bad(res, 401, 'Main Admin login required to resend an invitation.');
  if (invitationActor && (invitationActor.role !== 'MAIN_ADMIN' || invitationActor.mustChangePassword)) {
    return bad(res, 403, 'Main Admin access required to resend an invitation.');
  }
  const validPurpose = (purpose === 'reset' && admin.is_verified && admin.is_active)
    || (purpose === 'verify' && !admin.is_verified && !!admin.password_hash)
    || (purpose === 'invite' && !admin.is_verified);
  if (!validPurpose) return res.json({ ok: true });

  const previous = authDb.prepare('SELECT last_sent_at FROM otp_verifications WHERE admin_id = ?').get(admin.id);
  if (previous && Date.now() - previous.last_sent_at < 60_000) return bad(res, 429, 'Please wait one minute before requesting another code.');
  try {
    await withOtpOperationLock(admin.id, async () => {
      const latestChallenge = authDb.prepare('SELECT last_sent_at FROM otp_verifications WHERE admin_id = ?').get(admin.id);
      if (latestChallenge && Date.now() - latestChallenge.last_sent_at < 60_000) {
        const error = new Error('Please wait one minute before requesting another code.');
        error.code = 'OTP_RATE_LIMITED';
        throw error;
      }
      if (purpose === 'invite') {
        const currentAdmin = authDb.prepare(`
          SELECT name, password_hash, must_change_password, is_active
          FROM admins WHERE id = ? AND is_verified = 0
        `).get(admin.id);
        if (!currentAdmin) throw new Error('The invitation is no longer valid.');
        const temporaryPassword = await generateTemporaryPassword(currentAdmin.name, currentAdmin.password_hash);
        const passwordHash = await hashPassword(temporaryPassword);
        authDb.prepare(`
          UPDATE admins SET password_hash = ?, must_change_password = 1, is_active = 1, updated_at = ?
          WHERE id = ? AND is_verified = 0
        `).run(passwordHash, new Date().toISOString(), admin.id);
        try {
          await createOtpUnlocked(admin.id, purpose, { temporaryPassword });
        } catch (error) {
          authDb.prepare(`
            UPDATE admins SET password_hash = ?, must_change_password = ?, is_active = ?, updated_at = ?
            WHERE id = ? AND is_verified = 0
          `).run(
            currentAdmin.password_hash,
            currentAdmin.must_change_password,
            currentAdmin.is_active,
            new Date().toISOString(),
            admin.id
          );
          throw error;
        }
      } else {
        await createOtpUnlocked(admin.id, purpose);
      }
    });
    if (purpose === 'invite' && invitationActor) {
      const now = new Date().toISOString();
      authDb.prepare(`
        INSERT INTO admin_audit_log
          (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
        VALUES (?, ?, ?, 'MAIN_ADMIN', ?, 'admin_invite_resend', ?, 'Main Admin resent temporary credentials and a one-time code.', 'success')
      `).run(crypto.randomUUID(), now, invitationActor.id, admin.id, admin.email);
      syncAdminAuditSheet().catch((error) => console.error('Unable to sync invitation resend audit to Google Sheets:', error.message));
    }
    res.json({ ok: true, purpose });
  } catch (error) {
    if (error.code === 'OTP_RATE_LIMITED') return bad(res, 429, error.message);
    console.error('Unable to send admin verification email:', error.message);
    bad(res, 503, emailDeliveryErrorMessage(error));
  }
});
app.post('/api/auth/verify-otp', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = String(req.body.code || '').trim();
  let purpose = String(req.body.purpose || 'verify');
  if (!isValidEmail(email) || !/^\d{6}$/.test(code) || !['verify', 'invite', 'reset'].includes(purpose)) {
    return bad(res, 400, 'Enter a valid email and six-digit verification code.');
  }
  if (!rateLimit(`verify-ip:${req.ip}`, 20, 60 * 60 * 1000)) return bad(res, 429, 'Too many code attempts. Try again later.');
  const admin = authDb.prepare('SELECT * FROM admins WHERE email = ? COLLATE NOCASE').get(email);
  const activeChallenge = admin && authDb.prepare('SELECT purpose FROM otp_verifications WHERE admin_id = ?').get(admin.id);
  if (purpose === 'verify' && activeChallenge?.purpose === 'invite') purpose = 'invite';
  const challenge = admin && authDb.prepare('SELECT * FROM otp_verifications WHERE admin_id = ? AND purpose = ?').get(admin.id, purpose);
  if (!admin || !challenge || challenge.expires_at <= Date.now()) {
    if (challenge) authDb.prepare('DELETE FROM otp_verifications WHERE id = ?').run(challenge.id);
    return bad(res, 400, 'The verification code is invalid or expired. Request a new one.');
  }
  if (challenge.attempts >= 5) {
    authDb.prepare('DELETE FROM otp_verifications WHERE id = ?').run(challenge.id);
    return bad(res, 400, 'Too many incorrect codes. Request a new one.');
  }
  if (!(await bcrypt.compare(code, challenge.otp_hash))) {
    authDb.prepare('UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?').run(challenge.id);
    return bad(res, 400, 'The verification code is incorrect.');
  }

  const isSignup = purpose !== 'reset' && !admin.is_verified && !admin.must_change_password && !!admin.password_hash
    && (purpose === 'verify' || purpose === 'invite');
  const isReset = purpose === 'reset' && !!admin.is_verified && !admin.removed_at;
  if (!isSignup && !isReset) return bad(res, 400, 'The verification request is no longer valid.');
  let passwordHash = admin.password_hash;
  let name = admin.name;
  if (isReset) {
    if (!validPassword(req.body.password) || req.body.password !== req.body.confirmPassword) {
      return bad(res, 400, 'Enter matching passwords of at least 8 characters.');
    }
    passwordHash = await hashPassword(req.body.password);
  }

  const now = new Date().toISOString();
  const completeVerification = authDb.transaction(() => {
    const consumed = authDb.prepare(`
      UPDATE otp_verifications SET verified = 1
      WHERE id = ? AND admin_id = ? AND purpose = ? AND verified = 0
        AND expires_at > ? AND attempts < 5
    `).run(challenge.id, admin.id, purpose, Date.now());
    if (consumed.changes !== 1) {
      const error = new Error('The verification code has already been used or expired.');
      error.code = 'OTP_NOT_VALID';
      throw error;
    }
    authDb.prepare('DELETE FROM otp_verifications WHERE id = ?').run(challenge.id);
    const updated = authDb.prepare(`
      UPDATE admins SET name = ?, password_hash = ?, is_verified = 1,
        is_active = CASE
        WHEN ? = 1 AND (
          id = (SELECT admin_id FROM main_admin_config WHERE singleton = 1)
          OR approval_status = 'approved'
        ) THEN 1
        ELSE is_active
      END,
        approval_status = CASE WHEN id = (SELECT admin_id FROM main_admin_config WHERE singleton = 1) THEN 'approved' ELSE approval_status END,
        must_change_password = CASE WHEN ? = 1 THEN 0 ELSE must_change_password END,
        last_password_change_at = CASE WHEN ? = 1 THEN ? ELSE COALESCE(last_password_change_at, ?) END,
        updated_at = ?
      WHERE id = ? AND role = 'ADMIN' AND is_verified = ? AND removed_at IS NULL
    `).run(name, passwordHash, isSignup ? 1 : 0, isReset ? 1 : 0, isReset ? 1 : 0, now, now, now, admin.id, admin.is_verified);
    if (updated.changes !== 1) {
      const error = new Error('The administrator account is no longer eligible for this verification.');
      error.code = 'OTP_NOT_VALID';
      throw error;
    }
    if (purpose === 'verify' && authDb.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get()?.admin_id === admin.id) {
      authDb.prepare('UPDATE admins SET last_status_change_at = ? WHERE id = ?').run(now, admin.id);
      authDb.prepare(`
        INSERT INTO admin_audit_log
          (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
        VALUES (?, ?, ?, 'MAIN_ADMIN', ?, 'main_admin_bootstrap', ?, 'Main Admin email verified during one-time bootstrap.', 'success')
      `).run(crypto.randomUUID(), now, admin.id, admin.id, admin.id);
    }
    if (isReset) authDb.prepare('DELETE FROM auth_sessions WHERE admin_id = ?').run(admin.id);
    if (isReset) {
      authDb.prepare(`
        UPDATE admins SET failed_login_attempts = 0, account_lock_until = NULL
        WHERE id = ?
      `).run(admin.id);
    }
  });
  try {
    completeVerification();
  } catch (error) {
    if (error.code === 'OTP_NOT_VALID') return bad(res, 400, 'The verification request has already been used or is no longer valid.');
    throw error;
  }
  let emailNotification = 'not-requested';
  if (isSignup) {
    if (!isEmailConfigured()) emailNotification = 'not-configured';
    else {
      try {
        await sendWelcomeEmail({
          to: admin.email,
          name,
          email: admin.email,
          role: admin.role,
          approvalPending: admin.approval_status === 'pending'
        });
        emailNotification = 'sent';
      } catch {
        emailNotification = 'failed';
      }
    }
  }
  let accountReportSync = 'synced';
  for (const sync of [syncAdminAccountsSheet, syncAdminAuditSheet]) {
    try {
      await sync();
    } catch (error) {
      accountReportSync = 'failed';
      console.error('Admin verification was completed, but an admin report could not be synchronized:', error.message);
    }
  }
  res.json({
    ok: true,
    emailNotification,
    accountReportSync,
    approvalPending: isSignup && admin.approval_status === 'pending'
  });
});
app.post('/api/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const ipKey = `login-ip:${req.ip}`;
  const emailKey = rateLimitKey(req, 'login-email', email);
  if (!rateLimit(ipKey, 30, 15 * 60 * 1000) || !rateLimit(emailKey, 8, 15 * 60 * 1000)) {
    return bad(res, 429, 'Too many login attempts. Try again in 15 minutes.');
  }
  const admin = isValidEmail(email)
    ? authDb.prepare('SELECT * FROM admins WHERE email = ? COLLATE NOCASE').get(email)
    : null;
  if (admin?.account_lock_until > Date.now()) {
    return bad(res, 429, 'This admin account is temporarily locked after repeated failed sign-in attempts. Try again in 15 minutes.');
  }
  let passwordMatches = false;
  if (validPassword(req.body.password) && admin?.password_hash?.startsWith('scrypt$')) {
    const [, salt, expectedHex] = admin.password_hash.split('$');
    const candidate = await scrypt(req.body.password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    passwordMatches = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
    if (passwordMatches) {
      const migratedHash = await hashPassword(req.body.password);
      authDb.prepare('UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?').run(migratedHash, new Date().toISOString(), admin.id);
    }
  } else if (validPassword(req.body.password) && admin?.password_hash) {
    passwordMatches = await verifyStoredPassword(req.body.password, admin.password_hash);
  } else {
    await bcrypt.compare(passwordDigest(String(req.body.password || '')), dummyPasswordHash);
  }
  if (admin && passwordMatches && admin.approval_status === 'pending') {
    return bad(res, 403, 'Your account is waiting for Main Admin approval before signing in.');
  }
  if (!admin || !passwordMatches) {
    if (admin) {
      const attempts = admin.failed_login_attempts + 1;
      const lockedUntil = attempts >= 8 ? Date.now() + 15 * 60 * 1000 : null;
      authDb.prepare(`
        UPDATE admins
        SET failed_login_attempts = ?, account_lock_until = ?
        WHERE id = ?
      `).run(lockedUntil ? 0 : attempts, lockedUntil, admin.id);
    }
    return bad(res, 401, 'Invalid email or password, or account is not verified or active.');
  }
  if (admin.approval_status !== 'approved' || admin.removed_at || admin.role !== 'ADMIN') {
    return bad(res, 401, 'Invalid email or password, or account is not verified or active.');
  }
  const needsEmailVerification = !admin.is_verified && !admin.must_change_password;
  if (!admin.is_active && !needsEmailVerification) {
    return bad(res, 403, 'This admin account is inactive. Contact the Main Admin for assistance.');
  }
  if (admin.must_change_password || needsEmailVerification) {
    const challengePurpose = admin.must_change_password ? 'invite' : 'verify';
    const challenge = authDb.prepare(`
      SELECT * FROM otp_verifications WHERE admin_id = ? AND purpose = ?
    `).get(admin.id, challengePurpose);
    if (!req.body.otp) return bad(res, 428, 'Enter the one-time code sent to your email to continue signing in.');
    if (!/^\d{6}$/.test(String(req.body.otp)) || !challenge || challenge.expires_at <= Date.now() || challenge.attempts >= 5) {
      if (challenge?.expires_at <= Date.now() || challenge?.attempts >= 5) {
        authDb.prepare('DELETE FROM otp_verifications WHERE id = ?').run(challenge.id);
      }
      return bad(res, 401, 'The one-time code is invalid or expired. Ask the Main Admin to resend your verification code.');
    }
    if (!(await bcrypt.compare(String(req.body.otp), challenge.otp_hash))) {
      const attempts = challenge.attempts + 1;
      if (attempts >= 5) authDb.prepare('DELETE FROM otp_verifications WHERE id = ?').run(challenge.id);
      else authDb.prepare('UPDATE otp_verifications SET attempts = ? WHERE id = ?').run(attempts, challenge.id);
      return bad(res, 401, 'The one-time code is incorrect.');
    }
    const now = new Date().toISOString();
    try {
      authDb.transaction(() => {
        const consumed = authDb.prepare(`
          UPDATE otp_verifications SET verified = 1
          WHERE id = ? AND admin_id = ? AND purpose = ? AND verified = 0
            AND expires_at > ? AND attempts < 5
        `).run(challenge.id, admin.id, challengePurpose, Date.now());
        if (consumed.changes !== 1) throw new Error('The invitation code has already been used or expired.');
        const verified = authDb.prepare(`
          UPDATE admins SET is_verified = 1, is_active = 1, updated_at = ?
          WHERE id = ? AND must_change_password = ? AND is_verified = 0
            AND approval_status = 'approved' AND removed_at IS NULL
            AND (is_active = 1 OR ? = 0)
        `).run(now, admin.id, admin.must_change_password ? 1 : 0, admin.must_change_password ? 1 : 0);
        if (verified.changes !== 1) throw new Error('This invitation is no longer valid.');
        authDb.prepare('DELETE FROM otp_verifications WHERE id = ?').run(challenge.id);
        authDb.prepare(`
          INSERT INTO admin_audit_log
            (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
          VALUES (?, ?, ?, 'ADMIN', ?, ?, ?, ?, 'success')
        `).run(
          crypto.randomUUID(),
          now,
          admin.id,
          admin.id,
          challengePurpose === 'invite' ? 'admin_invite_login' : 'admin_email_verified_login',
          admin.email,
          challengePurpose === 'invite'
            ? 'First sign-in verified with invitation code; password change required.'
            : 'Email verified with one-time code during sign-in.'
        );
      })();
    } catch {
      return bad(res, 401, 'The one-time code has already been used, expired, or is no longer valid.');
    }
    admin.is_verified = 1;
    admin.is_active = 1;
  }
  authRateLimits.delete(ipKey);
  authRateLimits.delete(emailKey);
  const loggedInAt = new Date().toISOString();
  authDb.prepare(`
    UPDATE admins SET last_login = ?, last_successful_login = ?,
      failed_login_attempts = 0, account_lock_until = NULL
    WHERE id = ?
  `).run(loggedInAt, loggedInAt, admin.id);
  authDb.prepare(`
    INSERT INTO admin_audit_log
      (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
    SELECT ?, ?, admins.id,
      CASE WHEN main_admin_config.admin_id = admins.id THEN 'MAIN_ADMIN' ELSE 'ADMIN' END,
      admins.id, 'admin_login', admins.email, 'Successful administrator login.', 'success'
    FROM admins CROSS JOIN main_admin_config WHERE admins.id = ?
  `).run(crypto.randomUUID(), loggedInAt, admin.id);
  const cookie = instructorCookie(admin.id);
  res.setHeader('Set-Cookie', `instructor=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ ok: true, mustChangePassword: !!admin.must_change_password });
  Promise.all([
    syncAdminAccountsSheet().catch((error) => console.error('Unable to sync admin login report to Google Sheets:', error.message)),
    syncAdminAuditSheet().catch((error) => console.error('Unable to sync admin audit report to Google Sheets:', error.message))
  ]);
});
app.post('/api/auth/change-password', async (req, res) => {
  const admin = sessionAdmin(req);
  if (!admin) return bad(res, 401, 'Admin login required.');
  if (!admin.mustChangePassword) return bad(res, 409, 'A temporary password change is not pending.');
  if (!validPassword(req.body.password) || req.body.password !== req.body.confirmPassword) {
    return bad(res, 400, 'Enter matching passwords of at least 8 characters.');
  }
  const storedPassword = authDb.prepare('SELECT password_hash FROM admins WHERE id = ?').get(admin.id)?.password_hash;
  if (storedPassword && await verifyStoredPassword(req.body.password, storedPassword)) {
    return bad(res, 400, 'Choose a new password different from the temporary password.');
  }
  const now = new Date().toISOString();
  const raw = req.headers.cookie?.match(/(?:^|; )instructor=([^;]+)/)?.[1];
  const sessionId = raw?.slice(0, raw.lastIndexOf('.'));
  if (!sessionId) return bad(res, 401, 'Admin login required.');
  const currentSessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
  try {
    const passwordHash = await hashPassword(req.body.password);
    authDb.transaction(() => {
      const updated = authDb.prepare(`
        UPDATE admins SET password_hash = ?, must_change_password = 0, last_password_change_at = ?, updated_at = ?
        WHERE id = ? AND must_change_password = 1 AND is_active = 1 AND removed_at IS NULL
      `).run(passwordHash, now, now, admin.id);
      if (updated.changes !== 1) throw new Error('Temporary password change is no longer pending.');
      authDb.prepare('DELETE FROM auth_sessions WHERE admin_id = ? AND token_hash != ?').run(admin.id, currentSessionHash);
      authDb.prepare(`
        INSERT INTO admin_audit_log
          (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
        VALUES (?, ?, ?, 'ADMIN', ?, 'admin_password_change', ?, 'Temporary password changed after first sign-in.', 'success')
      `).run(crypto.randomUUID(), now, admin.id, admin.id, admin.email);
    })();
    res.json({ ok: true });
    Promise.all([
      syncAdminAccountsSheet().catch((error) => console.error('Unable to sync admin password change to Google Sheets:', error.message)),
      syncAdminAuditSheet().catch((error) => console.error('Unable to sync admin password change audit to Google Sheets:', error.message))
    ]);
  } catch (error) {
    console.error('Unable to change temporary admin password:', error.message);
    bad(res, 500, 'Unable to change the temporary password. Please try again.');
  }
});
app.post('/api/auth/logout', (req, res) => {
  const raw = req.headers.cookie?.match(/(?:^|; )instructor=([^;]+)/)?.[1];
  const sessionId = raw?.slice(0, raw.lastIndexOf('.'));
  if (sessionId) authDb.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(crypto.createHash('sha256').update(sessionId).digest('hex'));
  res.setHeader('Set-Cookie', 'instructor=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const admin = sessionAdmin(req);
  res.json({
    instructor: !!admin,
    admin: admin ? {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      mustChangePassword: !!admin.mustChangePassword
    } : null
  });
});
app.get('/api/auth/status', (req, res) => {
  const hasClaimableAdmins = !!authDb.prepare(`
    SELECT 1 AS present FROM admins
    WHERE is_verified = 1 AND is_active = 1 AND approval_status = 'approved'
      AND removed_at IS NULL AND password_hash IS NOT NULL
    LIMIT 1
  `).get();
  const mainAdmin = authDb.prepare(`
    SELECT main_admin_config.admin_id, admins.is_verified
    FROM main_admin_config
    LEFT JOIN admins ON admins.id = main_admin_config.admin_id
    WHERE main_admin_config.singleton = 1
  `).get();
  const pendingMainAdminVerification = !!mainAdmin?.admin_id && !mainAdmin.is_verified;
  res.json({
    firstAdminSetupRequired: !mainAdmin?.admin_id,
    bootstrapMode: hasClaimableAdmins ? 'claim' : 'create',
    bootstrapAvailable: mainAdminBootstrapSecret.length >= 32,
    pendingMainAdminVerification
  });
});
app.post('/api/auth/bootstrap', async (req, res) => {
  if (!rateLimit(`bootstrap-ip:${req.ip}`, 5, 60 * 60 * 1000)) return bad(res, 429, 'Too many bootstrap attempts. Try again later.');
  if (!bootstrapSecretMatches(req.body.bootstrapSecret)) return bad(res, 403, 'The Main Admin bootstrap secret is invalid or not configured.');
  const email = normalizeEmail(req.body.email);
  const existingAdmin = isValidEmail(email)
    ? authDb.prepare('SELECT * FROM admins WHERE email = ? COLLATE NOCASE').get(email)
    : null;
  const mainAdminId = authDb.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get()?.admin_id;
  if (mainAdminId) return bad(res, 409, 'Main Admin setup has already been completed.');

  if (existingAdmin) {
    if (!existingAdmin.is_verified || !existingAdmin.is_active || existingAdmin.approval_status !== 'approved'
      || existingAdmin.removed_at || !existingAdmin.password_hash) {
      return bad(res, 403, 'Use an existing verified, active, approved admin account to claim Main Admin access.');
    }
    const passwordMatches = existingAdmin.password_hash.startsWith('scrypt$')
      ? await (async () => {
        const [, salt, expectedHex] = existingAdmin.password_hash.split('$');
        const candidate = await scrypt(String(req.body.password || ''), salt, 64);
        const expected = Buffer.from(expectedHex, 'hex');
        return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
      })()
      : await verifyStoredPassword(String(req.body.password || ''), existingAdmin.password_hash);
    if (!passwordMatches) return bad(res, 401, 'The existing admin password is incorrect.');
    const now = new Date().toISOString();
    try {
      authDb.transaction(() => {
        const claimed = authDb.prepare(`
          UPDATE main_admin_config SET admin_id = ?, created_at = ?
          WHERE singleton = 1 AND admin_id IS NULL
        `).run(existingAdmin.id, now);
        if (claimed.changes !== 1) throw new Error('Main Admin setup has already been completed.');
        authDb.prepare(`
          INSERT INTO admin_audit_log
            (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
          VALUES (?, ?, ?, 'MAIN_ADMIN', ?, 'main_admin_bootstrap', ?, ?, 'success')
        `).run(crypto.randomUUID(), now, existingAdmin.id, existingAdmin.id, existingAdmin.email, 'Main Admin claimed using the one-time bootstrap secret.');
      })();
    } catch (error) {
      return bad(res, 409, error.message);
    }
    const reportResults = await Promise.all(
      [syncAdminAccountsSheet, syncAdminAuditSheet].map((sync) => sync()
        .then(() => true)
        .catch((error) => {
          console.error('Main Admin was assigned, but its Google Sheets report could not be synchronized:', error.message);
          return false;
        }))
    );
    return res.json({
      ok: true,
      requiresOtp: false,
      claimedExistingAccount: true,
      accountReportSync: reportResults.every(Boolean) ? 'synced' : 'failed'
    });
  }

  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,99}$/u.test(name) || !isValidEmail(email)) return bad(res, 400, 'Enter a valid full name and email address.');
  if (!validPassword(req.body.password) || req.body.password !== req.body.confirmPassword) return bad(res, 400, 'Enter matching passwords of at least 8 characters.');
  const now = new Date().toISOString();
  const adminId = crypto.randomUUID();
  const passwordHash = await hashPassword(req.body.password);
  try {
    authDb.transaction(() => {
      if (authDb.prepare('SELECT 1 AS present FROM main_admin_config WHERE singleton = 1 AND admin_id IS NOT NULL').get()) {
        throw new Error('Main Admin setup has already been completed.');
      }
      if (authDb.prepare(`
        SELECT 1 AS present FROM admins
        WHERE is_verified = 1 AND is_active = 1 AND approval_status = 'approved'
          AND removed_at IS NULL AND password_hash IS NOT NULL
        LIMIT 1
      `).get()) {
        const error = new Error('An existing admin account must claim Main Admin setup.');
        error.code = 'MAIN_ADMIN_ALREADY_INITIALIZED';
        throw error;
      }
      authDb.prepare(`
        INSERT INTO admins
          (id, name, email, password_hash, role, is_verified, is_active, created_at, updated_at, last_password_change_at, last_status_change_at)
        VALUES (?, ?, ?, ?, 'ADMIN', 0, 0, ?, ?, ?, ?)
      `).run(adminId, name, email, passwordHash, now, now, now, now);
      const claimed = authDb.prepare(`
        UPDATE main_admin_config SET admin_id = ?, created_at = ?
        WHERE singleton = 1 AND admin_id IS NULL
      `).run(adminId, now);
      if (claimed.changes !== 1) {
        const error = new Error('Main Admin setup has already been completed.');
        error.code = 'MAIN_ADMIN_ALREADY_INITIALIZED';
        throw error;
      }
    })();
    await createOtp(adminId, 'verify');
    res.status(201).json({ ok: true, requiresOtp: true, otpPurpose: 'verify' });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return bad(res, 409, 'An account with this email already exists.');
    if (error.code === 'MAIN_ADMIN_ALREADY_INITIALIZED') return bad(res, 409, error.message);
    authDb.transaction(() => {
      authDb.prepare('UPDATE main_admin_config SET admin_id = NULL, created_at = NULL WHERE singleton = 1 AND admin_id = ?').run(adminId);
      authDb.prepare('DELETE FROM admins WHERE id = ? AND is_verified = 0').run(adminId);
    })();
    console.error('Unable to initialize Main Admin:', error.message);
    return bad(res, 503, emailDeliveryErrorMessage(error));
  }
});
app.get('/api/admins', requireInstructor, requireMainAdmin, (req, res) => {
  const admins = authDb.prepare(`
    SELECT admins.id, admins.name, admins.email,
    admins.phone, admins.approval_status AS approvalStatus,
    CASE WHEN main_admin_config.admin_id = admins.id THEN 'MAIN_ADMIN' ELSE 'ADMIN' END AS role,
      admins.is_verified AS isVerified, admins.is_active AS isActive, admins.removed_at AS removedAt,
      admins.created_at AS createdAt, admins.updated_at AS updatedAt, admins.last_login AS lastLogin,
      admins.last_status_change_at AS lastStatusChangeAt,
      admins.last_password_change_at AS lastPasswordChangeAt,
      admins.failed_login_attempts AS failedLoginAttempts,
      admins.last_successful_login AS lastSuccessfulLogin,
      admins.account_lock_until AS accountLockUntil
    FROM admins CROSS JOIN main_admin_config
    WHERE admins.removed_at IS NULL
    ORDER BY admins.created_at
  `).all().map((admin) => ({
    ...admin,
    ...(admin.removedAt ? {
      name: 'Removed admin',
      email: 'Removed',
      phone: null,
      lastLogin: null,
      lastPasswordChangeAt: null,
      lastSuccessfulLogin: null,
      failedLoginAttempts: 0,
      accountLockUntil: null
    } : {}),
    isVerified: !!admin.isVerified,
    isActive: !!admin.isActive,
    accountLockStatus: admin.accountLockUntil > Date.now() ? 'Locked' : 'Not locked',
    status: admin.removedAt ? 'Removed'
      : admin.approvalStatus === 'pending' ? (admin.isVerified ? 'Pending approval' : 'Pending verification')
        : admin.approvalStatus === 'rejected' ? 'Rejected'
          : !admin.isVerified ? (admin.isActive ? 'Pending verification' : 'Pending verification · Access approved')
            : admin.isActive ? 'Active' : 'Inactive',
    subjects: assignedSubjects({ id: admin.id, role: admin.role })
  }));
  res.json(admins);
});
app.get('/api/admins/pending', requireInstructor, requireMainAdmin, (req, res) => {
  const pending = authDb.prepare(`
    SELECT id, name, email, phone, created_at AS createdAt, is_verified AS isVerified,
      approval_status AS approvalStatus
    FROM admins
    WHERE role = 'ADMIN' AND removed_at IS NULL
      AND (approval_status = 'pending' OR (approval_status = 'approved' AND is_verified = 0))
    ORDER BY created_at
  `).all().map((admin) => ({
    ...admin,
    isVerified: !!admin.isVerified,
    canReview: !!admin.isVerified && admin.approvalStatus === 'pending',
    reviewStatus: !admin.isVerified
      ? 'Awaiting email verification'
      : admin.approvalStatus === 'pending' ? 'Pending Main Admin approval' : 'Awaiting first sign-in'
  }));
  res.json(pending);
});
app.post('/api/admins/:id/approval', requireInstructor, requireMainAdmin, async (req, res) => {
  const decision = String(req.body.decision || '');
  const reason = String(req.body.reason || 'Main Admin granted access from the administrator list.').trim();
  if (!['approve', 'reject'].includes(decision)) return bad(res, 400, 'Choose approve or reject.');
  if (reason.length < 5 || reason.length > 500) return bad(res, 400, 'Enter a reason between 5 and 500 characters.');
  const now = new Date().toISOString();
  let grantResult;
  try {
    grantResult = authDb.transaction(() => {
      const target = authDb.prepare(`
        SELECT id, email, is_verified, is_active, approval_status
        FROM admins WHERE id = ? AND role = 'ADMIN' AND removed_at IS NULL
      `).get(req.params.id);
      if (!target || (target.approval_status !== 'pending' && !target.is_verified)) {
        throw new Error('This pending regular admin was not found.');
      }
      if (decision === 'approve' && target.approval_status === 'approved'
        && assignedSubjects({ id: target.id, role: 'ADMIN' }).length === subjects.length) {
        return { alreadyGranted: true, isVerified: !!target.is_verified, isActive: !!target.is_active };
      }
      const status = decision === 'approve' ? 'approved' : 'rejected';
      const active = decision === 'approve' && target.is_verified ? 1 : 0;
      const changed = authDb.prepare(`
        UPDATE admins SET approval_status = ?, is_active = ?, approval_reviewed_at = ?,
          approval_reviewed_by = ?, last_status_change_at = ?, updated_at = ?
        WHERE id = ? AND role = 'ADMIN' AND removed_at IS NULL
          AND (approval_status = 'pending' OR is_verified = 0)
      `).run(status, active, now, req.admin.id, now, now, target.id);
      if (changed.changes !== 1) throw new Error('This admin has already been reviewed.');
      authDb.prepare('DELETE FROM admin_subject_assignments WHERE admin_id = ?').run(target.id);
      if (decision === 'approve') {
        const assign = authDb.prepare('INSERT INTO admin_subject_assignments (admin_id, subject, assigned_at, assigned_by) VALUES (?, ?, ?, ?)');
        for (const subject of subjects) assign.run(target.id, subject, now, req.admin.id);
      }
      authDb.prepare(`
        INSERT INTO admin_audit_log
          (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
        VALUES (?, ?, ?, 'MAIN_ADMIN', ?, ?, ?, ?, 'success')
      `).run(crypto.randomUUID(), now, req.admin.id, target.id, `admin_${decision}`, target.email, reason);
      if (decision === 'reject') authDb.prepare('DELETE FROM auth_sessions WHERE admin_id = ?').run(target.id);
      return { alreadyGranted: false, isVerified: !!target.is_verified, isActive: !!active };
    })();
  } catch (error) {
    return bad(res, error.message.includes('already been reviewed') ? 409 : 404, error.message);
  }
  if (grantResult.alreadyGranted) {
    return res.json({
      ok: true,
      approvalStatus: 'approved',
      active: grantResult.isActive,
      requiresOtp: !grantResult.isVerified,
      alreadyGranted: true
    });
  }
  Promise.all([
    syncAdminAccountsSheet().catch((error) => console.error('Unable to sync approval to admin report:', error.message)),
    syncAdminAuditSheet().catch((error) => console.error('Unable to sync approval audit:', error.message))
  ]);
  let otpDelivery = 'not-required';
  let otpDeliveryMessage;
  if (decision === 'approve' && !grantResult.isVerified) {
    try {
      let reusedChallenge = false;
      await withOtpOperationLock(req.params.id, async () => {
        const currentChallenge = authDb.prepare(`
          SELECT purpose, expires_at, attempts, verified
          FROM otp_verifications WHERE admin_id = ?
        `).get(req.params.id);
        if (
          currentChallenge?.purpose === 'verify'
          && currentChallenge.expires_at > Date.now()
          && currentChallenge.attempts < 5
          && !currentChallenge.verified
        ) {
          reusedChallenge = true;
          return;
        }
        await createOtpUnlocked(req.params.id, 'verify');
      });
      otpDelivery = reusedChallenge ? 'already-sent' : 'sent';
    } catch (error) {
      otpDelivery = error.code === 'OTP_RATE_LIMITED'
        ? 'not-sent'
        : isEmailConfigured() ? 'failed' : 'not-configured';
      otpDeliveryMessage = emailDeliveryErrorMessage(error);
      console.error('Admin access was approved, but its verification OTP could not be sent:', error.message);
    }
  }
  res.json({
    ok: true,
    approvalStatus: decision === 'approve' ? 'approved' : 'rejected',
    active: grantResult.isActive,
    requiresOtp: !grantResult.isVerified,
    otpDelivery,
    ...(otpDeliveryMessage ? { otpDeliveryMessage } : {})
  });
});
app.put('/api/admins/:id/subjects', requireInstructor, requireMainAdmin, (req, res) => {
  const selectedSubjects = req.body.subjects;
  const reason = String(req.body.reason || '').trim();
  if (!Array.isArray(selectedSubjects) || selectedSubjects.some((subject) => typeof subject !== 'string' || !subjects.includes(subject))
    || new Set(selectedSubjects).size !== selectedSubjects.length) {
    return bad(res, 400, 'Choose valid subjects.');
  }
  if (reason.length < 5 || reason.length > 500) return bad(res, 400, 'Enter a reason between 5 and 500 characters.');
  const now = new Date().toISOString();
  try {
    authDb.transaction(() => {
      const target = authDb.prepare(`
        SELECT admins.id, admins.email FROM admins
        LEFT JOIN main_admin_config ON main_admin_config.singleton = 1
        WHERE admins.id = ? AND admins.removed_at IS NULL
          AND admins.id != main_admin_config.admin_id
          AND admins.approval_status = 'approved' AND admins.is_verified = 1
      `).get(req.params.id);
      if (!target) throw new Error('Approved regular admin not found.');
      authDb.prepare('DELETE FROM admin_subject_assignments WHERE admin_id = ?').run(target.id);
      const assign = authDb.prepare('INSERT INTO admin_subject_assignments (admin_id, subject, assigned_at, assigned_by) VALUES (?, ?, ?, ?)');
      for (const subject of selectedSubjects) assign.run(target.id, subject, now, req.admin.id);
      authDb.prepare(`
        INSERT INTO admin_audit_log
          (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
        VALUES (?, ?, ?, 'MAIN_ADMIN', ?, 'admin_subjects_updated', ?, ?, 'success')
      `).run(crypto.randomUUID(), now, req.admin.id, target.id, target.email, `${reason} Subject access: ${selectedSubjects.join(', ') || 'none'}.`);
      if (!selectedSubjects.length) authDb.prepare('DELETE FROM auth_sessions WHERE admin_id = ?').run(target.id);
    })();
  } catch (error) {
    return bad(res, 404, error.message);
  }
  res.json({ ok: true, subjects: selectedSubjects });
});
app.get('/api/admins/devices', requireInstructor, (req, res) => {
  res.json(listDeviceRegistry(authDb).map(({ deviceHash, ...record }) => record));
});
app.get('/api/admins/audit-log', requireInstructor, (req, res) => {
  res.json(listAdminAuditLog(authDb, 200, 'devices'));
});
app.get('/api/admins/account-audit-log', requireInstructor, requireMainAdmin, (req, res) => {
  res.json(listAdminAuditLog(authDb, 500, 'accounts'));
});
app.post('/api/admins/devices/:id/unlock', requireInstructor, async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (req.body.confirm !== true) return bad(res, 400, 'Confirm the device unlock before continuing.');
  if (reason.length < 5 || reason.length > 500) return bad(res, 400, 'Enter an unlock reason between 5 and 500 characters.');
  const unlocked = unlockDevice(authDb, {
    id: req.params.id,
    adminId: req.admin.id,
    actingAdminRole: req.admin.role,
    reason
  });
  if (!unlocked) return bad(res, 404, 'Active device registration not found.');

  const syncErrors = [];
  const deviceRecord = listDeviceRegistry(authDb).find((record) => record.id === unlocked.id);
  const syncOperations = [syncAdminAuditSheet];
  if (deviceRecord) syncOperations.unshift(() => upsertDeviceRegistrySheetRow(deviceRecord));
  for (const sync of syncOperations) {
    try {
      await sync();
    } catch (error) {
      console.error('Unable to sync admin device unlock to Google Sheets:', error.message);
      syncErrors.push(error.message);
    }
  }
  res.json({
    ok: true,
    registrySync: syncErrors.length ? 'failed' : 'synced'
  });
});
app.post('/api/admins/invite', requireInstructor, requireMainAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(req.body.email);
  const selectedSubjects = req.body.subjects;
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,99}$/u.test(name) || !isValidEmail(email)) return bad(res, 400, 'Enter a valid full name and email address.');
  if (req.body.role !== undefined && req.body.role !== 'ADMIN') return bad(res, 400, 'Only regular ADMIN accounts can be created.');
  if (!Array.isArray(selectedSubjects) || !selectedSubjects.length
    || selectedSubjects.some((subject) => typeof subject !== 'string' || !subjects.includes(subject))
    || new Set(selectedSubjects).size !== selectedSubjects.length) {
    return bad(res, 400, 'Select at least one valid subject for this admin.');
  }
  if (!rateLimit(`invite:${req.ip}:${req.admin.id}`, 20, 60 * 60 * 1000)) return bad(res, 429, 'Too many invitations. Try again later.');
  if (authDb.prepare('SELECT 1 AS present FROM admins WHERE email = ? COLLATE NOCASE').get(email)) {
    return bad(res, 409, 'An admin account or invitation already exists for this email.');
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const temporaryPassword = await generateTemporaryPassword(name);
  const passwordHash = await hashPassword(temporaryPassword);
  authDb.prepare(`
    INSERT INTO admins
      (id, name, email, password_hash, role, is_verified, is_active, must_change_password, created_at, updated_at, last_status_change_at)
    VALUES (?, ?, ?, ?, 'ADMIN', 0, 1, 1, ?, ?, ?)
  `).run(id, name, email, passwordHash, now, now, now);
  const assignInvitedSubject = authDb.prepare(`
    INSERT INTO admin_subject_assignments (admin_id, subject, assigned_at, assigned_by)
    VALUES (?, ?, ?, ?)
  `);
  for (const subject of selectedSubjects) assignInvitedSubject.run(id, subject, now, req.admin.id);
  try {
    await createOtp(id, 'invite', { temporaryPassword });
    authDb.prepare(`
      INSERT INTO admin_audit_log
        (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
      VALUES (?, ?, ?, 'MAIN_ADMIN', ?, 'admin_invite', ?, ?, 'success')
    `).run(
      crypto.randomUUID(), now, req.admin.id, id, email,
      `Regular admin invitation sent with temporary credentials and one-time code. Subject access: ${selectedSubjects.join(', ')}.`
    );
    let accountReportSync = 'synced';
    for (const sync of [syncAdminAccountsSheet, syncAdminAuditSheet]) {
      try {
        await sync();
      } catch (syncError) {
        accountReportSync = 'failed';
        console.error('Admin invitation was created, but an admin report could not be synchronized:', syncError.message);
      }
    }
    res.status(201).json({ ok: true, accountReportSync });
  } catch (error) {
    authDb.prepare('DELETE FROM admins WHERE id = ? AND is_verified = 0').run(id);
    console.error('Unable to send admin invitation:', error.message);
    bad(res, 503, emailDeliveryErrorMessage(error));
  }
});
app.patch('/api/admins/:id/status', requireInstructor, requireMainAdmin, async (req, res) => {
  const { active } = req.body;
  if (req.body.confirm !== true) return bad(res, 400, 'Confirm the account status change before continuing.');
  if (typeof active !== 'boolean') return bad(res, 400, 'Admin status must be active or inactive.');
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5 || reason.length > 500) return bad(res, 400, 'Enter a reason between 5 and 500 characters.');
  const now = new Date().toISOString();
  let target;
  try {
    authDb.transaction(() => {
    const actor = authDb.prepare(`
      SELECT admins.is_active, admins.is_verified, admins.removed_at, main_admin_config.admin_id
      FROM admins CROSS JOIN main_admin_config WHERE admins.id = ?
    `).get(req.admin.id);
    if (!actor || !actor.is_active || !actor.is_verified || actor.removed_at || actor.admin_id !== req.admin.id) {
      throw new Error('Main Admin access is no longer active.');
    }
    target = authDb.prepare(`
      SELECT admins.id, admins.name, admins.email, admins.role, admins.is_active, admins.is_verified,
        admins.approval_status, admins.removed_at, main_admin_config.admin_id
      FROM admins CROSS JOIN main_admin_config WHERE admins.id = ?
    `).get(req.params.id);
    if (!target || target.removed_at) throw new Error('Admin account not found.');
    if (target.admin_id === target.id) throw new Error('The Main Admin account cannot be changed through regular admin-management actions.');
    if (!active && target.id === req.admin.id) throw new Error('You cannot deactivate your own Main Admin account.');
    if (active && !target.is_verified) throw new Error('The admin must complete email verification before activation.');
    if (active && target.approval_status !== 'approved') throw new Error('The admin must be approved before activation.');
    authDb.prepare('UPDATE admins SET is_active = ?, updated_at = ?, last_status_change_at = ? WHERE id = ?')
      .run(active ? 1 : 0, now, now, target.id);
    if (!active) authDb.prepare('DELETE FROM auth_sessions WHERE admin_id = ?').run(target.id);
    authDb.prepare(`
      INSERT INTO admin_audit_log
        (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
      VALUES (?, ?, ?, 'MAIN_ADMIN', ?, ?, ?, ?, 'success')
    `).run(crypto.randomUUID(), now, req.admin.id, target.id, active ? 'admin_activate' : 'admin_deactivate', target.id, reason);
    })();
  } catch (error) {
    return bad(res, error.message.includes('access is no longer') ? 403 : 400, error.message);
  }
  let adminReportSync = 'synced';
  for (const sync of [syncAdminAccountsSheet, syncAdminAuditSheet]) {
    try {
      await sync();
    } catch (error) {
      adminReportSync = 'failed';
      console.error('Unable to sync admin account action to Google Sheets:', error.message);
    }
  }
  let emailNotification = 'not-configured';
  if (isEmailConfigured()) {
    try {
      await sendAccountStatusEmail({
        to: target.email,
        name: target.name,
        email: target.email,
        role: target.role,
        active
      });
      emailNotification = 'sent';
    } catch {
      emailNotification = 'failed';
    }
  }
  res.json({ ok: true, emailNotification, adminReportSync });
});
app.patch('/api/admins/:id/details', requireInstructor, requireMainAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const reason = String(req.body.reason || '').trim();
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,99}$/u.test(name)) return bad(res, 400, 'Enter a valid full name.');
  if (reason.length < 5 || reason.length > 500) return bad(res, 400, 'Enter a reason between 5 and 500 characters.');
  const now = new Date().toISOString();
  const target = authDb.prepare('SELECT id, name FROM admins WHERE id = ? AND removed_at IS NULL').get(req.params.id);
  if (!target) return bad(res, 404, 'Admin account not found.');
  if (authDb.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get()?.admin_id === target.id) {
    return bad(res, 400, 'The Main Admin account cannot be edited through regular admin-management actions.');
  }
  authDb.transaction(() => {
    authDb.prepare('UPDATE admins SET name = ?, updated_at = ? WHERE id = ?').run(name, now, target.id);
    authDb.prepare(`
      INSERT INTO admin_audit_log
        (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
      VALUES (?, ?, ?, 'MAIN_ADMIN', ?, 'admin_update', ?, ?, 'success')
    `).run(crypto.randomUUID(), now, req.admin.id, target.id, target.id, reason);
  })();
  let adminReportSync = 'synced';
  for (const sync of [syncAdminAccountsSheet, syncAdminAuditSheet]) {
    try {
      await sync();
    } catch (error) {
      adminReportSync = 'failed';
      console.error('Admin details were updated, but an admin report could not be synchronized:', error.message);
    }
  }
  res.json({ ok: true, adminReportSync });
});
app.post('/api/admins/:id/recovery', requireInstructor, requireMainAdmin, async (req, res) => {
  const target = authDb.prepare(`
    SELECT admins.id, admins.email, admins.is_verified, admins.removed_at, main_admin_config.admin_id
    FROM admins CROSS JOIN main_admin_config WHERE admins.id = ?
  `).get(req.params.id);
  if (!target || target.removed_at || !target.is_verified) return bad(res, 404, 'Verified admin account not found.');
  if (target.id === target.admin_id) return bad(res, 400, 'Use the standard password recovery flow for the Main Admin account.');
  try {
    await createOtp(target.id, 'reset');
  } catch (error) {
    console.error('Unable to initiate admin password recovery:', error.message);
    if (error.code === 'OTP_RATE_LIMITED') return bad(res, 429, error.message);
    return bad(res, 503, emailDeliveryErrorMessage(error));
  }
  const now = new Date().toISOString();
  authDb.prepare(`
    INSERT INTO admin_audit_log
      (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
    VALUES (?, ?, ?, 'MAIN_ADMIN', ?, 'admin_recovery_initiated', ?, 'Password recovery code sent to the account email.', 'success')
  `).run(crypto.randomUUID(), now, req.admin.id, target.id, target.id);
  let adminReportSync = 'synced';
  for (const sync of [syncAdminAccountsSheet, syncAdminAuditSheet]) {
    try {
      await sync();
    } catch (error) {
      adminReportSync = 'failed';
      console.error('Admin recovery was initiated, but an admin report could not be synchronized:', error.message);
    }
  }
  res.json({ ok: true, adminReportSync });
});
app.delete('/api/admins/:id', requireInstructor, requireMainAdmin, async (req, res) => {
  if (req.body.confirm !== true) return bad(res, 400, 'Confirm admin removal before continuing.');
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5 || reason.length > 500) return bad(res, 400, 'Enter a removal reason between 5 and 500 characters.');
  const now = new Date().toISOString();
  try {
    authDb.transaction(() => {
      const actor = authDb.prepare(`
        SELECT admins.is_active, admins.is_verified, admins.removed_at, main_admin_config.admin_id
        FROM admins CROSS JOIN main_admin_config WHERE admins.id = ?
      `).get(req.admin.id);
      if (!actor || !actor.is_active || !actor.is_verified || actor.removed_at || actor.admin_id !== req.admin.id) {
        throw new Error('Main Admin access is no longer active.');
      }
      const target = authDb.prepare(`
        SELECT admins.id, admins.email, admins.name, main_admin_config.admin_id
        FROM admins CROSS JOIN main_admin_config
        WHERE admins.id = ? AND admins.removed_at IS NULL
      `).get(req.params.id);
      if (!target) throw new Error('Admin account not found.');
      if (target.id === actor.admin_id) throw new Error('The Main Admin cannot be removed.');
      const anonymizedEmail = `removed+${target.id}@removed.invalid`;
      const identityValues = [target.name, target.email].filter(Boolean).map((value) => value.toLowerCase());
      const auditReason = identityValues.some((value) => reason.toLowerCase().includes(value))
        ? 'Account removed by Main Admin; identifying details were redacted.'
        : reason;
      authDb.prepare(`
        UPDATE admins SET removed_at = ?, updated_at = ?, last_status_change_at = ?
        WHERE id = ?
      `).run(now, now, now, target.id);
      anonymizeRemovedAdminData(target);
      authDb.prepare(`
        INSERT INTO admin_audit_log
          (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
        VALUES (?, ?, ?, 'MAIN_ADMIN', ?, 'admin_remove', ?, ?, 'success')
      `).run(crypto.randomUUID(), now, req.admin.id, target.id, target.id, auditReason);
    })();
  } catch (error) {
    return bad(res, error.message.includes('access is no longer') ? 403 : 400, error.message);
  }
  let adminReportSync = 'synced';
  for (const sync of [syncAdminAccountsSheet, syncAdminAuditSheet]) {
    try {
      await sync();
    } catch (error) {
      adminReportSync = 'failed';
      console.error('Admin access was removed, but an admin report could not be synchronized:', error.message);
    }
  }
  res.json({ ok: true, adminReportSync });
});
app.get('/api/config', (req, res) => res.json({ subjects, batches }));
app.get('/api/admin/config', requireInstructor, (req, res) => res.json({ subjects: assignedSubjects(req.admin), batches }));

async function finalizeAttendanceSession(session) {
  if (session.closedAt) {
    return session.closeResult || {
      ok: true,
      added: 0,
      emailNotifications: { sent: 0, failed: 0, skipped: 0, status: 'complete' }
    };
  }
  if (session.finalizationPromise) return session.finalizationPromise;

  const finalization = (async () => {
    const date = serverNow().date;
    session.attendanceDate = date;
    const roster = new Map();
    for (const student of [...await getStudents(), ...await getSubjectStudents(session.subject)]) {
      if (!session.batch || student.batch === session.batch) {
        const key = `${student.name.toLowerCase()}|${student.batch}`;
        const previous = roster.get(key);
        roster.set(key, { ...previous, ...student, email: student.email || previous?.email || '' });
      }
    }
    const eligible = [...roster.values()];
    const rows = await readRows(session.subject);
    const dateRows = rows.slice(1).filter((row) =>
      row[0] === date && row[3] && (!session.batch || row[3] === session.batch)
    );
    const existing = new Set(dateRows
      .filter((row) => isCountedClassStatus(row[6]) || row[6] === 'Holiday')
      .map((row) => `${row[2].toLowerCase()}|${row[3]}`));
    const classMarked = dateRows.some((row) => isCountedClassStatus(row[6]));
    let added = 0;
    let emailSent = 0;
    let emailFailed = 0;
    let emailSkipped = 0;
    for (const student of eligible) {
      const key = `${student.name.toLowerCase()}|${student.batch}`;
      if (isHolidayDate(date, holidays) && !existing.has(key)) {
        await appendRow(session.subject, [date, '', student.name, student.batch, student.course, session.subject, 'Holiday', 'Session close', session.id]);
        added += 1;
      } else if (classMarked && !existing.has(key)) {
        const status = isHolidayDate(date, holidays) ? 'Holiday' : 'Absent';
        await appendRow(session.subject, [date, status === 'Absent' ? '-' : '', student.name, student.batch, student.course, session.subject, status, 'Session close', session.id]);
        added += 1;
        if (status === 'Absent') session.absentStudentKeys.add(key);
        if (status === 'Absent' && student.email) {
          if (!isEmailConfigured()) emailSkipped += 1;
          else {
            try {
              await sendAbsenceNotification({
                to: student.email,
                studentName: student.name,
                subject: session.subject,
                date,
                facultyName: session.facultyName
              });
              emailSent += 1;
            } catch {
              emailFailed += 1;
            }
          }
        }
      }
    }
    await syncPercentage();
    session.closedAt = Date.now();
    session.status = 'closed';
    session.closeResult = {
      ok: true,
      added,
      emailNotifications: {
        sent: emailSent,
        failed: emailFailed,
        skipped: emailSkipped,
        status: emailFailed ? 'failed' : emailSkipped ? 'not-configured' : 'complete'
      }
    };
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    return session.closeResult;
  })();
  session.finalizationPromise = finalization;
  try {
    return await finalization;
  } finally {
    if (session.finalizationPromise === finalization) session.finalizationPromise = null;
  }
}

app.post('/api/sessions', requireInstructor, async (req, res) => {
  const { subject, batch } = req.body;
  const durationMinutes = req.body.durationMinutes === undefined ? qrMinutes : req.body.durationMinutes;
  if (!subjects.includes(subject)) return bad(res, 400, 'Invalid subject.');
  if (!requireSubjectAccess(req, res, subject)) return;
  if (batch && !batches.includes(batch)) return bad(res, 400, 'Invalid batch.');
  if (!Number.isSafeInteger(durationMinutes) || !allowedQrMinutes.has(durationMinutes)) {
    return bad(res, 400, 'Choose a QR duration of 5, 10, 20, or 30 minutes.');
  }
  try {
    const now = Date.now();
    const id = crypto.randomUUID();
    const session = {
      id,
      subject,
      batch: batch || null,
      facultyName: req.admin.name,
      createdBy: req.admin.id,
      createdAt: now,
      attendanceDate: serverNow().date,
      expiresAt: now + durationMinutes * 60 * 1000,
      durationMinutes,
      status: 'active',
      markedStudentKeys: new Set(),
      absentStudentKeys: new Set(),
      recoveryCount: 0
    };
    const token = sessionToken(id);
    const baseUrl = resolvePublicUrl(req);
    const url = `${baseUrl}/?session=${encodeURIComponent(token)}`;
    const qr = await QRCode.toDataURL(url, {
      width: 500,
      margin: 4,
      errorCorrectionLevel: 'M'
    });
    session.url = url;
    session.qr = qr;
    sessions.set(id, session);
    session.expiryTimer = setTimeout(() => {
      finalizeAttendanceSession(session).catch((error) => {
        console.error(`Unable to automatically finalize expired attendance session ${session.id}:`, error.message);
      });
    }, session.expiresAt - Date.now());
    session.expiryTimer.unref?.();
    res.json({
      id: session.id,
      subject: session.subject,
      batch: session.batch,
      facultyName: session.facultyName,
      createdBy: session.createdBy,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      durationMinutes: session.durationMinutes,
      status: session.status,
      url,
      qr
    });
  } catch (error) {
    console.error('Unable to generate attendance QR:', error.message);
    const message = error.message.startsWith('No LAN IPv4') || error.message.startsWith('APP_URL')
      ? error.message
      : 'Unable to generate the attendance QR code. Check APP_URL and network settings.';
    bad(res, 503, message);
  }
});
app.get('/api/sessions', requireInstructor, (req, res) => {
  const availableSessions = [...sessions.values()]
    .filter((session) => canAccessSubject(req.admin, session.subject))
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((session) => ({
      id: session.id,
      subject: session.subject,
      attendanceDate: session.attendanceDate,
      batch: session.batch,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      status: session.status === 'active' && session.expiresAt > Date.now() ? 'Active' : 'Closed',
      markedStudents: session.markedStudentKeys.size,
      recoveryStatus: session.recoveryCount
        ? `Recovered ${session.recoveryCount} time${session.recoveryCount === 1 ? '' : 's'}`
        : 'Not recovered',
      lastRecoveredAt: session.lastRecoveredAt || null,
      canRecover: session.status === 'closed' && !!session.closedAt && !session.finalizationPromise
    }));
  res.json(availableSessions);
});
app.get('/api/sessions/:id/qr', requireInstructor, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return bad(res, 404, 'Attendance session not found.');
  if (!requireSubjectAccess(req, res, session.subject)) return;
  try {
    const qr = session.qr || await QRCode.toDataURL(session.url, {
      width: 500,
      margin: 4,
      errorCorrectionLevel: 'M'
    });
    res.json({
      id: session.id,
      subject: session.subject,
      url: session.url,
      qr,
      status: session.status === 'active' && session.expiresAt > Date.now() ? 'Active' : 'Closed',
      expiresAt: session.expiresAt,
      durationMinutes: session.durationMinutes
    });
  } catch (error) {
    console.error('Unable to restore the original attendance QR:', error.message);
    bad(res, 500, 'Unable to display this session QR code.');
  }
});
app.post('/api/sessions/:id/recover', requireInstructor, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return bad(res, 404, 'Attendance session not found.');
  if (!requireSubjectAccess(req, res, session.subject)) return;
  if (session.status === 'active' && session.expiresAt <= Date.now()) {
    try {
      await finalizeAttendanceSession(session);
    } catch (error) {
      console.error('Unable to finalize the expired session before recovery:', error.message);
      return bad(res, 500, 'The expired session could not be finalized. Try again after checking attendance storage.');
    }
  }
  if (session.status !== 'closed' || !session.closedAt || session.finalizationPromise) {
    return bad(res, 409, 'Only a fully closed attendance session can be recovered.');
  }

  const recoveredAt = Date.now();
  const recoveredAtIso = new Date(recoveredAt).toISOString();
  try {
    authDb.prepare(`
      INSERT INTO admin_audit_log
        (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
      VALUES (?, ?, ?, ?, ?, 'admin_qr_session_recovered', ?, ?, 'success')
    `).run(
      crypto.randomUUID(),
      recoveredAtIso,
      req.admin.id,
      req.admin.role,
      session.createdBy,
      session.id,
      `QR session recovery: subject=${session.subject}; attendanceDate=${session.attendanceDate}; status=closed->active; recoveredAt=${recoveredAtIso}.`
    );
  } catch (error) {
    console.error('Unable to audit QR session recovery:', error.message);
    return bad(res, 500, 'Unable to record the QR recovery audit event.');
  }

  try {
    recoverClosedSession(session, recoveredAt, req.admin.id);
  } catch (error) {
    if (error.code === 'SESSION_NOT_CLOSED' || error.code === 'SESSION_FINALIZING') {
      return bad(res, 409, error.message);
    }
    console.error('Unable to recover QR session:', error.message);
    return bad(res, 500, 'Unable to recover this QR session.');
  }
  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  session.expiryTimer = setTimeout(() => {
    finalizeAttendanceSession(session).catch((error) => {
      console.error(`Unable to automatically finalize expired attendance session ${session.id}:`, error.message);
    });
  }, session.expiresAt - Date.now());
  session.expiryTimer.unref?.();

  syncAdminAuditSheet().catch((error) => console.error('Unable to sync QR session recovery audit to Google Sheets:', error.message));
  res.json({
    ok: true,
    id: session.id,
    status: 'Active',
    url: session.url,
    qr: session.qr,
    expiresAt: session.expiresAt,
    durationMinutes: session.durationMinutes,
    recoveryCount: session.recoveryCount
  });
});
app.get('/api/sessions/:token', (req, res) => {
  const session = readSession(req.params.token);
  if (!isSessionActive(session) || !sessionIssuerCanAccess(session)) return bad(res, 410, 'This QR code is invalid, expired, or no longer authorized. Please scan a valid QR code.');
  res.json({
    subject: session.subject,
    batch: session.batch,
    durationMinutes: session.durationMinutes,
    expiresAt: session.expiresAt,
    valid: true
  });
});
app.post('/api/sessions/:id/close', requireInstructor, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return bad(res, 404, 'Attendance session not found.');
  if (!requireSubjectAccess(req, res, session.subject)) return;
  try {
    res.json(await finalizeAttendanceSession(session));
  } catch (error) { console.error(error); bad(res, 500, 'Unable to finalize absent students.'); }
});

app.post('/api/attendance', async (req, res) => {
  const session = readSession(req.body.token);
  if (!isSessionActive(session) || !sessionIssuerCanAccess(session)) return bad(res, 410, 'This QR code is invalid, expired, or no longer authorized. Please scan a valid QR code.');
  const name = normalizeName(req.body.name);
  const batch = String(req.body.batch || '');
  const email = normalizeEmail(req.body.email);
  const deviceToken = String(req.body.deviceToken || '').trim();
  if (!/^(?=.{3,}$)[A-Za-z]+(?: [A-Za-z]+)*$/.test(name)) return bad(res, 400, 'Name must contain at least 3 alphabetic characters and spaces only.');
  if (!batches.includes(batch) || (session.batch && session.batch !== batch)) return bad(res, 400, 'Please select a valid batch.');
  if (email && !isValidEmail(email)) return bad(res, 400, 'Enter a valid email address or leave the email field blank.');
  if (!isValidDeviceToken(deviceToken)) return bad(res, 400, 'Unable to identify this device. Please refresh the page and try again.');
  const course = courseFor(batch);
  const now = serverNow();
  const studentKey = `${name.toLowerCase()}|${batch}`;
  const canReplaceClosedAbsence = mayReplaceClosedAbsence(session, now.date, studentKey);
  if (isHolidayDate(now.date, holidays)) return bad(res, 409, 'Attendance cannot be marked on Sundays or configured holidays.');
  if (await isDeviceSessionAttendanceLocked(now.date, deviceToken, session.id)) return bad(res, 409, deviceLockMessage);
  let lockGranted = false;
  let deviceBinding = null;
  let attendanceSaved = false;
  try {
    if (await findExisting(session.subject, now.date, name, batch) && !canReplaceClosedAbsence) {
      return bad(res, 409, 'Your attendance for this subject has already been marked today.');
    }
    const lock = await claimDeviceSessionAttendanceLock({ date: now.date, deviceToken, qrSessionId: session.id, subject: session.subject, studentIdentifier: `${name}|${batch}` });
    if (!lock.allowed) return bad(res, 409, lock.reason);
    lockGranted = true;
    const candidate = { name, batch };
    const deviceOwner = checkDeviceOwner(authDb, candidate, hashDeviceToken(deviceToken));
    if (!deviceOwner.allowed) {
      await releaseDeviceSessionAttendanceLock(now.date, deviceToken, session.id);
      lockGranted = false;
      return bad(res, 409, deviceOwner.reason);
    }
    const student = await registerStudent(name, batch, email);
    const binding = bindDevice(authDb, {
      student,
      deviceHash: hashDeviceToken(deviceToken),
      ipAddress: clientIpAddress(req),
      now: new Date().toISOString()
    });
    if (!binding.allowed) {
      await releaseDeviceSessionAttendanceLock(now.date, deviceToken, session.id);
      lockGranted = false;
      return bad(res, 409, binding.reason);
    }
    deviceBinding = binding;
    if (canReplaceClosedAbsence) {
      const replaced = await updateRecoveredSessionAbsence(session, name, batch);
      if (!replaced) {
        await releaseDeviceSessionAttendanceLock(now.date, deviceToken, session.id);
        lockGranted = false;
        if (deviceBinding.newlyBound) releaseNewDeviceBinding(authDb, deviceBinding.record.id);
        return bad(res, 409, 'This recovered session no longer has an absence record to replace. Contact your instructor.');
      }
      session.absentStudentKeys.delete(studentKey);
    } else {
      await appendRow(session.subject, [now.date, now.time, name, batch, course, session.subject, 'Present', 'QR', session.id]);
    }
    session.markedStudentKeys.add(studentKey);
    attendanceSaved = true;
    let deviceRegistrySync = 'synced';
    try {
      if (!recordDeviceAttendance(authDb, binding.record.id, session.subject, now.date)) {
        throw new Error('Unable to update the registered device record.');
      }
      const deviceRecord = listDeviceRegistry(authDb).find((record) => record.id === binding.record.id);
      if (!deviceRecord) throw new Error('Unable to load the registered device record.');
      await upsertDeviceRegistrySheetRow(deviceRecord);
    } catch (error) {
      deviceRegistrySync = 'failed';
      console.error('Attendance was saved, but the device registry could not be synchronized:', error.message);
    }
    await syncPercentage();
    let emailNotification = 'not-requested';
    if (student.email) {
      if (!isEmailConfigured()) emailNotification = 'not-configured';
      else {
        try {
          await sendAttendanceNotification({
            to: student.email,
            studentName: student.name,
            studentId: student.id,
            subject: session.subject,
            date: now.date,
            time: now.time,
            facultyName: session.facultyName,
            status: 'Present'
          });
          emailNotification = 'sent';
        } catch {
          emailNotification = 'failed';
        }
      }
    }
    res.json({ date: now.date, time: now.time, name, batch, course, subject: session.subject, status: 'Present', emailNotification, deviceRegistrySync });
  } catch (error) {
    if (lockGranted) await releaseDeviceSessionAttendanceLock(now.date, deviceToken, session.id);
    if (deviceBinding?.newlyBound && !attendanceSaved) releaseNewDeviceBinding(authDb, deviceBinding.record.id);
    console.error(error);
    bad(res, 500, attendanceSaved
      ? 'Attendance was recorded, but a follow-up update failed. Please contact your instructor before retrying.'
      : "We couldn't save your attendance right now. Please try again.");
  }
});

app.get('/api/student-attendance', async (req, res) => {
  const name = normalizeName(req.query.name);
  const batch = String(req.query.batch || '').trim();
  const subject = String(req.query.subject || '').trim();
  if (!name || !batches.includes(batch) || (subject && !subjects.includes(subject))) return bad(res, 400, 'Please provide a valid student name, batch, and subject.');

  try {
    const targetSubjects = subject ? [subject] : subjects;
    const today = serverNow().date;
    const attendance = [];
    let student = null;
    for (const currentSubject of targetSubjects) {
      const targetSheet = resolveSubjectSheetTitle(currentSubject);
      const result = await getSheets().spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
        range: `'${targetSheet}'!A1:ZZ10000`
      });
      const matrix = result.data.values || [];
      const header = matrix[0] || [];
      const row = matrix.slice(1).find((candidate) => normalizeName(candidate[1]).toLowerCase() === name.toLowerCase() && String(candidate[2] || '').trim() === batch);
      if (!row) continue;
      student = { id: String(row[0] || '').trim(), name: normalizeName(row[1]), batch };
      for (let index = 3; index < header.length; index += 1) {
        const date = String(header[index] || '').trim();
        const status = String(row[index] || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today && ['Present', 'Absent'].includes(status)) {
          attendance.push({ date, status, subject: currentSubject });
        }
      }
    }
    if (!student) return bad(res, 404, 'Student not found. Please check your name and batch.');
    const presentDays = attendance.filter((record) => record.status === 'Present').length;
    const totalDays = attendance.length;
    const percentage = totalDays ? Number(((presentDays / totalDays) * 100).toFixed(2)) : 0;
    const todayRecords = attendance.filter((record) => record.date === today);
    const todayStatus = todayRecords.some((record) => record.status === 'Present')
      ? 'Present'
      : todayRecords.some((record) => record.status === 'Absent') ? 'Absent' : 'Not Marked';
    res.json({
      student,
      today: { date: today, status: todayStatus },
      attendance: { presentDays, totalDays, percentage },
      noRecords: totalDays === 0,
      lowAttendance: percentage < minAttendancePercentage,
      minimumRequired: minAttendancePercentage
    });
  } catch (error) {
    console.error(error);
    bad(res, 500, 'Unable to retrieve attendance right now. Please try again later.');
  }
});

app.post('/api/attendance/email-summary', requireInstructor, async (req, res) => {
  const name = normalizeName(req.body.name);
  const batch = String(req.body.batch || '').trim();
  if (!name || !batches.includes(batch)) return bad(res, 400, 'Enter a valid student name and batch.');
  if (!rateLimit(`summary:${req.admin.id}`, 20, 60 * 60 * 1000)) return bad(res, 429, 'Too many attendance summary emails. Try again later.');
  if (!isEmailConfigured()) return bad(res, 503, emailConfigurationMessage());

  try {
    const student = (await getStudents()).find((entry) =>
      entry.name.toLowerCase() === name.toLowerCase() && entry.batch === batch
    );
    if (!student) return bad(res, 404, 'Student not found in the roster.');
    if (!student.email) return bad(res, 400, 'This student does not have an email address in the roster.');

    const today = serverNow().date;
    const subjectSummary = [];
    for (const subject of assignedSubjects(req.admin)) {
      const rows = await readRows(subject);
      const records = rows.slice(1).filter((row) =>
        normalizeName(row[2]).toLowerCase() === student.name.toLowerCase()
        && String(row[3] || '').trim() === student.batch
        && row[0] <= today
        && ['Present', 'Absent'].includes(String(row[6] || '').trim())
      );
      const present = records.filter((row) => row[6] === 'Present').length;
      const total = records.length;
      if (total) {
        subjectSummary.push({
          subject,
          present,
          total,
          percentage: (present / total * 100).toFixed(2)
        });
      }
    }
    const presentCount = subjectSummary.reduce((total, row) => total + row.present, 0);
    const totalClasses = subjectSummary.reduce((total, row) => total + row.total, 0);
    const absentCount = totalClasses - presentCount;
    const attendancePercentage = totalClasses ? (presentCount / totalClasses * 100).toFixed(2) : '0.00';
    await sendAttendanceSummary({
      to: student.email,
      studentName: student.name,
      totalClasses,
      presentCount,
      absentCount,
      attendancePercentage,
      subjectSummary
    });
    res.json({ ok: true, emailNotification: 'sent' });
  } catch (error) {
    console.error('Unable to send attendance summary:', error.message);
    bad(res, 503, error.code === 'EMAIL_AUTH_FAILED'
      ? emailDeliveryErrorMessage(error)
      : error.code === 'EMAIL_NOT_CONFIGURED'
        ? emailConfigurationMessage()
        : 'Unable to send the attendance summary. Please try again later.');
  }
});

app.get('/api/report', requireInstructor, async (req, res) => {
  try {
    const rows = [];
    for (const subject of assignedSubjects(req.admin)) {
      const values = await readRows(subject);
      values.slice(1).filter((row) => row[6] !== 'Not Marked').forEach((r) => rows.push({ date: r[0], time: r[1], name: r[2], batch: r[3], course: r[4], subject, status: r[6], source: r[7] }));
    }
    res.json(rows);
  } catch (error) { console.error(error); bad(res, 500, 'Unable to load attendance from Google Sheets.'); }
});
app.get('/api/percentages', requireInstructor, async (req, res) => {
  try {
    const availableSubjects = assignedSubjects(req.admin);
    const students = await getStudents();
    const rows = [];
    for (const subject of availableSubjects) {
      const values = await readRows(subject);
      values.slice(1).forEach((r) => rows.push({ date: r[0], name: normalizeName(r[2]), batch: r[3], course: r[4], subject, status: r[6] }));
    }
    const knownStudents = new Map(students.map((student) => [`${student.name.toLowerCase()}|${student.batch}`, student]));
    for (const row of rows) {
      const key = `${row.name.toLowerCase()}|${row.batch}`;
      if (row.name && row.batch && !knownStudents.has(key)) knownStudents.set(key, { name: row.name, batch: row.batch, course: row.course || courseFor(row.batch) });
    }
    const reportStudents = [...knownStudents.values()];
    const result = [];
    const overall = new Map();
    for (const student of reportStudents) {
      for (const subject of availableSubjects) {
        const subjectRows = rows.filter((row) =>
          row.name.toLowerCase() === student.name.toLowerCase()
          && row.batch === student.batch
          && row.subject === subject
          && isCountedClassStatus(row.status)
        );
        const dates = new Set(rows
          .filter((row) => row.batch === student.batch && row.subject === subject && row.date && isCountedClassStatus(row.status))
          .map((row) => row.date));
        const attended = subjectRows.filter((row) => row.status === 'Present').length;
        const total = dates.size;
        const key = `${student.name.toLowerCase()}|${student.batch}`;
        if (!overall.has(key)) overall.set(key, { attended: 0, total: 0 });
        overall.get(key).attended += attended;
        overall.get(key).total += total;
        result.push({ name: student.name, batch: student.batch, course: student.course, subject, attended, total, subjectPercentage: total ? ((attended / total) * 100).toFixed(2) : '0.00' });
      }
    }
    res.json(result.map((entry) => { const totals = overall.get(`${entry.name.toLowerCase()}|${entry.batch}`); return { ...entry, overallPercentage: totals.total ? ((totals.attended / totals.total) * 100).toFixed(2) : '0.00' }; }));
  } catch (error) { console.error(error); bad(res, 500, 'Unable to calculate attendance percentages.'); }
});
app.post('/api/correct', requireInstructor, async (req, res) => {
  const { subject, name, batch, status, date: requestedDate } = req.body;
  const today = serverNow().date;
  const date = String(requestedDate || today).trim();
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && date <= today;
  if (!subjects.includes(subject) || !batches.includes(batch) || !['Present', 'Absent'].includes(status) || !validDate) return bad(res, 400, 'Choose a valid date up to today.');
  if (!requireSubjectAccess(req, res, subject)) return;
  if (isHolidayDate(date, holidays)) return bad(res, 400, 'Attendance cannot be corrected on Sundays or configured holidays.');
  try {
    const row = [date, status === 'Absent' ? '-' : serverNow().time, normalizeName(name), batch, courseFor(batch), subject, status, 'Instructor correction', 'manual'];
    await appendRow(subject, row);
    await ensureAttendanceCalendar();
    await syncPercentage();
    res.json({ ok: true, date });
  } catch (error) { console.error(error); bad(res, 500, 'Unable to save the correction.'); }
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const isDirectExecution = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isDirectExecution) {
  const server = httpsOptions ? https.createServer(httpsOptions, app) : app;
  Promise.resolve()
    .then(() => {
      if (process.env.NODE_ENV === 'production' && (configuredSessionSecret.length < 32 || /^(replace|change-me|your-)/i.test(configuredSessionSecret))) {
        throw new Error('Set JWT_SECRET to a random value of at least 32 characters before running in production.');
      }
      if (!configuredSessionSecret) console.warn('JWT_SECRET is unset; sessions will be invalidated when the app restarts.');
      if (!isEmailConfigured()) console.warn(emailConfigurationMessage());
      initializeAuthDatabase();
      return loadDeviceLocksFromDisk();
    })
    .then(() => {
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`Port ${port} is already in use. Use the running app at http://localhost:${port}, stop its server with Ctrl+C in its terminal, or set PORT to another available port.`);
        } else {
          console.error('Unable to start the attendance application:', error.message);
        }
        closeAuthDatabase();
        process.exitCode = 1;
      });
      server.listen(port, '0.0.0.0', () => {
        try {
          console.log(`QR attendance running at ${resolvePublicUrl()}`);
        } catch (error) {
          console.warn('Unable to determine a phone-accessible QR URL:', error.message);
        }
        ensureSheetLayout()
          .then(() => styleAttendanceSheets())
          .then(() => syncAllSubjectStudentIds())
          .then(() => syncRosterToSubjectSheets())
          .then(() => ensureAttendanceCalendar())
          .then(() => syncAttendanceValidation())
          .then(() => syncPercentage())
          .then(() => ensureSecuritySheets())
          .then(() => syncDeviceRegistrySheet())
          .then(() => syncAdminAccountsSheet())
          .then(() => syncAdminAuditSheet())
          .catch((error) => console.error('Unable to sync subject matrices:', error.message));
      });
    })
    .catch((error) => {
      console.error('Unable to initialize the attendance application:', error.message);
      process.exitCode = 1;
    });
}

export {
  hashDeviceToken,
  isValidDeviceToken,
  isDeviceSessionAttendanceLocked,
  claimDeviceSessionAttendanceLock,
  releaseDeviceSessionAttendanceLock,
  loadDeviceLocksFromDisk,
  persistDeviceLocks
};

let sheetDate = serverNow().date;
const dateColumnInterval = setInterval(() => {
  const currentDate = serverNow().date;
  if (currentDate === sheetDate) return;
  sheetDate = currentDate;
  ensureAttendanceCalendar(currentDate)
    .then(() => syncAttendanceValidation())
    .catch((error) => console.error('Unable to add new date columns:', error.message));
}, 60000);
dateColumnInterval.unref();

function closeAuthDatabase() {
  if (!authDb) return;
  authDb.close();
  authDb = null;
}

export { app, initializeAuthDatabase, closeAuthDatabase, sessions as activeAttendanceSessions };
