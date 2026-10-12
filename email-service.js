import nodemailer from 'nodemailer';

const OTP_EXPIRY_MINUTES = 10;
const EMAIL_SENDER_NAME = 'Attendance Management System';
let cachedTransport;

function emailProvider() {
  return String(process.env.EMAIL_PROVIDER || 'smtp').trim().toLowerCase();
}

function smtpEmailConfig() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const password = String(process.env.SMTP_PASSWORD || '');
  const from = String(process.env.EMAIL_FROM || process.env.SMTP_FROM || '').trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secureValue = String(process.env.SMTP_SECURE || 'false').trim().toLowerCase();
  if (
    !host || !user || !password || !isValidEmailAddress(from)
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !['true', 'false'].includes(secureValue)
  ) {
    return null;
  }
  return { host, user, password, from, port, secure: secureValue === 'true' };
}

function resendEmailConfig() {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.EMAIL_FROM || '').trim();
  if (!apiKey || !isValidEmailAddress(from)) return null;
  return { apiKey, from };
}

function isValidEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isEmailConfigured() {
  const provider = emailProvider();
  if (provider === 'resend') return resendEmailConfig() !== null;
  if (provider === 'smtp') return smtpEmailConfig() !== null;
  return false;
}

export function emailConfigurationMessage() {
  const provider = emailProvider();
  if (provider === 'resend') {
    const missing = [
      ...(!String(process.env.RESEND_API_KEY || '').trim() ? ['RESEND_API_KEY'] : []),
      ...(!isValidEmailAddress(String(process.env.EMAIL_FROM || '').trim()) ? ['a valid EMAIL_FROM'] : [])
    ];
    return `Email service is not configured for Resend. Set ${missing.join(' and ')}.`;
  }
  if (provider === 'smtp') {
    const missing = [
      ...(!String(process.env.SMTP_HOST || '').trim() ? ['SMTP_HOST'] : []),
      ...(!String(process.env.SMTP_USER || '').trim() ? ['SMTP_USER'] : []),
      ...(!String(process.env.SMTP_PASSWORD || '') ? ['SMTP_PASSWORD'] : []),
      ...(!isValidEmailAddress(String(process.env.EMAIL_FROM || process.env.SMTP_FROM || '').trim())
        ? ['a valid EMAIL_FROM (or SMTP_FROM)']
        : []),
      ...(!Number.isInteger(Number(process.env.SMTP_PORT || 587))
        || Number(process.env.SMTP_PORT || 587) < 1
        || Number(process.env.SMTP_PORT || 587) > 65535
        ? ['a valid SMTP_PORT']
        : []),
      ...(!['true', 'false'].includes(String(process.env.SMTP_SECURE || 'false').trim().toLowerCase())
        ? ['SMTP_SECURE set to "true" or "false"']
        : [])
    ];
    return `Email service is not configured for SMTP. Set ${missing.join(', ')}.`;
  }
  return 'Email service is not configured. Set EMAIL_PROVIDER to "resend" or "smtp".';
}

export function emailDeliveryErrorMessage(error) {
  if (error?.code === 'EMAIL_NOT_CONFIGURED') return emailConfigurationMessage();
  if (error?.code === 'OTP_RATE_LIMITED') return 'Please wait one minute before requesting another code.';
  if (error?.code === 'EMAIL_DELIVERY_TIMEOUT') {
    return emailProvider() === 'resend'
      ? 'The Resend request timed out. Check network access and Resend status, then retry.'
      : 'The SMTP server timed out. Check the host, port, TLS settings, and network access, then retry.';
  }
  if (error?.code === 'EMAIL_AUTH_FAILED') {
    if (emailProvider() === 'resend') {
      return 'Resend rejected the API key. Check RESEND_API_KEY in the deployment environment.';
    }
    return /gmail/i.test(String(process.env.SMTP_HOST || ''))
      ? 'Gmail rejected the sender login. Enable 2-Step Verification and use a Google App Password as SMTP_PASSWORD, then restart the app.'
      : 'The email server rejected the sender login. Check SMTP_USER and SMTP_PASSWORD in .env, then restart the app.';
  }
  if (emailProvider() === 'resend') {
    if (error?.status === 403) {
      return 'Resend rejected this request. Check API-key permissions, sender-domain verification, and recipient restrictions.';
    }
    if (error?.status === 422) {
      return 'Resend rejected the sender or recipient. Verify the sender domain and confirm that the recipient is allowed for this account.';
    }
    return 'Unable to deliver email through Resend. Check network access, sender-domain verification, and recipient restrictions, then try again.';
  }
  return 'Unable to deliver the email. Please check the SMTP settings and try again.';
}

