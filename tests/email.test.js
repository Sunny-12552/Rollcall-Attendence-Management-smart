import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mock, test } from 'node:test';
import {
  buildAccountStatusEmail,
  buildAbsenceNotificationEmail,
  buildAdminInvitationEmail,
  buildAdminOtpEmail,
  buildAttendanceNotificationEmail,
  buildAttendanceSummaryEmail,
  buildPasswordResetEmail,
  buildWelcomeEmail,
  emailConfigurationMessage,
  emailDeliveryErrorMessage,
  isEmailConfigured,
  sendEmail
} from '../email-service.js';

test('admin email templates include dynamic, safely rendered verification details', () => {
  const verification = buildAdminOtpEmail({
    name: 'Asha <Admin>',
    email: 'asha@example.test',
    role: 'ADMIN',
    otp: '123456',
    expiryMinutes: 10
  });
  assert.match(verification.subject, /Verify Your Account/);
  assert.match(verification.text, /Asha <Admin>/);
  assert.match(verification.html, /Asha &lt;Admin&gt;/);
  assert.match(verification.html, /asha@example\.test/);
  assert.match(verification.html, /ADMIN/);
  assert.match(verification.html, /123456/);
  assert.match(verification.html, /valid for 10 minutes/);
  assert.match(verification.html, /<table role="presentation"/);

  const invitation = buildAdminInvitationEmail({
    name: 'Priya Sharma',
    email: 'priya@example.test',
    role: 'ADMIN',
    otp: '456789',
    temporaryPassword: 'temporary-random-password'
  });
  assert.match(invitation.subject, /Invitation/);
  assert.match(invitation.html, /Priya Sharma/);
  assert.match(invitation.html, /priya@example\.test/);
  assert.match(invitation.html, /456789/);
  assert.match(invitation.html, /temporary-random-password/);
  assert.match(invitation.text, /change it immediately after signing in/i);

  const reset = buildPasswordResetEmail({ name: 'Asha', otp: '654321', expiryMinutes: 10 });
  assert.match(reset.subject, /Password Reset OTP/);
  assert.match(reset.html, /654321/);
  assert.match(reset.text, /ignore this message/);
});

test('account status and welcome templates use the supplied account details', () => {
  const welcome = buildWelcomeEmail({ name: 'Sam', email: 'sam@example.test', role: 'ADMIN' });
  assert.match(welcome.html, /Sam/);
  assert.match(welcome.html, /sam@example\.test/);
  assert.match(welcome.html, /successfully verified/);
  const pendingWelcome = buildWelcomeEmail({
    name: 'Sam', email: 'sam@example.test', role: 'ADMIN', approvalPending: true
  });
  assert.match(pendingWelcome.text, /waiting for Main Admin approval/i);
  assert.match(pendingWelcome.text, /cannot sign in until it is approved/i);

  const activated = buildAccountStatusEmail({
    name: 'Sam', email: 'sam@example.test', role: 'ADMIN', active: true
  });
  const deactivated = buildAccountStatusEmail({
    name: 'Sam', email: 'sam@example.test', role: 'ADMIN', active: false
  });
  assert.match(activated.subject, /Activated/);
  assert.match(deactivated.subject, /Deactivated/);
  assert.match(deactivated.text, /no longer be able to sign in/);
});

test('attendance templates render actual attendance and per-subject summary values', () => {
  const present = buildAttendanceNotificationEmail({
    studentName: 'Nila Rao',
    studentId: 'STU-000023',
    subject: 'Python Full Stack',
    date: '2026-10-08',
    time: '09:15:30',
    facultyName: 'Faculty One',
    status: 'Present'
  });
  for (const value of ['Nila Rao', 'STU-000023', 'Python Full Stack', '2026-10-08', '09:15:30', 'Faculty One', 'Present']) {
    assert.ok(present.text.includes(value), `attendance email should include ${value}`);
  }

  const absent = buildAbsenceNotificationEmail({
    studentName: 'Nila Rao',
    subject: 'Java Full Stack',
    date: '2026-10-08',
    facultyName: 'Faculty Two'
  });
  assert.match(absent.subject, /Java Full Stack/);
  assert.match(absent.html, /Nila Rao/);
  assert.match(absent.html, /Faculty Two/);
  assert.match(absent.html, /Absent/);

  const summary = buildAttendanceSummaryEmail({
    studentName: 'Nila Rao',
    totalClasses: 12,
    presentCount: 9,
    absentCount: 3,
    attendancePercentage: '75.00',
    subjectSummary: [
      { subject: 'Python Full Stack', total: 8, present: 6, percentage: '75.00' },
      { subject: 'Java Full Stack', total: 4, present: 3, percentage: '75.00' }
    ]
  });
  for (const value of ['12', '9', '3', '75.00%', 'Python Full Stack', 'Java Full Stack']) {
    assert.ok(summary.text.includes(value), `summary email should include ${value}`);
  }
});

