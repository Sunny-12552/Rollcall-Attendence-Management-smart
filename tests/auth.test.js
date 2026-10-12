import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { runAdminAccountsReset } from '../scripts/reset-admin-accounts.js';

function createSmtpSink() {
  const codes = [];
  const recipients = [];
  const messages = [];
  const server = net.createServer((socket) => {
    socket.write('220 attendance-test ESMTP\r\n');
    let incoming = '';
    let dataLines = [];
    let readingData = false;
    let authLoginStep = 0;
    socket.on('data', (chunk) => {
      incoming += chunk.toString('utf8');
      let lineEnd;
      while ((lineEnd = incoming.indexOf('\r\n')) >= 0) {
        const line = incoming.slice(0, lineEnd);
        incoming = incoming.slice(lineEnd + 2);
        if (readingData) {
          if (line === '.') {
            readingData = false;
            const code = dataLines.join('\n').match(/\b\d{6}\b/)?.[0];
            if (code) codes.push(code);
            messages.push(dataLines.join('\n'));
            dataLines = [];
            socket.write('250 2.0.0 queued\r\n');
          } else {
            dataLines.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        const command = line.toUpperCase();
        if (authLoginStep === 1) {
          authLoginStep = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (authLoginStep === 2) {
          authLoginStep = 0;
          socket.write('235 2.7.0 authenticated\r\n');
        } else if (command.startsWith('EHLO') || command.startsWith('HELO')) socket.write('250-attendance-test\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (command.startsWith('AUTH PLAIN')) socket.write('235 2.7.0 authenticated\r\n');
        else if (command === 'AUTH LOGIN') {
          authLoginStep = 1;
          socket.write('334 VXNlcm5hbWU6\r\n');
        }
        else if (command.startsWith('RCPT TO:')) {
          recipients.push(line.match(/<([^>]+)>/)?.[1]?.toLowerCase());
          socket.write('250 2.1.0 accepted\r\n');
        } else if (command.startsWith('MAIL FROM:')) socket.write('250 2.1.0 accepted\r\n');
        else if (command === 'DATA') {
          readingData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (command === 'QUIT') socket.end('221 2.0.0 bye\r\n');
        else socket.write('250 2.0.0 ok\r\n');
      }
    });
  });
  return {
    codes,
    recipients,
    messages,
    server,
    async nextCode() {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        const code = codes.shift();
        if (code) return code;
        await delay(10);
      }
      throw new Error('Timed out waiting for a verification email.');
    }
  };
}

async function jsonRequest(baseUrl, route, { method = 'GET', body, cookie, headers: extraHeaders = {} } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...extraHeaders
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
    cookie: response.headers.get('set-cookie')?.split(';')[0]
  };
}

test('admins sign up, verify by OTP, invite accounts, and persist secure sessions', async (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-auth-'));
  const databasePath = path.join(temporaryDirectory, 'auth.sqlite');
  const smtp = createSmtpSink();
  await new Promise((resolve) => smtp.server.listen(0, '127.0.0.1', resolve));
  const smtpPort = smtp.server.address().port;
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = databasePath;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.MAIN_ADMIN_BOOTSTRAP_SECRET = crypto.randomBytes(32).toString('base64url');
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(smtpPort);
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USER = 'test-smtp-user';
  process.env.SMTP_PASSWORD = 'test-smtp-password';
  process.env.SMTP_FROM = 'attendance-test@example.test';
  process.env.EMAIL_PROVIDER = 'smtp';
  process.env.EMAIL_FROM = 'attendance-test@example.test';
  process.env.APP_URL = 'https://attendance.example.test';
  process.env.QR_MINUTES = '30';
  process.env.SUBJECTS = 'Python,Java';
  process.env.GOOGLE_SPREADSHEET_ID = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_FILE = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '';

  const { app, initializeAuthDatabase, closeAuthDatabase, activeAttendanceSessions } = await import('../server.js');
  initializeAuthDatabase();
  let server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  let baseUrl = `http://127.0.0.1:${server.address().port}`;
  let inspectionDb;
  const stopServer = async () => {
    if (!server.listening) return;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  t.after(async () => {
    await stopServer();
    for (const session of activeAttendanceSessions.values()) {
      if (session.expiryTimer) clearTimeout(session.expiryTimer);
    }
    activeAttendanceSessions.clear();
    inspectionDb?.close();
    closeAuthDatabase();
    await new Promise((resolve) => smtp.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    for (const key of ['NODE_ENV', 'DATABASE_URL', 'JWT_SECRET', 'MAIN_ADMIN_BOOTSTRAP_SECRET', 'EMAIL_PROVIDER', 'EMAIL_FROM', 'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'APP_URL', 'QR_MINUTES', 'SUBJECTS', 'GOOGLE_SPREADSHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_FILE', 'GOOGLE_SERVICE_ACCOUNT_JSON']) {
      delete process.env[key];
    }
  });

  let status = await jsonRequest(baseUrl, '/api/auth/status');
  assert.equal(status.body.firstAdminSetupRequired, true);
  const initialAdmin = {
    name: 'First Administrator',
    email: 'admin-one@example.test',
    phone: '+14155550136',
    password: 'FirstAdminPassword!',
    confirmPassword: 'FirstAdminPassword!',
    bootstrapSecret: process.env.MAIN_ADMIN_BOOTSTRAP_SECRET
  };
  let result = await jsonRequest(baseUrl, '/api/auth/bootstrap', {
    method: 'POST',
    body: { ...initialAdmin, bootstrapSecret: 'incorrect-bootstrap-secret-that-is-at-least-32-characters' }
  });
  assert.equal(result.status, 403, 'invalid bootstrap secrets must be rejected');
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) === 'https://api.resend.com/emails') {
      return new Response(JSON.stringify({ message: 'test rejection' }), { status: 503 });
    }
    return originalFetch(url, options);
  });
  process.env.EMAIL_PROVIDER = 'resend';
  process.env.RESEND_API_KEY = 'test-resend-api-key';
  result = await jsonRequest(baseUrl, '/api/auth/bootstrap', { method: 'POST', body: initialAdmin });
  assert.equal(result.status, 503, 'a failed verification email must fail Main Admin setup');
  assert.equal((await jsonRequest(baseUrl, '/api/auth/status')).body.firstAdminSetupRequired, true,
    'failed email delivery must leave Main Admin setup available');
  process.env.EMAIL_PROVIDER = 'smtp';
  delete process.env.RESEND_API_KEY;
  result = await jsonRequest(baseUrl, '/api/auth/bootstrap', { method: 'POST', body: initialAdmin });
  assert.equal(result.status, 201);
  assert.equal(result.body.otpPurpose, 'verify');
  assert.equal(Object.hasOwn(result.body, 'code'), false);
  const firstCode = await smtp.nextCode();
  assert.ok(smtp.recipients.includes(initialAdmin.email), 'the OTP is delivered to the registering admin email');
  assert.equal(JSON.stringify(result.body).includes(firstCode), false);
  assert.equal((await jsonRequest(baseUrl, '/api/auth/status')).body.firstAdminSetupRequired, false);
  result = await jsonRequest(baseUrl, '/api/auth/signup', {
    method: 'POST',
    body: {
      name: 'Uninvited Account',
      email: 'uninvited@example.test',
      phone: '',
      password: 'UninvitedPassword!',
      confirmPassword: 'UninvitedPassword!'
    }
  });
  assert.equal(result.status, 400, 'admin registration requires a valid phone number');
  assert.match(smtp.messages[0], /Attendance Management System - Verify Your Account/i);
  assert.match(smtp.messages[0], /First Administrator/);
  assert.match(smtp.messages[0], /admin-one@example\.test/);
  assert.match(smtp.messages[0], /ADMIN/);
  assert.match(smtp.messages[0], /valid for 10 minutes/i);
  assert.match(smtp.messages[0], /Content-Type: text\/html/i, 'auth email must include the shared HTML template');
  inspectionDb = new Database(databasePath);
  const pendingFirst = inspectionDb.prepare('SELECT password_hash FROM admins WHERE email = ?').get(initialAdmin.email);
  const firstOtpHash = inspectionDb.prepare('SELECT otp_hash FROM otp_verifications WHERE admin_id = (SELECT id FROM admins WHERE email = ?)').get(initialAdmin.email).otp_hash;
  assert.notEqual(pendingFirst.password_hash, initialAdmin.password);
  assert.notEqual(firstOtpHash, firstCode);
  inspectionDb.prepare('UPDATE otp_verifications SET last_sent_at = 0 WHERE admin_id = (SELECT id FROM admins WHERE email = ?)').run(initialAdmin.email);
  process.env.EMAIL_PROVIDER = 'resend';
  process.env.RESEND_API_KEY = 'test-resend-api-key';
  result = await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email }
  });
  assert.equal(result.status, 503, 'a failed resend must be reported as a delivery failure');
  assert.equal(
    inspectionDb.prepare('SELECT otp_hash FROM otp_verifications WHERE admin_id = (SELECT id FROM admins WHERE email = ?)').get(initialAdmin.email).otp_hash,
    firstOtpHash,
    'a failed resend must preserve the previously delivered OTP'
  );
  process.env.EMAIL_PROVIDER = 'smtp';
  delete process.env.RESEND_API_KEY;
  inspectionDb.prepare('UPDATE otp_verifications SET last_sent_at = ? WHERE admin_id = (SELECT id FROM admins WHERE email = ?)').run(Date.now(), initialAdmin.email);
  result = await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email }
  });
  assert.equal(result.status, 429, 'OTP resend must enforce a cooldown');

  result = await jsonRequest(baseUrl, '/api/auth/login', { method: 'POST', body: { email: initialAdmin.email, password: initialAdmin.password } });
  assert.equal(result.status, 428, 'unverified accounts must provide their one-time code before sign-in can finish');
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email, code: (Number(firstCode) + 1).toString().padStart(6, '0') }
  });
  assert.equal(result.status, 400, 'wrong OTP must be rejected');

  inspectionDb.prepare('UPDATE otp_verifications SET expires_at = ?, last_sent_at = 0').run(Date.now() - 1);
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email, code: firstCode }
  });
  assert.equal(result.status, 400, 'expired OTP must be rejected');
  result = await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email }
  });
  assert.equal(result.status, 200);
  const freshFirstCode = await smtp.nextCode();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
      method: 'POST',
      body: { purpose: 'verify', email: initialAdmin.email, code: (Number(freshFirstCode) + 1).toString().padStart(6, '0') }
    });
    assert.equal(result.status, 400);
  }
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email, code: freshFirstCode }
  });
  assert.equal(result.status, 400, 'five wrong codes must exhaust the OTP');
  inspectionDb.prepare('UPDATE otp_verifications SET last_sent_at = 0').run();
  result = await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email }
  });
  assert.equal(result.status, 200);
  const verifiedFirstCode = await smtp.nextCode();
  const simultaneousVerifications = await Promise.all([1, 2].map(() => jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email, code: verifiedFirstCode }
  })));
  assert.equal(simultaneousVerifications.filter((entry) => entry.status === 200).length, 1,
    'an OTP can only be consumed once, even by simultaneous verification requests');
  assert.equal(simultaneousVerifications.filter((entry) => entry.status === 400).length, 1);
  result = simultaneousVerifications.find((entry) => entry.status === 200);
  assert.equal(result.body.emailNotification, 'sent');
  const welcomeMessage = smtp.messages.find((mail) => mail.includes('Subject: Welcome to the Attendance Management System'));
  assert.ok(welcomeMessage);
  assert.match(welcomeMessage, /admin-one@example\.test/);
  assert.equal(inspectionDb.pragma('user_version', { simple: true }), 7);
  assert.equal(inspectionDb.prepare('SELECT admin_id FROM main_admin_config WHERE singleton = 1').get().admin_id,
    inspectionDb.prepare('SELECT id FROM admins WHERE email = ?').get(initialAdmin.email).id);
  inspectionDb.prepare('UPDATE main_admin_config SET admin_id = NULL, created_at = NULL WHERE singleton = 1').run();
  result = await jsonRequest(baseUrl, '/api/auth/bootstrap', {
    method: 'POST',
    body: {
      email: initialAdmin.email,
      password: initialAdmin.password,
      bootstrapSecret: process.env.MAIN_ADMIN_BOOTSTRAP_SECRET
    }
  });
  assert.equal(result.status, 200, 'an existing verified admin can claim the one-time bootstrap on an existing database');

  const firstLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: initialAdmin.email, password: initialAdmin.password }
  });
  assert.equal(firstLogin.status, 200);
  const firstCookie = firstLogin.cookie;
  assert.ok(firstCookie);
  assert.equal((await jsonRequest(baseUrl, '/api/me', { cookie: firstCookie })).body.admin.role, 'MAIN_ADMIN');
  const registration = {
    name: 'Subject Admin',
    email: 'subject-admin@example.test',
    phone: '+1 415 555 0137',
    password: 'SubjectAdminPassword!',
    confirmPassword: 'SubjectAdminPassword!'
  };
  result = await jsonRequest(baseUrl, '/api/auth/signup', { method: 'POST', body: registration });
  assert.equal(result.status, 201, 'a new admin can register and request email verification');
  const unverifiedRequests = await jsonRequest(baseUrl, '/api/admins/pending', { cookie: firstCookie });
  assert.equal(unverifiedRequests.status, 200);
  assert.ok(unverifiedRequests.body.some((request) =>
    request.email === registration.email
      && request.isVerified === false
      && request.canReview === false
      && request.reviewStatus === 'Awaiting email verification'
  ), `unverified registrations are visible in the queue without approval actions: ${JSON.stringify(unverifiedRequests.body)}`);
  const registrationCode = await smtp.nextCode();
  result = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: registration.email, password: registration.password }
  });
  assert.equal(result.status, 403, 'unverified registrations still wait for Main Admin approval before sign-in');
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: registration.email, code: registrationCode }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.approvalPending, true);
  const verifiedRequests = await jsonRequest(baseUrl, '/api/admins/pending', { cookie: firstCookie });
  assert.ok(verifiedRequests.body.some((request) =>
    request.email === registration.email
      && request.isVerified === true
      && request.canReview === true
      && request.reviewStatus === 'Pending Main Admin approval'
  ), 'verified registrations appear as ready for Main Admin approval');
  result = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: registration.email, password: registration.password }
  });
  assert.equal(result.status, 403, 'verified registrations remain blocked until approved');
  const registrationId = inspectionDb.prepare('SELECT id FROM admins WHERE email = ?').get(registration.email).id;
  const pendingRequests = await jsonRequest(baseUrl, '/api/admins/pending', { cookie: firstCookie });
  assert.equal(pendingRequests.status, 200);
  assert.ok(pendingRequests.body.some((request) => request.id === registrationId && request.phone === '+14155550137'));
  result = await jsonRequest(baseUrl, `/api/admins/${registrationId}/approval`, {
    method: 'POST',
    cookie: firstCookie,
    body: { decision: 'approve', reason: 'Approved from the admin accounts list.' }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(
    inspectionDb.prepare('SELECT subject FROM admin_subject_assignments WHERE admin_id = ? ORDER BY subject').all(registrationId).map((entry) => entry.subject),
    ['Java', 'Python'],
    'Give Access assigns every configured subject'
  );
  const approvedLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: registration.email, password: registration.password }
  });
  assert.equal(approvedLogin.status, 200);
  const approvedCookie = approvedLogin.cookie;
  const adminConfig = await jsonRequest(baseUrl, '/api/admin/config', { cookie: approvedCookie });
  assert.deepEqual(adminConfig.body.subjects, ['Java', 'Python']);
  assert.equal((await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    cookie: approvedCookie,
    body: { subject: 'Python', batch: 'P1' }
  })).status, 200, 'approved admin can create QR sessions for all configured subjects');
  const assignedSession = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    cookie: approvedCookie,
    body: { subject: 'Java', batch: 'P1' }
  });
  assert.equal(assignedSession.status, 200);
  const assignedQrToken = new URL(assignedSession.body.url).searchParams.get('session');
  const regularAdminRecoveryTarget = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    cookie: firstCookie,
    body: { subject: 'Java', batch: 'P1' }
  });
  assert.equal(regularAdminRecoveryTarget.status, 200);
  const regularAdminRecoverySession = activeAttendanceSessions.get(regularAdminRecoveryTarget.body.id);
  regularAdminRecoverySession.markedStudentKeys.add('already-present|P1');
  regularAdminRecoverySession.absentStudentKeys.add('not-yet-present|P1');
  regularAdminRecoverySession.status = 'closed';
  regularAdminRecoverySession.closedAt = Date.now();
  regularAdminRecoverySession.closeResult = { ok: true, added: 1 };
  const regularAdminRecovered = await jsonRequest(
    baseUrl,
    `/api/sessions/${regularAdminRecoverySession.id}/recover`,
    { method: 'POST', cookie: approvedCookie }
  );
  assert.equal(regularAdminRecovered.status, 200, 'an authorized regular admin can recover another authorized session');
  assert.equal(regularAdminRecovered.body.id, regularAdminRecoverySession.id);
  assert.equal(regularAdminRecovered.body.url, regularAdminRecoveryTarget.body.url);
  assert.equal(regularAdminRecovered.body.qr, regularAdminRecoveryTarget.body.qr);
  assert.equal(regularAdminRecoverySession.recoveredBy, registrationId);
  assert.deepEqual([...regularAdminRecoverySession.markedStudentKeys], ['already-present|P1']);
  assert.deepEqual([...regularAdminRecoverySession.absentStudentKeys], ['not-yet-present|P1']);
  const approvalAuditCount = inspectionDb.prepare(`
    SELECT COUNT(*) AS count FROM admin_audit_log WHERE target_admin_id = ? AND action = 'admin_approve'
  `).get(registrationId).count;
  result = await jsonRequest(baseUrl, `/api/admins/${registrationId}/approval`, {
    method: 'POST',
    cookie: firstCookie,
    body: { decision: 'approve' }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.alreadyGranted, true, 'repeated Give Access requests are idempotent');
  assert.equal(inspectionDb.prepare(`
    SELECT COUNT(*) AS count FROM admin_audit_log WHERE target_admin_id = ? AND action = 'admin_approve'
  `).get(registrationId).count, approvalAuditCount, 'repeated approval does not duplicate audit events');
  assert.equal((await jsonRequest(baseUrl, '/api/admins/pending', { cookie: approvedCookie })).status, 403,
    'regular admins cannot access approval management APIs');
  assert.equal((await jsonRequest(baseUrl, `/api/admins/${registrationId}/approval`, {
    method: 'POST',
    cookie: approvedCookie,
    body: { decision: 'approve', subjects: ['Python'], reason: 'Attempted self-elevation.' }
  })).status, 403);
  assert.equal((await jsonRequest(baseUrl, `/api/admins/${registrationId}/subjects`, {
    method: 'PUT',
    cookie: approvedCookie,
    body: { subjects: ['Python'], reason: 'Attempted permission change.' }
  })).status, 403, 'regular admins cannot change subject assignments');
  result = await jsonRequest(baseUrl, `/api/admins/${registrationId}/subjects`, {
    method: 'PUT',
    cookie: firstCookie,
    body: { subjects: ['Python'], reason: 'Revoke Java subject access.' }
  });
  assert.equal(result.status, 200);
  const recoveryTargetSession = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    cookie: firstCookie,
    body: { subject: 'Java', batch: 'P1' }
  });
  assert.equal(recoveryTargetSession.status, 200);
  const originalSessionId = recoveryTargetSession.body.id;
  const originalSessionUrl = recoveryTargetSession.body.url;
  const originalSessionQr = recoveryTargetSession.body.qr;
  const recoveryToken = new URL(originalSessionUrl).searchParams.get('session');
  const originalQrView = await jsonRequest(baseUrl, `/api/sessions/${originalSessionId}/qr`, { cookie: firstCookie });
  assert.equal(originalQrView.status, 200);
  assert.equal(originalQrView.body.url, originalSessionUrl);
  assert.equal(originalQrView.body.qr, originalSessionQr);
  assert.equal((await jsonRequest(baseUrl, `/api/sessions/${originalSessionId}/recover`, {
    method: 'POST',
    cookie: firstCookie
  })).status, 409, 'an active QR session cannot be recovered twice');
  const recoverableSession = activeAttendanceSessions.get(originalSessionId);
  recoverableSession.markedStudentKeys.add('already-present|P1');
  recoverableSession.absentStudentKeys.add('not-yet-present|P1');
  recoverableSession.status = 'closed';
  recoverableSession.closedAt = Date.now();
  recoverableSession.closeResult = { ok: true, added: 1 };
  assert.equal((await jsonRequest(baseUrl, `/api/sessions/${originalSessionId}/recover`, {
    method: 'POST',
    cookie: approvedCookie
  })).status, 403, 'admins cannot recover sessions for subjects they are not assigned to');
  assert.equal(recoverableSession.status, 'closed', 'unauthorized recovery leaves the session unchanged');
  const recoveredSession = await jsonRequest(baseUrl, `/api/sessions/${originalSessionId}/recover`, {
    method: 'POST',
    cookie: firstCookie
  });
  assert.equal(recoveredSession.status, 200);
  assert.equal(recoveredSession.body.id, originalSessionId);
  assert.equal(recoveredSession.body.url, originalSessionUrl);
  assert.equal(recoveredSession.body.qr, originalSessionQr);
  assert.equal(recoveredSession.body.status, 'Active');
  assert.equal(recoverableSession.status, 'active');
  assert.deepEqual([...recoverableSession.markedStudentKeys], ['already-present|P1']);
  assert.deepEqual([...recoverableSession.absentStudentKeys], ['not-yet-present|P1']);
  assert.equal((await jsonRequest(baseUrl, `/api/sessions/${encodeURIComponent(recoveryToken)}`)).status, 200,
    'the original student QR token remains valid after recovery');
  assert.equal((await jsonRequest(baseUrl, `/api/sessions/${originalSessionId}/recover`, {
    method: 'POST',
    cookie: firstCookie
  })).status, 409, 'repeated recovery does not create or reactivate a duplicate session');
  const recoveryAudit = (await jsonRequest(baseUrl, '/api/admins/account-audit-log', { cookie: firstCookie })).body
    .find((entry) => entry.action === 'admin_qr_session_recovered' && entry.affectedRecord === originalSessionId);
  assert.ok(recoveryAudit);
  assert.equal(recoveryAudit.affectedRecord, originalSessionId);
  assert.match(recoveryAudit.reason, /status=closed->active/);
  assert.equal((await jsonRequest(baseUrl, '/api/sessions', { cookie: firstCookie })).body
    .filter((session) => session.id === originalSessionId).length, 1);
  assert.equal((await jsonRequest(baseUrl, `/api/sessions/${encodeURIComponent(assignedQrToken)}`)).status, 410,
    'removing an assigned subject invalidates its already-issued QR code');
  const issuerRevokedSession = activeAttendanceSessions.get(assignedSession.body.id);
  issuerRevokedSession.status = 'closed';
  issuerRevokedSession.closedAt = Date.now();
  issuerRevokedSession.closeResult = { ok: true, added: 0 };
  const issuerRevokedRecovery = await jsonRequest(
    baseUrl,
    `/api/sessions/${issuerRevokedSession.id}/recover`,
    { method: 'POST', cookie: firstCookie }
  );
  assert.equal(issuerRevokedRecovery.status, 200,
    'an authorized admin can recover a session after its original issuer loses subject access');
  assert.equal(issuerRevokedSession.recoveredBy, inspectionDb.prepare(`
    SELECT id FROM admins WHERE email = ?
  `).get(initialAdmin.email).id);
  assert.equal((await jsonRequest(baseUrl, `/api/sessions/${encodeURIComponent(assignedQrToken)}`)).status, 200,
    'the same QR works after an authorized admin recovers a session whose issuer lost access');
  assert.ok((await jsonRequest(baseUrl, '/api/admins/account-audit-log', { cookie: firstCookie })).body
    .some((entry) => entry.action === 'admin_approve' || entry.action === 'admin_subjects_updated'));
  const unverifiedAdmin = {
    name: 'OTP Required Admin',
    email: 'otp-required-admin@example.test',
    phone: '+1 415 555 0139',
    password: 'OtpRequiredPassword!',
    confirmPassword: 'OtpRequiredPassword!'
  };
  result = await jsonRequest(baseUrl, '/api/auth/signup', { method: 'POST', body: unverifiedAdmin });
  assert.equal(result.status, 201);
  const initialUnverifiedOtp = await smtp.nextCode();
  const unverifiedAdminId = inspectionDb.prepare('SELECT id FROM admins WHERE email = ?').get(unverifiedAdmin.email).id;
  result = await jsonRequest(baseUrl, `/api/admins/${unverifiedAdminId}/approval`, {
    method: 'POST',
    cookie: firstCookie,
    body: { decision: 'approve' }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.requiresOtp, true);
  assert.equal(result.body.otpDelivery, 'already-sent', 'approval reuses a still-valid verification OTP');
  assert.equal(result.body.active, false, 'Main Admin approval must not activate an unverified account');
  assert.equal(inspectionDb.prepare('SELECT is_active FROM admins WHERE id = ?').get(unverifiedAdminId).is_active, 0);
  const unverifiedAdminCode = initialUnverifiedOtp;
  assert.equal((await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: unverifiedAdmin.email, password: unverifiedAdmin.password }
  })).status, 428, 'approved but unverified admins can submit OTP through sign-in');
  const verifiedAdminLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: unverifiedAdmin.email, password: unverifiedAdmin.password, otp: unverifiedAdminCode }
  });
  assert.equal(verifiedAdminLogin.status, 200);
  assert.equal(inspectionDb.prepare('SELECT is_verified, is_active FROM admins WHERE id = ?').get(unverifiedAdminId).is_verified, 1);
  assert.equal(inspectionDb.prepare('SELECT is_active FROM admins WHERE id = ?').get(unverifiedAdminId).is_active, 1,
    'successful OTP verification activates the approved account during sign-in');
  assert.deepEqual((await jsonRequest(baseUrl, '/api/admin/config', { cookie: verifiedAdminLogin.cookie })).body.subjects, ['Java', 'Python']);
  assert.equal((await jsonRequest(baseUrl, '/api/admins/devices')).status, 401);
  assert.equal((await jsonRequest(baseUrl, '/api/admins/audit-log')).status, 401);
  assert.equal((await jsonRequest(baseUrl, '/api/auth/admin-requests', {
    method: 'POST',
    body: { name: 'Requesting Administrator', email: 'request-admin@example.test' }
  })).status, 404, 'public admin access requests have been removed');

  const deviceHash = crypto.createHash('sha256').update('admin-test-device').digest('hex');
  inspectionDb.prepare(`
    INSERT INTO device_registry
      (id, device_hash, student_key, student_id, student_name, batch, course,
       registered_ip, first_registered_at, last_seen_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    'device-test-1', deviceHash, 'student-key-test', 'STU-000001',
    'Student One', 'P1', 'Python Full Stack', '192.168.1.20',
    new Date().toISOString(), new Date().toISOString()
  );
  result = await jsonRequest(baseUrl, '/api/admins/devices/device-test-1/unlock', {
    method: 'POST',
    body: { confirm: true, reason: 'Student received a replacement phone.' }
  });
  assert.equal(result.status, 401, 'only authenticated admins can unlock devices');
  result = await jsonRequest(baseUrl, '/api/admins/devices/device-test-1/unlock', {
    method: 'POST',
    cookie: firstCookie,
    body: { confirm: false, reason: 'Not confirmed.' }
  });
  assert.equal(result.status, 400, 'device unlock requires explicit confirmation');
  result = await jsonRequest(baseUrl, '/api/admins/devices/device-test-1/unlock', {
    method: 'POST',
    cookie: firstCookie,
    body: { confirm: true, reason: 'Student received a replacement phone.' }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.registrySync, 'failed', 'registry sync failure is reported without losing the local audit');
  const deviceAudit = await jsonRequest(baseUrl, '/api/admins/audit-log', { cookie: firstCookie });
  assert.equal(deviceAudit.status, 200);
  assert.equal(deviceAudit.body[0].action, 'device_unlock');
  assert.equal(deviceAudit.body[0].reason, 'Student received a replacement phone.');
  const deviceListing = await jsonRequest(baseUrl, '/api/admins/devices', { cookie: firstCookie });
  assert.equal(deviceListing.status, 200);
  assert.equal(deviceListing.body.find((device) => device.id === 'device-test-1').status, 'unlocked');
  const adminListing = await jsonRequest(baseUrl, '/api/admins', { cookie: firstCookie });
  assert.equal(adminListing.body[0].accountLockStatus, 'Not locked');
  assert.equal(adminListing.body[0].failedLoginAttempts, 0);
  result = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    body: { subject: 'Python', batch: 'P1' }
  });
  assert.equal(result.status, 401, 'only signed-in admins can generate QR codes');
  result = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    cookie: firstCookie,
    body: { subject: 'Not a subject', batch: 'P1' }
  });
  assert.equal(result.status, 400, 'invalid QR session subjects must be rejected');
  result = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    cookie: firstCookie,
    body: { subject: 'Python', batch: 'P1', durationMinutes: 15 }
  });
  assert.equal(result.status, 400, 'QR durations outside the supported choices must be rejected');
  result = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    cookie: firstCookie,
    body: { subject: 'Python', batch: 'P1' }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.durationMinutes, 30, 'omitted QR duration defaults to the configured duration');
  assert.equal(result.body.expiresAt - result.body.createdAt, 30 * 60 * 1000);
  assert.match(result.body.qr, /^data:image\/png;base64,/);
  assert.match(result.body.url, /^https:\/\/attendance\.example\.test\/\?session=/);
  const sessionToken = new URL(result.body.url).searchParams.get('session');
  const sessionStatus = await jsonRequest(baseUrl, `/api/sessions/${encodeURIComponent(sessionToken)}`);
  assert.equal(sessionStatus.status, 200, 'the generated QR token must resolve to an active session');
  assert.equal(sessionStatus.body.subject, 'Python');
  assert.equal(sessionStatus.body.batch, 'P1');
  assert.equal(sessionStatus.body.durationMinutes, 30);
  const listedSessions = await jsonRequest(baseUrl, '/api/sessions', { cookie: firstCookie });
  assert.equal(listedSessions.status, 200);
  assert.equal(listedSessions.body.filter((session) => session.id === result.body.id).length, 1);
  const shortSession = await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    cookie: firstCookie,
    body: { subject: 'Python', batch: 'P1', durationMinutes: 5 }
  });
  assert.equal(shortSession.status, 200);
  assert.equal(shortSession.body.expiresAt - shortSession.body.createdAt, 5 * 60 * 1000);
  result = await jsonRequest(baseUrl, `/api/sessions/${encodeURIComponent(`${sessionToken.split('.')[0]}.invalid`)}`);
  assert.equal(result.status, 410, 'altered QR tokens must be rejected');
  const storedFirst = inspectionDb.prepare('SELECT password_hash, role, is_verified FROM admins WHERE email = ?').get(initialAdmin.email);
  assert.equal(storedFirst.role, 'ADMIN');
  assert.equal(storedFirst.is_verified, 1);
  assert.match(storedFirst.password_hash, /^bcrypt-sha256:\$2[aby]\$/);
  assert.notEqual(storedFirst.password_hash, initialAdmin.password);
  assert.equal(inspectionDb.prepare('SELECT COUNT(*) AS count FROM otp_verifications WHERE admin_id = (SELECT id FROM admins WHERE email = ?)').get(initialAdmin.email).count, 0);
  assert.equal((await jsonRequest(baseUrl, '/api/admins')).status, 401, 'admin management requires a session');

  result = await jsonRequest(baseUrl, '/api/admins/invite', {
    method: 'POST',
    cookie: firstCookie,
    body: { name: 'Elevated Administrator', email: 'admin-elevated@example.test', role: 'SUPER_ADMIN' }
  });
  assert.equal(result.status, 400, 'the Main Admin cannot create a second Main Admin through invitations');
  result = await jsonRequest(baseUrl, '/api/admins/invite', {
    method: 'POST',
    cookie: firstCookie,
    body: { name: 'Missing Subjects', email: 'admin-missing-subjects@example.test' }
  });
  assert.equal(result.status, 400, 'Main Admin invitations must explicitly specify subject access');
  result = await jsonRequest(baseUrl, '/api/admins/invite', {
    method: 'POST',
    cookie: firstCookie,
    body: { name: 'Second Administrator', email: 'admin-two@example.test', subjects: ['Python'] }
  });
  assert.equal(result.status, 201);
  assert.equal(Object.hasOwn(result.body, 'temporaryPassword'), false, 'the temporary password is delivered only through email');
  assert.equal(result.body.accountReportSync, 'failed', 'admin invitation reports an account-sheet synchronization failure');
  let inviteCode = await smtp.nextCode();
  assert.ok(smtp.recipients.includes('admin-two@example.test'), 'the invitation OTP goes to the invited admin email');
  let invitationMessage = smtp.messages.find((mail) => mail.includes('admin-two@example.test')
    && mail.includes('You have been invited as an administrator'));
  assert.ok(invitationMessage);
  let decodedInvitationText = invitationMessage.replace(/=\r?\n/g, '');
  assert.match(decodedInvitationText, /Second Administrator/);
  assert.match(decodedInvitationText, /Temporary password:/);
  assert.match(decodedInvitationText, new RegExp(inviteCode));
  let temporaryPassword = decodedInvitationText.match(/Temporary password: ([A-Za-z0-9]{5,11})/)?.[1];
  assert.ok(temporaryPassword, 'invitation email contains the generated temporary password');
  assert.match(temporaryPassword, /^Second\d{3}$/, 'temporary password uses the invited admin name and a short random suffix');
  assert.equal((await jsonRequest(baseUrl, '/api/auth/signup', {
    method: 'POST',
    body: {
      name: 'Second Administrator',
      email: 'admin-two@example.test',
      phone: '+14155550138',
      password: 'SelfSelectedPassword!',
      confirmPassword: 'SelfSelectedPassword!'
    }
  })).status, 409, 'an invitee cannot bypass the generated temporary credential flow');
  assert.equal((await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'invite', email: 'admin-two@example.test', code: inviteCode }
  })).status, 400, 'invitation codes are consumed during sign-in, not a public signup form');
  assert.equal((await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    body: { purpose: 'invite', email: 'admin-two@example.test' }
  })).status, 401, 'invitation credentials cannot be resent without Main Admin authentication');
  assert.equal((await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: 'admin-two@example.test' }
  })).status, 401, 'the verify alias cannot bypass Main Admin invitation-resend authorization');
  inspectionDb.prepare('UPDATE otp_verifications SET last_sent_at = 0 WHERE admin_id = (SELECT id FROM admins WHERE email = ?)').run('admin-two@example.test');
  result = await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    cookie: firstCookie,
    body: { purpose: 'invite', email: 'admin-two@example.test' }
  });
  assert.equal(result.status, 200, 'Main Admin can resend and rotate invitation credentials');
  inviteCode = await smtp.nextCode();
  const latestInvitation = smtp.messages.filter((mail) => mail.includes('admin-two@example.test')
    && mail.includes('You have been invited as an administrator')).at(-1);
  decodedInvitationText = latestInvitation.replace(/=\r?\n/g, '');
  const rotatedTemporaryPassword = decodedInvitationText.match(/Temporary password: ([A-Za-z0-9]{5,11})/)?.[1];
  assert.ok(rotatedTemporaryPassword);
  assert.match(rotatedTemporaryPassword, /^Second\d{3}$/);
  assert.notEqual(rotatedTemporaryPassword, temporaryPassword, 'resending rotates the temporary password');
  assert.equal((await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-two@example.test', password: temporaryPassword, otp: inviteCode }
  })).status, 401, 'the superseded temporary password cannot sign in');
  temporaryPassword = rotatedTemporaryPassword;
  const secondAdmin = inspectionDb.prepare('SELECT password_hash, role, is_verified, is_active, must_change_password FROM admins WHERE email = ?').get('admin-two@example.test');
  const invitedSubjects = inspectionDb.prepare('SELECT subject FROM admin_subject_assignments WHERE admin_id = (SELECT id FROM admins WHERE email = ?)').all('admin-two@example.test');
  assert.deepEqual(invitedSubjects.map((entry) => entry.subject), ['Python']);
  assert.equal(secondAdmin.role, 'ADMIN');
  assert.equal(secondAdmin.is_verified, 0, 'first sign-in code verifies the invited email');
  assert.equal(secondAdmin.is_active, 1, 'direct Main Admin invitation authorizes the account');
  assert.equal(secondAdmin.must_change_password, 1);
  assert.match(secondAdmin.password_hash, /^bcrypt-sha256:\$2[aby]\$/);
  assert.equal(await bcrypt.compare(crypto.createHash('sha256').update(temporaryPassword).digest('hex'), secondAdmin.password_hash.slice('bcrypt-sha256:'.length)), true,
    'the temporary password in the invitation email matches the stored password hash');
  result = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-two@example.test', password: temporaryPassword }
  });
  assert.equal(result.status, 428, 'invited admins must submit the emailed one-time code');
  result = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-two@example.test', password: temporaryPassword, otp: '000000' }
  });
  assert.equal(result.status, 401, 'incorrect invitation codes are rejected');
  const invitedLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-two@example.test', password: temporaryPassword, otp: inviteCode }
  });
  assert.equal(invitedLogin.status, 200);
  assert.equal(invitedLogin.body.mustChangePassword, true);
  const secondCookie = invitedLogin.cookie;
  assert.equal((await jsonRequest(baseUrl, '/api/me', { cookie: secondCookie })).body.admin.mustChangePassword, true);
  assert.equal((await jsonRequest(baseUrl, '/api/admins/devices', { cookie: secondCookie })).status, 403,
    'a temporary-password session cannot access admin features before changing its password');
  assert.equal((await jsonRequest(baseUrl, '/api/auth/change-password', {
    method: 'POST',
    cookie: secondCookie,
    body: { password: 'short', confirmPassword: 'short' }
  })).status, 400);
  assert.equal((await jsonRequest(baseUrl, '/api/auth/change-password', {
    method: 'POST',
    cookie: secondCookie,
    body: { password: temporaryPassword, confirmPassword: temporaryPassword }
  })).status, 400, 'first password change must replace, not retain, the temporary password');
  result = await jsonRequest(baseUrl, '/api/auth/change-password', {
    method: 'POST',
    cookie: secondCookie,
    body: { password: 'SecondAdminPassword!', confirmPassword: 'SecondAdminPassword!' }
  });
  assert.equal(result.status, 200);
  assert.equal((await jsonRequest(baseUrl, '/api/me', { cookie: secondCookie })).body.admin.mustChangePassword, false);
  assert.deepEqual((await jsonRequest(baseUrl, '/api/admin/config', { cookie: secondCookie })).body.subjects, ['Python'],
    'an invited admin receives only the subjects selected by Main Admin');
  assert.equal((await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-two@example.test', password: temporaryPassword }
  })).status, 401, 'the temporary password is invalidated after it is replaced');
  const activeSecondLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-two@example.test', password: 'SecondAdminPassword!' }
  });
  assert.equal(activeSecondLogin.status, 200);
  const mainAdminList = await jsonRequest(baseUrl, '/api/admins', { cookie: firstCookie });
  assert.equal(mainAdminList.status, 200);
  const secondAdminRecord = mainAdminList.body.find((admin) => admin.email === 'admin-two@example.test');
  assert.equal(secondAdminRecord.role, 'ADMIN');
  assert.equal(secondAdminRecord.status, 'Active');
  const mainAdminRecord = mainAdminList.body.find((admin) => admin.role === 'MAIN_ADMIN');
  assert.equal((await jsonRequest(baseUrl, '/api/me', { cookie: secondCookie })).body.admin.role, 'ADMIN');
  assert.equal((await jsonRequest(baseUrl, '/api/admins/devices', { cookie: secondCookie })).status, 200,
    'regular admins can open the separate device security page');
  assert.equal((await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    cookie: secondCookie,
    body: { purpose: 'invite', email: 'admin-two@example.test' }
  })).status, 403, 'regular admins cannot resend their own or another admin invitation credentials');
  inspectionDb.prepare("UPDATE device_registry SET status = 'active', registered_ip = '192.168.1.30' WHERE id = 'device-test-1'").run();
  const regularAdminDeviceUnlock = await jsonRequest(baseUrl, '/api/admins/devices/device-test-1/unlock', {
    method: 'POST',
    cookie: secondCookie,
    body: { confirm: true, reason: 'Student changed to a replacement phone.' }
  });
  assert.equal(regularAdminDeviceUnlock.status, 200, 'regular admins can release a student device registration');
  const regularAdminDeviceAudit = await jsonRequest(baseUrl, '/api/admins/audit-log', { cookie: firstCookie });
  assert.equal(regularAdminDeviceAudit.body[0].actingAdminRole, 'ADMIN');
  assert.ok(regularAdminDeviceAudit.body.every((entry) => ['device_unlock', 'legacy_device_unlock'].includes(entry.action)),
    'device security history contains only device registration actions');
  assert.equal((await jsonRequest(baseUrl, '/api/admins', { cookie: secondCookie })).status, 403);
  assert.equal((await jsonRequest(baseUrl, '/api/admins/account-audit-log', { cookie: secondCookie })).status, 403,
    'regular admins cannot access the separate admin login and access history');
  assert.equal((await jsonRequest(baseUrl, '/api/sessions', {
    method: 'POST',
    cookie: secondCookie,
    body: { subject: 'Python', batch: 'P1' }
  })).status, 200, 'regular admins retain existing QR and attendance administration access');
  assert.equal((await jsonRequest(baseUrl, '/api/admins/invite', {
    method: 'POST',
    cookie: secondCookie,
    body: { name: 'Third Administrator', email: 'admin-three@example.test' }
  })).status, 403);
  assert.equal((await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(secondAdminRecord.id)}/status`, {
    method: 'PATCH',
    cookie: secondCookie,
    body: { active: false, confirm: true, reason: 'Attempted by a regular admin.' }
  })).status, 403);
  assert.equal((await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(mainAdminRecord.id)}/status`, {
    method: 'PATCH',
    cookie: secondCookie,
    body: { active: false, confirm: true, reason: 'Regular admins cannot alter Main Admin access.' }
  })).status, 403);
  assert.equal((await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(secondAdminRecord.id)}/details`, {
    method: 'PATCH',
    cookie: secondCookie,
    body: { name: 'Elevated Admin', role: 'MAIN_ADMIN' }
  })).status, 403);
  assert.equal((await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(secondAdminRecord.id)}/recovery`, {
    method: 'POST',
    cookie: secondCookie,
    body: {}
  })).status, 403);
  assert.equal((await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(secondAdminRecord.id)}`, {
    method: 'DELETE',
    cookie: secondCookie,
    body: { confirm: true, reason: 'Attempted by a regular admin.' }
  })).status, 403);
  assert.equal((await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(mainAdminRecord.id)}/details`, {
    method: 'PATCH',
    cookie: secondCookie,
    body: { name: 'Regular admin cannot rename Main Admin.' }
  })).status, 403);
  assert.equal((await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(mainAdminRecord.id)}`, {
    method: 'DELETE',
    cookie: secondCookie,
    body: { confirm: true, reason: 'Regular admins cannot remove Main Admin.' }
  })).status, 403);
  assert.equal((await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(mainAdminRecord.id)}/status`, {
    method: 'PATCH',
    cookie: firstCookie,
    body: { active: false, confirm: true, reason: 'Should not affect Main Admin.' }
  })).status, 400, 'the Main Admin cannot deactivate itself through account management');
  assert.equal((await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(mainAdminRecord.id)}`, {
    method: 'DELETE',
    cookie: firstCookie,
    body: { confirm: true, reason: 'Should not remove Main Admin.' }
  })).status, 400, 'the Main Admin cannot remove itself');
  assert.equal((await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(mainAdminRecord.id)}/details`, {
    method: 'PATCH',
    cookie: firstCookie,
    body: { name: 'Changed Main Admin' }
  })).status, 400);
  result = await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(secondAdminRecord.id)}/details`, {
    method: 'PATCH',
    cookie: firstCookie,
    body: { name: 'Updated Second Administrator', reason: 'Corrected the admin display name.' }
  });
  assert.equal(result.status, 200, 'Main Admin can edit permitted regular-admin details');
  result = await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(secondAdminRecord.id)}/status`, {
    method: 'PATCH',
    cookie: firstCookie,
    body: { active: false, confirm: true, reason: 'Temporary access suspension.' }
  });
  assert.equal(result.status, 200);
  assert.equal((await jsonRequest(baseUrl, '/api/admins/devices', { cookie: secondCookie })).status, 401,
    'deactivation immediately invalidates the regular admin session');
  assert.equal((await jsonRequest(baseUrl, '/api/me', { cookie: secondCookie })).body.instructor, false);
  result = await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(secondAdminRecord.id)}/recovery`, {
    method: 'POST',
    cookie: firstCookie,
    body: {}
  });
  assert.equal(result.status, 200, 'Main Admin can initiate recovery for an inactive regular admin');
  const recoveryCode = await smtp.nextCode();
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: {
      purpose: 'reset',
      email: 'admin-two@example.test',
      code: recoveryCode,
      password: 'RecoveredSecondPassword!',
      confirmPassword: 'RecoveredSecondPassword!'
    }
  });
  assert.equal(result.status, 200);
  assert.equal((await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-two@example.test', password: 'RecoveredSecondPassword!' }
  })).status, 403, 'password recovery does not reactivate an inactive admin');
  result = await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(secondAdminRecord.id)}/status`, {
    method: 'PATCH',
    cookie: firstCookie,
    body: { active: true, confirm: true, reason: 'Access reinstated after review.' }
  });
  assert.equal(result.status, 200);
  const reactivatedLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-two@example.test', password: 'RecoveredSecondPassword!' }
  });
  assert.equal(reactivatedLogin.status, 200);

  const auditEntries = await jsonRequest(baseUrl, '/api/admins/audit-log', { cookie: firstCookie });
  assert.ok(auditEntries.body.every((entry) => ['device_unlock', 'legacy_device_unlock'].includes(entry.action)));
  const adminAccountAudit = await jsonRequest(baseUrl, '/api/admins/account-audit-log', { cookie: firstCookie });
  assert.equal(adminAccountAudit.status, 200);
  assert.ok(adminAccountAudit.body.some((entry) => entry.action === 'admin_invite' && entry.actingAdminRole === 'MAIN_ADMIN'));
  assert.ok(adminAccountAudit.body.some((entry) => entry.action === 'admin_invite_login' && entry.targetAdminId === secondAdminRecord.id));
  assert.ok(adminAccountAudit.body.some((entry) => entry.action === 'admin_password_change' && entry.targetAdminId === secondAdminRecord.id));
  assert.ok(adminAccountAudit.body.some((entry) => entry.action === 'admin_deactivate' && entry.targetAdminId === secondAdminRecord.id));
  assert.ok(adminAccountAudit.body.some((entry) => entry.action === 'admin_update' && entry.targetAdminId === secondAdminRecord.id));
  assert.ok(adminAccountAudit.body.some((entry) => entry.action === 'admin_recovery_initiated' && entry.targetAdminId === secondAdminRecord.id));
  assert.ok(adminAccountAudit.body.some((entry) => entry.action === 'admin_login' && entry.adminEmail === 'admin-two@example.test'));
  assert.ok(adminAccountAudit.body.every((entry) => !['device_unlock', 'legacy_device_unlock'].includes(entry.action)),
    'admin login/access history excludes student device events');
  assert.equal(activeSecondLogin.status, 200);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    result = await jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'unknown-admin@example.test', password: 'WrongPassword123!' }
    });
    assert.equal(result.status, 401);
  }
  result = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'unknown-admin@example.test', password: 'WrongPassword123!' }
  });
  assert.equal(result.status, 429, 'login attempts must be rate limited');
  result = await jsonRequest(baseUrl, '/api/admins/invite', {
    method: 'POST',
    cookie: firstCookie,
    body: { name: 'Second Administrator', email: 'admin-two@example.test', subjects: ['Python'] }
  });
  assert.equal(result.status, 409, 'duplicate email invitations must be rejected');
  result = await jsonRequest(baseUrl, '/api/auth/signup', {
    method: 'POST',
    body: initialAdmin
  });
  assert.equal(result.status, 409, 'duplicate signup emails must be rejected');

  const previouslyRemovedAdminId = crypto.randomUUID();
  const previouslyRemovedEmail = 'previously-removed@example.test';
  const previousRemovalDate = '2026-10-08T12:00:00.000Z';
  inspectionDb.prepare(`
    INSERT INTO admins
      (id, name, email, password_hash, role, is_verified, is_active, created_at, updated_at,
       last_login, last_successful_login, last_password_change_at, phone, removed_at)
    VALUES (?, 'Previously Removed Admin', ?, 'old-password-hash', 'ADMIN', 1, 0, ?, ?,
       ?, ?, ?, '+1 415 555 0199', ?)
  `).run(
    previouslyRemovedAdminId,
    previouslyRemovedEmail,
    previousRemovalDate,
    previousRemovalDate,
    previousRemovalDate,
    previousRemovalDate,
    previousRemovalDate,
    previousRemovalDate
  );
  inspectionDb.prepare(`
    INSERT INTO auth_sessions (token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)
  `).run(crypto.randomBytes(32).toString('hex'), previouslyRemovedAdminId, Date.now() + 60_000, previousRemovalDate);
  inspectionDb.prepare(`
    INSERT INTO otp_verifications
      (id, admin_id, purpose, otp_hash, expires_at, attempts, last_sent_at, created_at)
    VALUES (?, ?, 'verify', 'old-otp-hash', ?, 0, ?, ?)
  `).run(crypto.randomUUID(), previouslyRemovedAdminId, Date.now() + 60_000, Date.now(), previousRemovalDate);
  inspectionDb.prepare(`
    INSERT INTO admin_subject_assignments (admin_id, subject, assigned_at)
    VALUES (?, 'Python', ?)
  `).run(previouslyRemovedAdminId, previousRemovalDate);
  inspectionDb.prepare(`
    INSERT INTO admin_audit_log
      (id, timestamp, admin_id, acting_admin_role, target_admin_id, action, affected_record, reason, result)
    VALUES (?, ?, ?, 'ADMIN', ?, 'admin_login', ?, 'Former admin identity in audit.', 'success')
  `).run(crypto.randomUUID(), previousRemovalDate, previouslyRemovedAdminId, previouslyRemovedAdminId, previouslyRemovedEmail);

  await stopServer();
  closeAuthDatabase();
  initializeAuthDatabase();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  result = await jsonRequest(baseUrl, '/api/me', { cookie: firstCookie });
  assert.equal(result.body.instructor, true, 'database sessions must survive application restart');
  assert.equal(inspectionDb.prepare('SELECT COUNT(*) AS count FROM admins').get().count, 5);
  const scrubbedExistingRemoval = inspectionDb.prepare(`
    SELECT name, email, phone, password_hash, last_login, last_successful_login
    FROM admins WHERE id = ?
  `).get(previouslyRemovedAdminId);
  assert.equal(scrubbedExistingRemoval.name, 'Removed admin');
  assert.match(scrubbedExistingRemoval.email, /^removed\+.+@removed\.invalid$/);
  assert.equal(scrubbedExistingRemoval.phone, null);
  assert.equal(scrubbedExistingRemoval.password_hash, null);
  assert.equal(scrubbedExistingRemoval.last_login, null);
  assert.equal(scrubbedExistingRemoval.last_successful_login, null);
  assert.equal(inspectionDb.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE admin_id = ?').get(previouslyRemovedAdminId).count, 0);
  assert.equal(inspectionDb.prepare('SELECT COUNT(*) AS count FROM otp_verifications WHERE admin_id = ?').get(previouslyRemovedAdminId).count, 0);
  assert.equal(inspectionDb.prepare('SELECT COUNT(*) AS count FROM admin_subject_assignments WHERE admin_id = ?').get(previouslyRemovedAdminId).count, 0);
  assert.equal(inspectionDb.prepare(`
    SELECT COUNT(*) AS count FROM admin_audit_log
    WHERE admin_id = ? AND affected_record = 'Removed admin'
      AND reason = 'Account details were erased during admin removal.'
  `).get(previouslyRemovedAdminId).count, 1, 'existing audit events are anonymized during startup');

  result = await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(inspectionDb.prepare('SELECT id FROM admins WHERE email = ?').get('admin-two@example.test').id)}/status`, {
    method: 'PATCH',
    cookie: firstCookie,
    body: { active: false, confirm: true, role: 'SUPER_ADMIN', reason: 'Final regression check deactivation.' }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.adminReportSync, 'failed', 'admin status reports sheet synchronization failures');
  result = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-two@example.test', password: 'SecondAdminPassword!' }
  });
  assert.equal(result.status, 401, 'deactivated admins cannot log in');
  result = await jsonRequest(baseUrl, '/api/me', { cookie: reactivatedLogin.cookie });
  assert.equal(result.body.instructor, false, 'deactivation invalidates existing sessions');
  result = await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(inspectionDb.prepare('SELECT id FROM admins WHERE email = ?').get(initialAdmin.email).id)}/status`, {
    method: 'PATCH',
    cookie: firstCookie,
    body: { active: false, confirm: true, reason: 'Main Admin self-deactivation must be blocked.' }
  });
  assert.equal(result.status, 400, 'the last active verified admin cannot be deactivated');

  result = await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    body: { purpose: 'reset', email: initialAdmin.email }
  });
  assert.equal(result.status, 200);
  const resetCode = await smtp.nextCode();
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: {
      purpose: 'reset',
      email: initialAdmin.email,
      code: resetCode,
      password: 'UpdatedFirstAdminPassword!',
      confirmPassword: 'UpdatedFirstAdminPassword!'
    }
  });
  assert.equal(result.status, 200);
  assert.equal((await jsonRequest(baseUrl, '/api/me', { cookie: firstCookie })).body.instructor, false, 'password reset revokes sessions');
  assert.equal((await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: initialAdmin.email, password: initialAdmin.password }
  })).status, 401);
  const updatedMainLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: initialAdmin.email, password: 'UpdatedFirstAdminPassword!' }
  });
  assert.equal(updatedMainLogin.status, 200);
  const removedAdminId = secondAdminRecord.id;
  result = await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(removedAdminId)}`, {
    method: 'DELETE',
    cookie: updatedMainLogin.cookie,
    body: { confirm: true, reason: 'Admin access is no longer required.' }
  });
  assert.equal(result.status, 200, 'Main Admin can remove a regular admin while retaining its audit record');
  const visibleAdmins = (await jsonRequest(baseUrl, '/api/admins', { cookie: updatedMainLogin.cookie })).body;
  assert.equal(visibleAdmins.some((admin) => admin.id === removedAdminId), false,
    'removed accounts are hidden from the admin dashboard list');
  const erasedAdmin = inspectionDb.prepare(`
    SELECT name, email, phone, password_hash, is_verified, is_active, last_login,
      last_successful_login, last_password_change_at, failed_login_attempts, account_lock_until
    FROM admins WHERE id = ?
  `).get(removedAdminId);
  assert.equal(erasedAdmin.name, 'Removed admin');
  assert.match(erasedAdmin.email, /^removed\+.+@removed\.invalid$/);
  assert.equal(erasedAdmin.phone, null);
  assert.equal(erasedAdmin.password_hash, null);
  assert.equal(erasedAdmin.is_verified, 0);
  assert.equal(erasedAdmin.is_active, 0);
  assert.equal(erasedAdmin.last_login, null);
  assert.equal(erasedAdmin.last_successful_login, null);
  assert.equal(erasedAdmin.last_password_change_at, null);
  assert.equal(erasedAdmin.failed_login_attempts, 0);
  assert.equal(erasedAdmin.account_lock_until, null);
  assert.equal(inspectionDb.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE admin_id = ?').get(removedAdminId).count, 0);
  assert.equal(inspectionDb.prepare('SELECT COUNT(*) AS count FROM admin_subject_assignments WHERE admin_id = ?').get(removedAdminId).count, 0);
  assert.equal(inspectionDb.prepare(`
    SELECT COUNT(*) AS count FROM admin_audit_log
    WHERE (admin_id = ? OR target_admin_id = ?)
      AND (affected_record = 'admin-two@example.test' OR reason LIKE '%admin-two@example.test%')
  `).get(removedAdminId, removedAdminId).count, 0);
  assert.equal(inspectionDb.prepare('SELECT COUNT(*) AS count FROM admins WHERE email = ?').get('admin-two@example.test').count, 0,
    'the removed email is released for future registration');
  assert.equal((await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-two@example.test', password: 'RecoveredSecondPassword!' }
  })).status, 401);
  const finalAudit = await jsonRequest(baseUrl, '/api/admins/account-audit-log', { cookie: updatedMainLogin.cookie });
  assert.ok(finalAudit.body.some((entry) => entry.action === 'admin_remove' && entry.targetAdminId === removedAdminId));
  const removedAdminAudit = finalAudit.body.filter((entry) =>
    entry.adminId === removedAdminId || entry.targetAdminId === removedAdminId);
  assert.ok(removedAdminAudit.length > 0, 'removed admin audit events are preserved');
  assert.ok(removedAdminAudit.every((entry) =>
    (entry.adminId !== removedAdminId || entry.adminEmail === 'Removed admin')
      && entry.affectedRecord !== 'admin-two@example.test'
      && !entry.reason.includes('admin-two@example.test')),
  'removed admin audit events no longer expose their email');

  const resetResult = await runAdminAccountsReset({
    databasePath,
    configuredSecret: process.env.MAIN_ADMIN_BOOTSTRAP_SECRET,
    suppliedSecret: process.env.MAIN_ADMIN_BOOTSTRAP_SECRET,
    apply: true
  });
  assert.equal(resetResult.changed, true);
  status = await jsonRequest(baseUrl, '/api/auth/status');
  assert.equal(status.body.bootstrapMode, 'create', 'tombstoned admins do not block a fresh Main Admin setup');
  assert.equal(status.body.firstAdminSetupRequired, true);
  assert.equal((await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: initialAdmin.email, password: 'UpdatedFirstAdminPassword!' }
  })).status, 401, 'reset admin credentials and sessions are no longer usable');

  const recoveredMainAdmin = {
    name: 'Recovered Main Administrator',
    email: initialAdmin.email,
    password: 'RecoveredMainAdminPassword!',
    confirmPassword: 'RecoveredMainAdminPassword!',
    bootstrapSecret: process.env.MAIN_ADMIN_BOOTSTRAP_SECRET
  };
  result = await jsonRequest(baseUrl, '/api/auth/bootstrap', { method: 'POST', body: recoveredMainAdmin });
  assert.equal(result.status, 201, 'a new Main Admin can be initialized after the authorized reset');
  const recoveredCode = await smtp.nextCode();
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: recoveredMainAdmin.email, code: recoveredCode }
  });
  assert.equal(result.status, 200, 'new Main Admin verification succeeds after delivery');
  const recoveredLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: recoveredMainAdmin.email, password: recoveredMainAdmin.password }
  });
  assert.equal(recoveredLogin.status, 200, 'verified Main Admin can log in after recovery');
  assert.equal((await jsonRequest(baseUrl, '/api/me', { cookie: recoveredLogin.cookie })).body.admin.role, 'MAIN_ADMIN');
  app.set('trust proxy', 1);
  result = await jsonRequest(baseUrl, '/api/auth/bootstrap', {
    method: 'POST',
    body: recoveredMainAdmin,
    headers: { 'x-forwarded-for': '192.0.2.42' }
  });
  assert.equal(result.status, 409, 'fresh Main Admin initialization remains one-time only');
});