function getTransport() {
  const config = smtpEmailConfig();
  if (!config) {
    const error = new Error(emailConfigurationMessage());
    error.code = 'EMAIL_NOT_CONFIGURED';
    throw error;
  }
  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000
    });
  }
  return {
    transport: cachedTransport,
    from: { name: EMAIL_SENDER_NAME, address: config.from }
  };
}

async function sendWithResend(config, to, emailMessage) {
  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `${EMAIL_SENDER_NAME} <${config.from}>`,
        to,
        subject: emailMessage.subject,
        text: emailMessage.text,
        html: emailMessage.html
      }),
      signal: AbortSignal.timeout(15000)
    });
  } catch (cause) {
    const error = new Error('The Resend API request failed.');
    error.code = cause?.name === 'AbortError' || cause?.name === 'TimeoutError'
      ? 'EMAIL_DELIVERY_TIMEOUT'
      : 'EMAIL_DELIVERY_FAILED';
    throw error;
  }

  if (!response.ok) {
    const error = new Error('The Resend API rejected the email request.');
    error.code = response.status === 401 ? 'EMAIL_AUTH_FAILED' : 'EMAIL_DELIVERY_FAILED';
    error.status = response.status;
    throw error;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function safeSubject(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
}

function renderEmail({ title, name, intro, details = [], highlight, notice, closing }) {
  const safeName = escapeHtml(name || 'there');
  const detailRows = details.map(([label, value]) =>
    `<tr><td style="padding:8px 12px;color:#65716d;font-size:13px">${escapeHtml(label)}</td><td style="padding:8px 12px;color:#183b35;font-size:14px;font-weight:600;text-align:right">${escapeHtml(value)}</td></tr>`
  ).join('');
  const detailsHtml = detailRows
    ? `<table role="presentation" style="width:100%;border-collapse:collapse;background:#f5f7f4;border-radius:8px">${detailRows}</table>`
    : '';
  const highlightHtml = highlight
    ? `<div style="margin:22px 0;padding:18px;background:#edf5f0;border:1px solid #d7e8dc;border-radius:10px;text-align:center"><div style="font-size:12px;color:#51645b;margin-bottom:8px">${escapeHtml(highlight.label)}</div><div style="font-size:28px;line-height:1.3;letter-spacing:7px;font-weight:700;color:#153b3b;word-break:break-word">${escapeHtml(highlight.value)}</div></div>`
    : '';
  const noticeHtml = notice
    ? `<div style="margin-top:20px;padding:12px 14px;border-left:3px solid #e88a69;background:#fff7f2;color:#66584f;font-size:13px;line-height:1.6">${escapeHtml(notice)}</div>`
    : '';
  const closingHtml = closing ? `<p style="margin:24px 0 0;color:#3d5049;font-size:14px;line-height:1.6">${escapeHtml(closing)}</p>` : '';
  const html = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f1f4f1;font-family:Arial,Helvetica,sans-serif;color:#183b35"><table role="presentation" style="width:100%;max-width:600px;margin:0 auto;border-collapse:collapse;background:#ffffff;border-radius:14px;overflow:hidden"><tr><td style="padding:24px 30px;background:#153b3b;color:#ffffff"><div style="font-size:20px;font-weight:700;letter-spacing:.2px">Attendance Management System</div><div style="margin-top:5px;color:#cbe0d6;font-size:12px">Secure attendance updates</div></td></tr><tr><td style="padding:30px"><h1 style="margin:0 0 18px;font-size:22px;line-height:1.35;color:#183b35">${escapeHtml(title)}</h1><p style="margin:0 0 12px;font-size:15px;line-height:1.6">Hello ${safeName},</p><p style="margin:0 0 20px;color:#465b53;font-size:14px;line-height:1.7">${escapeHtml(intro)}</p>${detailsHtml}${highlightHtml}${noticeHtml}${closingHtml}<p style="margin:28px 0 0;color:#183b35;font-size:14px;line-height:1.6">Regards,<br><strong>Attendance Management System</strong></p></td></tr><tr><td style="padding:16px 30px;border-top:1px solid #e7ece8;color:#78847f;font-size:11px;line-height:1.5">This is an automated message from the Attendance Management System. Please do not reply to this email.</td></tr></table></body></html>`;
  return html;
}

function plainText({ title, name, intro, details = [], highlight, notice, closing }) {
  const lines = [
    title,
    '',
    `Hello ${name || 'there'},`,
    '',
    intro,
    ...details.map(([label, value]) => `${label}: ${value}`),
    ...(highlight ? ['', `${highlight.label}: ${highlight.value}`] : []),
    ...(notice ? ['', notice] : []),
    ...(closing ? ['', closing] : []),
    '',
    'Regards,',
    'Attendance Management System'
  ];
  return lines.join('\n');
}

function message({ subject, title, name, intro, details, highlight, notice, closing }) {
  const model = { title, name, intro, details, highlight, notice, closing };
  return {
    subject: safeSubject(subject),
    html: renderEmail(model),
    text: plainText(model)
  };
}

function otpMessage({ name, email, role = 'ADMIN', otp, expiryMinutes = OTP_EXPIRY_MINUTES, invitation = false, reset = false, temporaryPassword }) {
  const title = reset
    ? 'Password reset verification'
    : invitation
      ? 'You have been invited as an administrator'
      : 'Verify your administrator account';
  const subject = reset
    ? 'Attendance Management System - Password Reset OTP'
    : invitation
      ? 'Attendance Management System - Administrator Invitation'
      : 'Attendance Management System - Verify Your Account';
  const intro = reset
    ? 'We received a request to reset your administrator password.'
    : invitation
      ? temporaryPassword
        ? 'The Main Admin created an administrator account for you. Sign in with the email and short temporary password below, then enter the one-time code. You will be required to choose a new password before using the dashboard.'
        : 'You have been invited to join the Attendance Management System. Complete signup and verify your email using this code.'
      : 'Welcome to the Attendance Management System! Your account has been created successfully.';
  const details = reset
    ? []
    : [['Email', email], ['Role', role], ...(temporaryPassword ? [['Temporary password', temporaryPassword]] : [])];
  return message({
    subject,
    title,
    name,
    intro,
    details,
    highlight: { label: `Your verification code · valid for ${expiryMinutes} minutes`, value: otp },
    notice: reset
      ? 'If you did not request a password reset, you can ignore this message. Never share this code with anyone.'
      : invitation && temporaryPassword
        ? 'The temporary password is for first sign-in only. Change it immediately after signing in. Do not share these credentials or the one-time code.'
        : 'Please do not share this verification code with anyone.'
  });
}

export function buildAdminOtpEmail(details) {
  return otpMessage(details);
}

export function buildAdminInvitationEmail(details) {
  return otpMessage({ ...details, invitation: true });
}

export function buildPasswordResetEmail(details) {
  return otpMessage({ ...details, reset: true });
}

export function buildWelcomeEmail({ name, email, role = 'ADMIN', approvalPending = false }) {
  return message({
    subject: approvalPending ? 'Admin Registration Received' : 'Welcome to the Attendance Management System',
    title: approvalPending ? 'Your email is verified' : 'Your account is verified',
    name,
    intro: approvalPending
      ? 'Your email has been verified. Your administrator registration is waiting for Main Admin approval; you cannot sign in until it is approved.'
      : 'Your account has been successfully verified. You can now log in to the Attendance Management System.',
    details: [['Account email', email], ['Role', role]],
    closing: approvalPending
      ? 'You will be able to sign in after your administrator account is approved.'
      : 'You can now sign in using your registered email and password.'
  });
}

export function buildAttendanceNotificationEmail({ studentName, studentId, subject, date, time, facultyName, status }) {
  return message({
    subject: `Attendance Recorded - ${safeSubject(subject)}`,
    title: 'Attendance recorded',
    name: studentName,
    intro: 'Your attendance has been recorded successfully.',
    details: [
      ['Student name', studentName],
      ['Student ID', studentId || 'Not assigned'],
      ['Subject', subject],
      ['Date', date],
      ['Time', time],
      ['Faculty', facultyName || 'Attendance team'],
      ['Status', status]
    ]
  });
}

export function buildAbsenceNotificationEmail({ studentName, subject, date, facultyName }) {
  return message({
    subject: `Attendance Alert - ${safeSubject(subject)}`,
    title: 'Attendance alert',
    name: studentName,
    intro: 'You were marked absent for the following class.',
    details: [
      ['Subject', subject],
      ['Date', date],
      ['Faculty', facultyName || 'Attendance team'],
      ['Status', 'Absent']
    ],
    notice: 'Please contact your faculty if you believe this is incorrect.'
  });
}

export function buildAttendanceSummaryEmail({ studentName, totalClasses, presentCount, absentCount, attendancePercentage, subjectSummary }) {
  const summary = (subjectSummary || []).map((item) =>
    `${item.subject}: ${item.present} present / ${item.total} total (${item.percentage}%)`
  );
  return message({
    subject: `Attendance Summary - ${safeSubject(studentName)}`,
    title: 'Your attendance summary',
    name: studentName,
    intro: 'Here is your attendance summary based on recorded attendance.',
    details: [
      ['Total classes', totalClasses],
      ['Present', presentCount],
      ['Absent', absentCount],
      ['Attendance percentage', `${attendancePercentage}%`],
      ...summary.map((line, index) => [`Subject ${index + 1}`, line])
    ]
  });
}

export function buildAccountStatusEmail({ name, email, role = 'ADMIN', active }) {
  return message({
    subject: `Attendance Management System - Account ${active ? 'Activated' : 'Deactivated'}`,
    title: `Your account has been ${active ? 'activated' : 'deactivated'}`,
    name,
    intro: active
      ? 'An administrator has reactivated your account. You can sign in again.'
      : 'An administrator has deactivated your account. You will no longer be able to sign in.',
    details: [['Account email', email], ['Role', role]]
  });
}

export async function sendEmail(to, emailMessage) {
  const provider = emailProvider();
  if (!isEmailConfigured()) {
    const error = new Error(emailConfigurationMessage());
    error.code = 'EMAIL_NOT_CONFIGURED';
    throw error;
  }

  if (provider === 'resend') {
    try {
      await sendWithResend(resendEmailConfig(), to, emailMessage);
      return;
    } catch (error) {
      console.error('Email delivery failed with Resend:', error.status ? `HTTP ${error.status}` : error.code);
      throw error;
    }
  }

  try {
    const { transport, from } = getTransport();
    await transport.sendMail({
      from,
      to,
      subject: emailMessage.subject,
      text: emailMessage.text,
      html: emailMessage.html
    });
  } catch (error) {
    if (error.code === 'EMAIL_NOT_CONFIGURED') throw error;
    console.error('Email delivery failed with SMTP:', error.code || 'unknown error');
    const authFailure = error.code === 'EAUTH'
      || error.responseCode === 534
      || error.responseCode === 535
      || /invalid login|application-specific password|authentication failed/i.test(error.message || '');
    const timedOut = error.code === 'ETIMEDOUT'
      || ((error.code === 'ESOCKET' || error.code === 'ECONNECTION')
        && /timed?\s*out|timeout/i.test(error.message || ''));
    const deliveryError = new Error(authFailure
      ? 'The SMTP server rejected authentication.'
      : timedOut ? 'The SMTP server timed out.' : 'Unable to send email.');
    deliveryError.code = authFailure
      ? 'EMAIL_AUTH_FAILED'
      : timedOut ? 'EMAIL_DELIVERY_TIMEOUT' : 'EMAIL_DELIVERY_FAILED';
    throw deliveryError;
  }
}

export async function sendAdminOtp({ to, ...details }) {
  return sendEmail(to, buildAdminOtpEmail(details));
}

export async function sendAdminInvitation({ to, ...details }) {
  return sendEmail(to, buildAdminInvitationEmail(details));
}

export async function sendWelcomeEmail({ to, ...details }) {
  return sendEmail(to, buildWelcomeEmail(details));
}

export async function sendPasswordResetOtp({ to, ...details }) {
  return sendEmail(to, buildPasswordResetEmail(details));
}

export async function sendAttendanceNotification({ to, ...details }) {
  return sendEmail(to, buildAttendanceNotificationEmail(details));
}

export async function sendAbsenceNotification({ to, ...details }) {
  return sendEmail(to, buildAbsenceNotificationEmail(details));
}

export async function sendAttendanceSummary({ to, ...details }) {
  return sendEmail(to, buildAttendanceSummaryEmail(details));
}

export async function sendAccountStatusEmail({ to, ...details }) {
  return sendEmail(to, buildAccountStatusEmail(details));
}

export { OTP_EXPIRY_MINUTES };