test('SMTP configuration and delivery errors are safe for API responses', async (t) => {
  const keys = ['EMAIL_PROVIDER', 'EMAIL_FROM', 'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'SMTP_SECURE'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.EMAIL_PROVIDER = 'smtp';
    assert.equal(isEmailConfigured(), false);
    assert.match(emailConfigurationMessage(), /SMTP_HOST, SMTP_USER, SMTP_PASSWORD/);
    await assert.rejects(
      sendEmail('student@example.test', { subject: 'Test', text: 'Test', html: '<p>Test</p>' }),
      (error) => error.code === 'EMAIL_NOT_CONFIGURED'
        && error.message === emailConfigurationMessage()
    );

    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1';
    process.env.SMTP_USER = 'private-test-user';
    process.env.SMTP_PASSWORD = 'private-test-password';
    process.env.SMTP_FROM = 'sender@example.test';
    process.env.SMTP_SECURE = 'maybe';
    assert.equal(isEmailConfigured(), false);
    assert.match(emailConfigurationMessage(), /SMTP_SECURE set to "true" or "false"/);
    process.env.SMTP_SECURE = 'false';
    process.env.SMTP_HOST = 'smtp.gmail.com';
    assert.match(
      emailDeliveryErrorMessage({ code: 'EMAIL_AUTH_FAILED' }),
      /use a Google App Password as SMTP_PASSWORD/i
    );
    assert.doesNotMatch(
      emailDeliveryErrorMessage({ code: 'EMAIL_AUTH_FAILED' }),
      /private-test-password|smtp\.gmail\.com/
    );
    assert.match(emailDeliveryErrorMessage({ code: 'EMAIL_DELIVERY_TIMEOUT' }), /SMTP server timed out/);
    process.env.SMTP_HOST = '127.0.0.1';
    let connectionCount = 0;
    const sockets = new Set();
    const stalledServer = createServer((socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      if (connectionCount === 1) socket.destroy();
    });
    await new Promise((resolve) => stalledServer.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      stalledServer.close();
    });
    process.env.SMTP_PORT = String(stalledServer.address().port);
    await assert.rejects(
      sendEmail('student@example.test', { subject: 'Test', text: 'Test', html: '<p>Test</p>' }),
      (error) => error.code === 'EMAIL_DELIVERY_FAILED'
        && error.message === 'Unable to send email.'
        && !error.message.includes(process.env.SMTP_PASSWORD)
    );

    await assert.rejects(
      sendEmail('student@example.test', { subject: 'Test', text: 'Test', html: '<p>Test</p>' }),
      (error) => error.code === 'EMAIL_DELIVERY_TIMEOUT'
        && /SMTP server timed out/i.test(emailDeliveryErrorMessage(error))
    );
    await new Promise((resolve) => stalledServer.close(resolve));
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('Resend configuration and HTTPS delivery handle success and API failures', async (t) => {
  const keys = ['EMAIL_PROVIDER', 'EMAIL_FROM', 'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'SMTP_SECURE'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'test-resend-api-key';
    process.env.EMAIL_FROM = 'sender@example.test';
    assert.equal(isEmailConfigured(), true);

    let status = 200;
    let networkError;
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      requests.push({ url, options });
      if (networkError) throw networkError;
      return new Response(JSON.stringify({ id: 'test-email-id' }), { status });
    });

    const message = {
      subject: 'Test subject',
      text: 'Plain-text body',
      html: '<p>HTML body</p>'
    };
    await sendEmail('recipient@example.test', message);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.resend.com/emails');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer test-resend-api-key');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      from: 'Attendance Management System <sender@example.test>',
      to: 'recipient@example.test',
      ...message
    });

    status = 422;
    await assert.rejects(
      sendEmail('recipient@example.test', message),
      (error) => error.code === 'EMAIL_DELIVERY_FAILED'
        && emailDeliveryErrorMessage(error).includes('sender domain')
        && !emailDeliveryErrorMessage(error).includes('test-resend-api-key')
    );

    status = 401;
    await assert.rejects(
      sendEmail('recipient@example.test', message),
      (error) => error.code === 'EMAIL_AUTH_FAILED'
        && /check RESEND_API_KEY/i.test(emailDeliveryErrorMessage(error))
        && !emailDeliveryErrorMessage(error).includes('test-resend-api-key')
    );

    status = 403;
    await assert.rejects(
      sendEmail('recipient@example.test', message),
      (error) => error.code === 'EMAIL_DELIVERY_FAILED'
        && /recipient restrictions/i.test(emailDeliveryErrorMessage(error))
    );

    networkError = new DOMException('The operation timed out.', 'TimeoutError');
    await assert.rejects(
      sendEmail('recipient@example.test', message),
      (error) => error.code === 'EMAIL_DELIVERY_TIMEOUT'
        && /Resend request timed out/i.test(emailDeliveryErrorMessage(error))
    );

    process.env.EMAIL_FROM = '';
    assert.equal(isEmailConfigured(), false);
    assert.match(emailConfigurationMessage(), /a valid EMAIL_FROM/);
    await assert.rejects(
      sendEmail('recipient@example.test', message),
      (error) => error.code === 'EMAIL_NOT_CONFIGURED'
    );
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
