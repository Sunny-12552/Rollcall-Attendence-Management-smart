const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get('session');
const DEVICE_TOKEN_KEY = 'attendance-device-token';
let config = { subjects: [], batches: [] };
let records = [];
let dashboardDate = '';
let bootstrapRequired = false;
let bootstrapMode = 'create';
let successToastTimer;
let successToastHideTimer;

function generateDeviceToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `dev-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
function getDeviceToken() {
  const existing = localStorage.getItem(DEVICE_TOKEN_KEY);
  if (existing && /^[A-Za-z0-9._:-]{12,128}$/.test(existing)) return existing;
  const next = generateDeviceToken();
  localStorage.setItem(DEVICE_TOKEN_KEY, next);
  return next;
}
const deviceToken = getDeviceToken();

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong.');
    error.status = response.status;
    throw error;
  }
  return data;
}
function show(id) { document.querySelectorAll('.view').forEach((view) => view.classList.add('hidden')); $(id).classList.remove('hidden'); }
function message(id, text = '') { $(id).textContent = text; }
function successMessage(id, text) {
  message(id, text);
  const toast = $('success-toast');
  toast.textContent = text;
  clearTimeout(successToastTimer);
  clearTimeout(successToastHideTimer);
  toast.classList.remove('hidden');
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  successToastTimer = setTimeout(() => {
    toast.classList.remove('is-visible');
    successToastHideTimer = setTimeout(() => toast.classList.add('hidden'), 200);
  }, 4800);
}
function fillSelect(id, values, first = '') { const el = $(id); el.innerHTML = first + values.map((value) => `<option value="${value}">${value}</option>`).join(''); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }

async function loadConfig() { config = await api('/api/config'); fillSelect('student-batch', config.batches); fillSelect('attendance-check-batch', config.batches); fillSelect('subject', config.subjects); fillSelect('scope-batch', config.batches, '<option value="">All batches</option>'); fillSelect('correction-batch', config.batches); fillSelect('correction-subject', config.subjects); fillSelect('summary-email-batch', config.batches); }
async function initStudent() {
  show('student-view');
  try { const session = await api(`/api/sessions/${encodeURIComponent(token)}`); attendedSubject = session.subject; $('session-summary').textContent = `${session.subject}${session.batch ? ` · ${session.batch} only` : ''}`; }
  catch (error) { $('session-summary').textContent = error.message; $('attendance-form').classList.add('hidden'); }
}
let attendedSubject = '';
function showAttendanceChecker(name, batch) { $('student-attendance').classList.remove('hidden'); $('attendance-check-name').value = name; $('attendance-check-batch').value = batch; }
function keepStudentOnSessionAfterDeviceBlock() {
  message('student-message', 'Attendance Limit Reached. This device has already marked attendance for this subject.');
}

$('attendance-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  message('student-message', 'Saving...');
  const name = $('student-name').value;
  const batch = $('student-batch').value;
  try {
    const result = await api('/api/attendance', {
      method: 'POST',
      body: JSON.stringify({ token, name, batch, email: $('student-email').value, deviceToken })
    });
    attendedSubject = result.subject;
    $('attendance-form').classList.add('hidden');
    $('confirmation').classList.remove('hidden');
    const emailMessage = result.emailNotification === 'sent'
      ? '<br>Attendance confirmation sent to your email.'
      : result.emailNotification === 'failed'
        ? '<br>Attendance was recorded, but the confirmation email could not be sent.'
        : result.emailNotification === 'not-configured'
          ? '<br>Email updates are temporarily unavailable; attendance was recorded.'
          : '';
    const registryMessage = result.deviceRegistrySync === 'failed'
      ? '<br>Device security record is saved locally, but its Google Sheets copy could not be updated.'
      : '';
    $('confirmation').innerHTML = `<strong>Attendance marked successfully.</strong><br>${escapeHtml(result.name)} · ${escapeHtml(result.batch)} · ${escapeHtml(result.course)}<br>${escapeHtml(result.subject)} · ${escapeHtml(result.date)} · ${escapeHtml(result.status)}${emailMessage}${registryMessage}`;
    successMessage('student-message', 'Attendance marked successfully.');
    showAttendanceChecker(result.name, result.batch);
  } catch (error) {
    message('student-message', error.message);
    if (error.message.includes('Attendance Limit Reached')) return keepStudentOnSessionAfterDeviceBlock();
    if (error.message.includes('already been marked')) showAttendanceChecker(name, batch);
  }
});
$('student-attendance-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('attendance-check-button');
  button.disabled = true;
  button.textContent = 'Checking attendance...';
  message('attendance-check-message');
  $('student-attendance-result').classList.add('hidden');
  try {
    const query = new URLSearchParams({
      name: $('attendance-check-name').value,
      batch: $('attendance-check-batch').value,
      subject: attendedSubject
    });
    const result = await api(`/api/student-attendance?${query}`);
    const percentage = `${Number(result.attendance.percentage).toFixed(2).replace(/\.00$/, '')}%`;
    const date = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }).format(new Date(`${result.today.date}T00:00:00`));
    const statusClass = result.today.status.toLowerCase().replace(' ', '-');
    $('student-attendance-result').innerHTML = `<div class="attendance-result-head"><strong>Your Attendance</strong><span class="status-pill ${statusClass}">${escapeHtml(result.today.status)}</span></div><p><strong>Student:</strong> ${escapeHtml(result.student.name)}<br><strong>Batch:</strong> ${escapeHtml(result.student.batch)}</p><div class="today-status"><span>Today's Attendance</span><strong>${escapeHtml(date)}</strong><b class="${statusClass}">${result.today.status === 'Present' ? '✓ ' : result.today.status === 'Absent' ? '✕ ' : ''}${escapeHtml(result.today.status)}</b></div><div class="attendance-percentage"><span>Overall Attendance</span><strong>${percentage}</strong><small>${result.attendance.presentDays} Present / ${result.attendance.totalDays} Total Days</small></div>${result.lowAttendance ? `<div class="attendance-warning"><strong>⚠ Low Attendance</strong><span>Your attendance is below the required ${result.minimumRequired}%.</span><span>Current Attendance: ${percentage}</span><span>Please improve your attendance to avoid attendance shortage.</span></div>` : `<div class="attendance-good"><strong>✓ Attendance is Good</strong><span>Your current attendance is ${percentage}.</span></div>`}`;
    $('student-attendance-result').classList.remove('hidden');
    successMessage('attendance-check-message', 'Attendance details loaded successfully.');
  } catch (error) {
    message('attendance-check-message', error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Check Attendance';
  }
});
function showAuthForm(id) {
  ['login-form', 'registration-form', 'recovery-form', 'first-password-form'].forEach((formId) => $(formId).classList.toggle('hidden', formId !== id));
}
function setCredentialStage(containerId, enabled) {
  const container = $(containerId);
  container.classList.toggle('hidden', !enabled);
  container.querySelectorAll('input').forEach((input) => { input.disabled = !enabled; });
}
let registrationCodeRequested = false;
let registrationOtpPurpose = 'verify';
let recoveryCodeRequested = false;
let otpCountdownTimer = null;
function enterRegistrationOtpStage(purpose, statusText) {
  registrationOtpPurpose = purpose;
  registrationCodeRequested = true;
  $('registration-details').classList.add('hidden');
  $('registration-details').querySelectorAll('input').forEach((input) => { input.disabled = true; });
  setCredentialStage('registration-credentials', true);
  $('registration-resend').classList.remove('hidden');
  $('registration-form').querySelector('button.primary').textContent = 'Verify email';
  if (statusText) message('registration-message', statusText);
}
function startOtpCountdown(messageId, resendButtonId, seconds = 60, statusText = 'If this email is eligible, a code will be sent. Check your inbox and spam folder.') {
  const button = $(resendButtonId);
  let remaining = seconds;
  button.disabled = true;
  button.textContent = `Resend code in ${remaining}s`;
  if (otpCountdownTimer) clearInterval(otpCountdownTimer);
  otpCountdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(otpCountdownTimer);
      otpCountdownTimer = null;
      button.disabled = false;
      button.textContent = 'Resend verification code';
      return;
    }
    button.textContent = `Resend code in ${remaining}s`;
  }, 1000);
  successMessage(messageId, statusText);
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  message('login-message', 'Opening...');
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('login-email').value,
        password: $('password').value,
        otp: $('login-otp').value || undefined
      })
    });
    successMessage('login-message', 'Login successful.');
    $('login-otp-label').classList.add('hidden');
    $('login-otp').required = false;
    if (result.mustChangePassword) {
      $('logout').classList.remove('hidden');
      showAuthForm('first-password-form');
    } else {
      await initDashboard();
    }
  } catch (error) {
    if (error.status === 428) {
      $('login-otp-label').classList.remove('hidden');
      $('login-otp').required = true;
      $('login-otp').focus();
      message('login-message', 'Enter the one-time code from your email. Invited admins must use the invitation code.');
    } else {
      message('login-message', error.message);
    }
  }
});
$('first-password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('first-password-form').querySelector('button[type="submit"]');
  button.disabled = true;
  message('first-password-message', 'Saving password...');
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        password: $('first-password').value,
        confirmPassword: $('first-password-confirm').value
      })
    });
    $('first-password-form').reset();
    successMessage('first-password-message', 'Password changed successfully.');
    await initDashboard();
  } catch (error) {
    message('first-password-message', error.message);
  } finally {
    button.disabled = false;
  }
});
$('first-password-logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  successMessage('login-message', 'Logged out successfully.');
  $('logout').classList.add('hidden');
  showAuthForm('login-form');
  show('login-view');
});
$('show-registration-link').addEventListener('click', () => {
  showAuthForm('registration-form');
  $('bootstrap-secret-label').classList.toggle('hidden', !bootstrapRequired);
  $('bootstrap-claim-help').classList.toggle('hidden', !bootstrapRequired || bootstrapMode !== 'claim');
  $('bootstrap-secret').required = bootstrapRequired;
  $('registration-form').querySelector('h2').textContent = bootstrapRequired
    ? (bootstrapMode === 'claim' ? 'Claim Main Admin' : 'Set up Main Admin')
    : 'Complete admin invitation';
  $('registration-form').querySelector('button.primary').textContent = bootstrapRequired
    ? (bootstrapMode === 'claim' ? 'Claim Main Admin →' : 'Initialize Main Admin →')
    : 'Create account →';
  const claimMode = bootstrapRequired && bootstrapMode === 'claim';
  $('registration-name-label').classList.toggle('hidden', claimMode);
  $('registration-phone-label').classList.toggle('hidden', bootstrapRequired);
  $('registration-phone').required = !bootstrapRequired;
  $('registration-phone').disabled = bootstrapRequired;
  $('registration-confirm-password-label').classList.toggle('hidden', claimMode);
  $('registration-name').required = !claimMode;
  $('registration-name').disabled = claimMode;
  $('registration-confirm-password').required = !claimMode;
  $('registration-confirm-password').disabled = claimMode;
  $('registration-password').autocomplete = claimMode ? 'current-password' : 'new-password';
  if (!bootstrapRequired) {
    $('registration-form').querySelector('h2').textContent = 'Register for admin access';
    $('registration-form').querySelector('button.primary').textContent = 'Submit registration →';
  }
  $('registration-email-label').firstChild.textContent = claimMode ? 'Existing admin email' : 'Email';
  $('registration-password-label').firstChild.textContent = claimMode ? 'Existing admin password' : 'Password';
  message('registration-message');
});
$('resume-signup-link').addEventListener('click', async () => {
  const emailField = $('registration-email');
  if (!emailField.value || !emailField.checkValidity()) {
    message('registration-message', 'Enter the email address used when signing up.');
    emailField.focus();
    return;
  }
  try {
    const result = await api('/api/auth/resend-otp', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'verify', email: emailField.value })
    });
    $('registration-email').value = emailField.value;
    enterRegistrationOtpStage(result.purpose || 'verify');
    showAuthForm('registration-form');
    startOtpCountdown('registration-message', 'registration-resend', 60, 'If this email has a pending signup, a code may have been sent. If you have not submitted signup yet, complete Create admin account first. Check your spam or junk folder.');
  } catch (error) {
    if (error.status === 429) {
      $('registration-email').value = emailField.value;
      enterRegistrationOtpStage('verify', `${error.message} If you already received a code, enter it below. For invited admins, the invitation code is accepted here too.`);
      showAuthForm('registration-form');
    } else {
      message('registration-message', error.message);
    }
  }
});
$('forgot-password-link').addEventListener('click', () => {
  $('recovery-email').value = $('login-email').value;
  showAuthForm('recovery-form');
  message('recovery-message');
});
document.querySelectorAll('.auth-back-link').forEach((button) => button.addEventListener('click', () => showAuthForm('login-form')));
$('registration-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('registration-form').querySelector('button.primary');
  button.disabled = true;
  try {
    const email = $('registration-email').value;
    if (!registrationCodeRequested) {
      const signupResult = await api(bootstrapRequired ? '/api/auth/bootstrap' : '/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          name: $('registration-name').value,
          email,
          phone: $('registration-phone').value,
          password: $('registration-password').value,
          confirmPassword: $('registration-confirm-password').value,
          bootstrapSecret: $('bootstrap-secret').value
        })
      });
      if (signupResult.claimedExistingAccount) {
        $('login-email').value = email;
        $('password').value = $('registration-password').value;
        registrationCodeRequested = false;
        showAuthForm('login-form');
        const me = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password: $('registration-password').value })
        });
        if (me.ok) {
          successMessage('login-message', 'Main Admin login successful.');
          await initDashboard();
          if (signupResult.accountReportSync === 'failed') {
            message('admin-invite-message', 'Main Admin setup succeeded in SQLite, but Google Sheets reports could not be synchronized.');
          }
        }
        return;
      }
      enterRegistrationOtpStage(signupResult.otpPurpose);
      startOtpCountdown(
        'registration-message',
        'registration-resend',
        60,
        signupResult.otpPurpose === 'invite'
          ? 'Use the code from your admin invitation email. It expires 10 minutes after it was sent.'
          : 'Verification code sent. It expires in 10 minutes.'
      );
    } else {
      const verification = await api('/api/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({
          purpose: registrationOtpPurpose,
          email,
          code: $('registration-otp').value
        })
      });
      registrationCodeRequested = false;
      setCredentialStage('registration-credentials', false);
      $('registration-details').classList.remove('hidden');
      $('registration-details').querySelectorAll('input').forEach((input) => { input.disabled = false; });
      $('registration-resend').classList.add('hidden');
      button.textContent = 'Create account →';
      $('login-email').value = email;
      $('password').value = '';
      showAuthForm('login-form');
      successMessage('login-message', verification.approvalPending
        ? 'Email verified. Your registration is pending Main Admin approval; you can sign in after approval.'
        : 'Email verified. Sign in with your email and password.');
    }
  } catch (error) { message('registration-message', error.message); }
  finally { button.disabled = false; }
});
$('recovery-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('recovery-form').querySelector('button.primary');
  button.disabled = true;
  try {
    const email = $('recovery-email').value;
    if (!recoveryCodeRequested) {
      await api('/api/auth/resend-otp', { method: 'POST', body: JSON.stringify({ purpose: 'reset', email }) });
      recoveryCodeRequested = true;
      setCredentialStage('recovery-credentials', true);
      $('recovery-resend').classList.remove('hidden');
      button.textContent = 'Change password';
      startOtpCountdown(
        'recovery-message',
        'recovery-resend',
        60,
        'If this email belongs to an active admin account, a code will be sent. Check your inbox and spam folder; codes expire after 10 minutes.'
      );
    } else {
      await api('/api/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({
          purpose: 'reset',
          email,
          code: $('recovery-otp').value,
          password: $('recovery-password').value,
          confirmPassword: $('recovery-confirm-password').value
        })
      });
      $('login-email').value = email;
      $('password').value = '';
      recoveryCodeRequested = false;
      setCredentialStage('recovery-credentials', false);
      $('recovery-resend').classList.add('hidden');
      button.textContent = 'Send verification code →';
      showAuthForm('login-form');
      successMessage('login-message', 'Password changed successfully. Sign in with your new password.');
    }
  } catch (error) { message('recovery-message', error.message); }
  finally { button.disabled = false; }
});
$('registration-resend').addEventListener('click', async () => {
  const button = $('registration-resend');
  button.disabled = true;
  try {
    await api('/api/auth/resend-otp', { method: 'POST', body: JSON.stringify({ purpose: registrationOtpPurpose, email: $('registration-email').value }) });
    startOtpCountdown(
      'registration-message',
      'registration-resend',
      60,
      'If this email has a pending registration, a code will be sent. Check your inbox and spam folder.'
    );
  } catch (error) { button.disabled = false; message('registration-message', error.message); }
});
$('recovery-resend').addEventListener('click', async () => {
  const button = $('recovery-resend');
  button.disabled = true;
  try {
    await api('/api/auth/resend-otp', { method: 'POST', body: JSON.stringify({ purpose: 'reset', email: $('recovery-email').value }) });
    startOtpCountdown(
      'recovery-message',
      'recovery-resend',
      60,
      'If this email belongs to an active admin account, a code will be sent. Check your inbox and spam folder.'
    );
  } catch (error) { button.disabled = false; message('recovery-message', error.message); }
});
setCredentialStage('registration-credentials', false);
setCredentialStage('recovery-credentials', false);
const attendanceResultObserver = new MutationObserver(() => {
  const resultCard = $('student-attendance-result');
  const details = resultCard.querySelector('p');
  if (!details || details.dataset.idAdded === 'true') return;
  const query = new URLSearchParams({ name: $('attendance-check-name').value, batch: $('attendance-check-batch').value, subject: attendedSubject });
  api(`/api/student-attendance?${query}`).then((result) => {
    details.innerHTML = `<strong>Student:</strong> ${escapeHtml(result.student.name)}<br><strong>Student ID:</strong> ${escapeHtml(result.student.id || 'Not assigned')}<br><strong>Batch:</strong> ${escapeHtml(result.student.batch)}`;
    details.dataset.idAdded = 'true';
  }).catch(() => {});
});
attendanceResultObserver.observe($('student-attendance-result'), { childList: true });
$('logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  successMessage('login-message', 'Logged out successfully.');
  $('logout').classList.add('hidden');
  $('login-otp-label').classList.add('hidden');
  $('login-otp').required = false;
  showAuthForm('login-form');
  show('login-view');
});
async function refreshQrRecoverySessions() {
  const body = $('qr-recovery-sessions');
  body.innerHTML = '<tr><td colspan="7">Loading QR sessions...</td></tr>';
  try {
    const sessions = await api('/api/sessions');
    body.innerHTML = sessions.length ? sessions.map((session) => {
      const actions = [
        `<button class="secondary" type="button" data-qr-action="view" data-session-id="${escapeHtml(session.id)}">View QR Code</button>`
      ];
      if (session.canRecover) {
        actions.push(`<button class="secondary" type="button" data-qr-action="recover" data-session-id="${escapeHtml(session.id)}">Recover QR Session</button>`);
      }
      if (session.status === 'Active') {
        actions.push(`<button class="secondary" type="button" data-qr-action="close" data-session-id="${escapeHtml(session.id)}">Close Session</button>`);
      }
      return `<tr><td>${escapeHtml(session.subject)}${session.batch ? `<br><span class="muted">${escapeHtml(session.batch)}</span>` : ''}</td><td>${escapeHtml(session.attendanceDate)}</td><td>${escapeHtml(session.status)}</td><td><code>${escapeHtml(session.id)}</code></td><td>${Number(session.markedStudents)}</td><td>${escapeHtml(session.recoveryStatus)}${session.lastRecoveredAt ? `<br><span class="muted">${escapeHtml(new Date(session.lastRecoveredAt).toLocaleString())}</span>` : ''}</td><td><div class="form-grid">${actions.join('')}</div></td></tr>`;
    }).join('') : '<tr><td colspan="7">No active or closed QR sessions are available for your assigned subjects.</td></tr>';
    message('qr-recovery-message');
  } catch (error) {
    body.innerHTML = '<tr><td colspan="7">Unable to load QR sessions.</td></tr>';
    message('qr-recovery-message', error.message);
  }
}
async function showOriginalQr(sessionId) {
  const session = await api(`/api/sessions/${encodeURIComponent(sessionId)}/qr`);
  $('qr-result').classList.remove('hidden');
  $('qr-result').innerHTML = `<img src="${session.qr}" alt="Original attendance QR code"><p><a href="${escapeHtml(session.url)}" target="_blank" rel="noopener noreferrer">Open original student page ↗</a></p><p class="muted">${escapeHtml(session.subject)} · ${escapeHtml(session.status)} · Expires ${escapeHtml(new Date(session.expiresAt).toLocaleString())}</p>${session.status === 'Active' ? `<button class="secondary" id="close-recovered-session" data-session-id="${escapeHtml(session.id)}" type="button">Close Session and mark absences</button>` : ''}`;
}
$('refresh-qr-sessions').addEventListener('click', refreshQrRecoverySessions);
$('qr-recovery-sessions').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-qr-action]');
  if (!button) return;
  const { qrAction, sessionId } = button.dataset;
  button.disabled = true;
  try {
    if (qrAction === 'view') {
      await showOriginalQr(sessionId);
      return;
    }
    if (qrAction === 'recover') {
      const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/recover`, { method: 'POST' });
      await refreshQrRecoverySessions();
      await showOriginalQr(sessionId);
      successMessage('qr-recovery-message', `QR session recovered. The original QR code is active for another ${result.durationMinutes} minutes.`);
      return;
    }
    if (qrAction === 'close') {
      const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/close`, { method: 'POST' });
      await refreshQrRecoverySessions();
      await refreshReport();
      successMessage('qr-recovery-message', `Session closed. ${result.added} absence/holiday records were finalized.`);
    }
  } catch (error) {
    button.disabled = false;
    message('qr-recovery-message', error.message);
  }
});
$('qr-result').addEventListener('click', async (event) => {
  const button = event.target.closest('#close-recovered-session');
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(button.dataset.sessionId)}/close`, { method: 'POST' });
    button.textContent = `Closed · ${result.added} absences added`;
    await refreshQrRecoverySessions();
    await refreshReport();
    successMessage('qr-recovery-message', `Session closed. ${result.added} absence/holiday records were finalized.`);
  } catch (error) {
    button.disabled = false;
    message('qr-recovery-message', error.message);
  }
});
$('session-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  message('session-message', 'Generating...');
  try {
    const session = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        subject: $('subject').value,
        batch: $('scope-batch').value,
        durationMinutes: Number($('qr-duration').value)
      })
    });
    $('qr-result').classList.remove('hidden');
    $('qr-result').innerHTML = `<img src="${session.qr}" alt="Attendance QR code"><p><a href="${escapeHtml(session.url)}" target="_blank" rel="noopener noreferrer">Open student page ↗</a></p><p class="muted">Phone scanning requires the phone to be on the same Wi-Fi network. For other networks, configure a public HTTPS APP_URL.</p><p id="qr-countdown" role="status" aria-live="polite"></p><button class="secondary" id="close-session" type="button">Close session and mark absences</button>`;
    successMessage('session-message', 'Attendance QR generated successfully.');
    await refreshQrRecoverySessions();
    const button = $('close-session');
    const countdown = $('qr-countdown');
    let countdownInterval;
    let finalizing = false;
    const finalizeSession = async (automatic = false) => {
      if (finalizing || button.disabled) return;
      finalizing = true;
      button.disabled = true;
      button.textContent = automatic ? 'QR expired · finalizing attendance...' : 'Finalizing...';
      try {
        const result = await api(`/api/sessions/${session.id}/close`, { method: 'POST' });
        clearInterval(countdownInterval);
        countdown.textContent = automatic ? 'QR expired; attendance session closed.' : 'Session closed before the QR expired.';
        button.textContent = `Closed · ${result.added} absences added`;
        const notifications = result.emailNotifications;
        successMessage('session-message', `Session closed successfully. ${result.added} absences added.`);
        if (notifications.failed || notifications.skipped) {
          message('session-message', `Absences finalized. Email notifications: ${notifications.sent} sent, ${notifications.failed} failed, ${notifications.skipped} skipped.`);
        }
        await refreshReport();
        await refreshQrRecoverySessions();
      } catch (error) {
        finalizing = false;
        button.disabled = false;
        button.textContent = automatic ? 'Retry finalizing attendance' : error.message;
        countdown.textContent = automatic
          ? `QR expired, but attendance finalization failed: ${error.message}`
          : '';
      }
    };
    button.addEventListener('click', () => {
      clearInterval(countdownInterval);
      finalizeSession();
    });
    const updateCountdown = () => {
      const remainingMs = Math.max(0, session.expiresAt - Date.now());
      if (remainingMs === 0) {
        clearInterval(countdownInterval);
        countdown.textContent = 'QR expired; finalizing attendance...';
        finalizeSession(true);
        return;
      }
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      const minutes = Math.floor(remainingSeconds / 60);
      const seconds = String(remainingSeconds % 60).padStart(2, '0');
      countdown.textContent = `QR expires in ${minutes}:${seconds}.`;
    };
    updateCountdown();
    countdownInterval = setInterval(updateCountdown, 1000);
  } catch (error) {
    message('session-message', error.message);
  }
});
function formatReportDate(date) {
  if (!date) return 'Unknown date';
  const safeDate = new Date(`${date}T00:00:00`);
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(safeDate);
}
function formatSectionLabel(batch) {
  if (!batch) return 'General';
  const prefix = batch.charAt(0).toUpperCase();
  const map = { P: 'P - Python', J: 'J - Java', D: 'D - Data Science' };
  return map[prefix] || `${prefix} - ${batch}`;
}
function buildDateGroupedRecords(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.date || 'Unknown date';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.entries()].sort(([a], [b]) => new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`));
}
function getServerDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }
function updateDashboardDate(date) {
  dashboardDate = date;
  $('dashboard-date').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'full' }).format(new Date(`${date}T00:00:00`));
}
async function refreshReport() { try { records = await api('/api/report'); const percentages = await api('/api/percentages'); const date = getServerDate(); updateDashboardDate(date); const today = records.filter((r) => r.date === date); const presentToday = today.filter((r) => r.status === 'Present').length; const absentToday = today.filter((r) => r.status === 'Absent').length; $('total-count').textContent = presentToday + absentToday; $('present-count').textContent = presentToday; $('absent-count').textContent = absentToday; const groupedRecords = buildDateGroupedRecords(records.slice().reverse()); $('records').innerHTML = groupedRecords.length ? groupedRecords.map(([day, dayRows]) => `
        <tr class="date-group-row"><td colspan="5"><div class="date-group-header">${escapeHtml(formatReportDate(day))}</div></td></tr>
        ${dayRows.map((r) => `<tr><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.batch)}</td><td>${escapeHtml(r.subject)}</td><td class="status ${r.status.toLowerCase()}">${escapeHtml(r.status)}</td></tr>`).join('')}
      `).join('') : '<tr><td colspan="5">No records yet.</td></tr>';
    const groupedPercentages = new Map();
    for (const row of percentages.filter((r) => r.total > 0)) {
      const label = formatSectionLabel(row.batch);
      if (!groupedPercentages.has(label)) groupedPercentages.set(label, []);
      groupedPercentages.get(label).push(row);
    }
    $('percentages').innerHTML = groupedPercentages.size ? [...groupedPercentages.entries()].map(([sectionLabel, sectionRows]) => `
        <tr class="section-group-row"><td colspan="7"><div class="section-group-header">${escapeHtml(sectionLabel)}</div></td></tr>
        ${sectionRows.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.batch)}</td><td>${escapeHtml(r.subject)}</td><td>${r.attended}</td><td>${r.total}</td><td class="status">${r.subjectPercentage}%</td><td class="status">${r.overallPercentage}%</td></tr>`).join('')}
      `).join('') : '<tr><td colspan="7">No conducted classes yet.</td></tr>'; } catch (error) { message('session-message', error.message); } }
$('open-records').addEventListener('click', async () => { show('records-view'); await refreshReport(); });
$('open-percentages').addEventListener('click', async () => { show('percentage-view'); await refreshReport(); });
async function openDeviceSecurity() {
  show('device-security-view');
  await refreshDeviceRegistry();
}
async function openAdminLogins() {
  show('admin-logins-view');
  await Promise.all([refreshAdmins(), refreshAdminAccountAudit()]);
}
$('open-device-security').addEventListener('click', openDeviceSecurity);
$('open-admin-logins').addEventListener('click', openAdminLogins);
$('refresh-devices').addEventListener('click', refreshDeviceRegistry);
$('refresh-admin-audit').addEventListener('click', refreshAdminAccountAudit);
document.querySelectorAll('.back-dashboard').forEach((button) => button.addEventListener('click', () => show('dashboard-view')));
$('refresh-records').addEventListener('click', refreshReport);
$('refresh-percentages').addEventListener('click', refreshReport);
$('correction-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  message('correction-message', 'Saving...');
  try {
    const date = $('correction-date').value;
    await api('/api/correct', {
      method: 'POST',
      body: JSON.stringify({
        name: $('correction-name').value,
        batch: $('correction-batch').value,
        subject: $('correction-subject').value,
        status: $('correction-status').value,
        date: date || undefined
      })
    });
    successMessage('correction-message', date ? `Correction saved for ${date}.` : "Today's correction saved.");
    await refreshReport();
  } catch (error) {
    message('correction-message', error.message);
  }
});
async function refreshAdmins() {
  try {
    const [admins, me] = await Promise.all([api('/api/admins'), api('/api/me')]);
    $('admin-accounts').innerHTML = admins.length ? admins.map((admin) => {
      const isMainAdmin = admin.role === 'MAIN_ADMIN';
      const canGiveAccess = admin.role === 'ADMIN' && !admin.removedAt
        && (admin.approvalStatus === 'pending' || (!admin.isVerified && !admin.isActive
          && (admin.subjects || []).length !== config.subjects.length));
      let actions = isMainAdmin
        ? '<span>Main Admin</span>'
        : admin.removedAt
          ? '<span>Removed</span>'
          : canGiveAccess
            ? `<button class="secondary admin-give-access-button" data-admin-id="${escapeHtml(admin.id)}" type="button">Give Access</button>`
          : `<button class="secondary admin-edit-button" data-admin-id="${escapeHtml(admin.id)}" data-name="${escapeHtml(admin.name)}" type="button">Edit</button>
            ${admin.isVerified ? `<button class="link-button admin-recovery-button" data-admin-id="${escapeHtml(admin.id)}" type="button">Recover password</button>
            <button class="secondary admin-status-button" data-admin-id="${escapeHtml(admin.id)}" data-active="${!admin.isActive}" type="button">${admin.isActive ? 'Deactivate' : 'Activate'}</button>` : admin.isActive
              ? `<button class="link-button admin-resend-button" data-email="${escapeHtml(admin.email)}" type="button">Resend invitation</button>`
              : `<button class="link-button admin-verify-resend-button" data-email="${escapeHtml(admin.email)}" type="button">Resend verification OTP</button>`}
            <button class="link-button admin-remove-button" data-admin-id="${escapeHtml(admin.id)}" type="button">Remove</button>`;
      if (admin.id === me.admin?.id) actions = '<span>Current account</span>';
      return `<tr><td>${escapeHtml(admin.id)}</td><td>${escapeHtml(admin.name || '—')}</td><td>${escapeHtml(admin.email)}</td><td>${escapeHtml(admin.phone || '—')}</td><td>${escapeHtml(admin.role)}</td><td>${escapeHtml(admin.status)}</td><td>${escapeHtml(admin.createdAt)}</td><td>${escapeHtml(admin.lastLogin || 'Never')}</td><td>${escapeHtml(admin.lastStatusChangeAt || 'Unknown')}</td><td>${actions}</td></tr>`;
    }).join('') : '<tr><td colspan="10">No admin accounts.</td></tr>';
    $('admin-invite-subjects').innerHTML = config.subjects.map((subject) => `
      <label class="subject-checkbox-option">
        <input type="checkbox" name="invite-subject" value="${escapeHtml(subject)}">
        <span>${escapeHtml(subject)}</span>
      </label>
    `).join('');
  } catch (error) {
    $('admin-accounts').innerHTML = '<tr><td colspan="10">Unable to load admin accounts.</td></tr>';
    message('admin-invite-message', error.message);
  }
}
async function refreshAdminAccountAudit() {
  try {
    const auditLog = await api('/api/admins/account-audit-log');
    $('admin-account-audit-log').innerHTML = auditLog.length ? auditLog.map((entry) => `
      <tr>
        <td>${escapeHtml(entry.timestamp)}</td>
        <td>${escapeHtml(entry.adminEmail)}</td>
        <td>${escapeHtml(entry.actingAdminRole || 'ADMIN')}</td>
        <td>${escapeHtml(entry.action)}</td>
        <td>${escapeHtml(entry.affectedRecord)}</td>
        <td>${escapeHtml(entry.reason)}</td>
        <td>${escapeHtml(entry.result || 'success')}</td>
      </tr>
    `).join('') : '<tr><td colspan="7">No admin login or access events recorded.</td></tr>';
  } catch (error) {
    $('admin-account-audit-log').innerHTML = '<tr><td colspan="7">Unable to load admin audit history.</td></tr>';
    message('admin-invite-message', error.message);
  }
}
async function refreshDeviceRegistry() {
  try {
    const [devices, auditLog] = await Promise.all([
      api('/api/admins/devices'),
      api('/api/admins/audit-log')
    ]);
    $('device-registry').innerHTML = devices.length ? devices.map((device) => `
      <tr>
        <td>${escapeHtml(device.studentName)}${device.studentId ? `<br><small>${escapeHtml(device.studentId)}</small>` : ''}</td>
        <td>${escapeHtml(device.batch)}</td>
        <td>${escapeHtml(device.status)}${device.unlockReason ? `<br><small>${escapeHtml(device.unlockReason)}</small>` : ''}</td>
        <td>${escapeHtml(device.registeredIp || 'Not available')}</td>
        <td>${escapeHtml(device.lastSeenAt)}</td>
        <td>${escapeHtml(device.lastAttendanceSubject || '—')}${device.lastAttendanceDate ? `<br>${escapeHtml(device.lastAttendanceDate)}` : ''}</td>
        <td>${device.status === 'active' ? `<button class="secondary device-unlock-button" data-device-id="${escapeHtml(device.id)}" type="button">Release device</button>` : '—'}</td>
      </tr>
    `).join('') : '<tr><td colspan="7">No registered devices.</td></tr>';
    $('admin-audit-log').innerHTML = auditLog.length ? auditLog.map((entry) => `
      <tr>
        <td>${escapeHtml(entry.timestamp)}</td>
        <td>${escapeHtml(entry.adminEmail)}</td>
        <td>${escapeHtml(entry.actingAdminRole || 'ADMIN')}</td>
        <td>${escapeHtml(entry.action)}</td>
        <td>${escapeHtml(entry.affectedRecord)}</td>
        <td>${escapeHtml(entry.reason)}</td>
        <td>${escapeHtml(entry.result || 'success')}</td>
      </tr>
    `).join('') : '<tr><td colspan="7">No administrative actions recorded.</td></tr>';
  } catch (error) {
    $('device-registry').innerHTML = '<tr><td colspan="7">Unable to load registered devices.</td></tr>';
    message('device-registry-message', error.message);
  }
}
$('device-registry').addEventListener('click', async (event) => {
  const button = event.target.closest('.device-unlock-button');
  if (!button) return;
  if (!window.confirm('Release this device registration? The student can register a replacement phone on their next check-in.')) return;
  const reason = window.prompt('Enter the reason for releasing this device registration:');
  if (reason === null) return;
  button.disabled = true;
  try {
    const result = await api(`/api/admins/devices/${encodeURIComponent(button.dataset.deviceId)}/unlock`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true, reason })
    });
    message('device-registry-message', result.registrySync === 'synced'
      ? 'Device registration released. The student can now check in using a replacement phone.'
      : 'Device registration was released and audited locally, but Google Sheets could not be updated.');
    await refreshDeviceRegistry();
  } catch (error) {
    message('device-registry-message', error.message);
    button.disabled = false;
  }
});
$('admin-invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('admin-invite-form').querySelector('button[type="submit"]');
  button.disabled = true;
  message('admin-invite-message', 'Granting access and sending login email...');
  try {
    const subjects = [...$('admin-invite-subjects').querySelectorAll('input[name="invite-subject"]:checked')].map((input) => input.value);
    if (!subjects.length) {
      message('admin-invite-message', 'Select at least one subject for this admin.');
      return;
    }
    const result = await api('/api/admins/invite', {
      method: 'POST',
      body: JSON.stringify({ name: $('admin-invite-name').value, email: $('admin-invite-email').value, subjects })
    });
    $('admin-invite-name').value = '';
    $('admin-invite-email').value = '';
    for (const input of $('admin-invite-subjects').querySelectorAll('input[name="invite-subject"]')) input.checked = false;
    successMessage('admin-invite-message', result.accountReportSync === 'failed'
      ? 'Invitation email with a temporary password and one-time code was sent, but Google Sheets account report could not be updated.'
      : 'Access granted. The new admin’s email contains a one-time code and temporary password; they must change the password after first sign-in.');
    await refreshAdmins();
    await refreshAdminAccountAudit();
  } catch (error) { message('admin-invite-message', error.message); }
  finally { button.disabled = false; }
});
$('summary-email-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('summary-email-form').querySelector('button[type="submit"]');
  button.disabled = true;
  message('summary-email-message', 'Preparing attendance summary...');
  try {
    await api('/api/attendance/email-summary', {
      method: 'POST',
      body: JSON.stringify({ name: $('summary-email-name').value, batch: $('summary-email-batch').value })
    });
    successMessage('summary-email-message', 'Attendance summary sent to the student email saved in the roster.');
  } catch (error) {
    message('summary-email-message', error.message);
  } finally {
    button.disabled = false;
  }
});
$('admin-accounts').addEventListener('click', async (event) => {
  const giveAccessButton = event.target.closest('.admin-give-access-button');
  const statusButton = event.target.closest('.admin-status-button');
  const verifyResendButton = event.target.closest('.admin-verify-resend-button');
  const resendButton = event.target.closest('.admin-resend-button');
  const editButton = event.target.closest('.admin-edit-button');
  const recoveryButton = event.target.closest('.admin-recovery-button');
  const removeButton = event.target.closest('.admin-remove-button');
  if (giveAccessButton) {
    if (!window.confirm('Give this admin access to all configured subjects? If their email is not verified, they must complete the OTP verification before signing in.')) return;
    giveAccessButton.disabled = true;
    message('admin-invite-message', 'Granting access...');
    try {
      const result = await api(`/api/admins/${encodeURIComponent(giveAccessButton.dataset.adminId)}/approval`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve' })
      });
      await refreshAdmins();
      await refreshAdminAccountAudit();
      const approvalMessage = result.requiresOtp
        ? result.otpDelivery === 'sent'
          ? 'Access approved for all subjects. A fresh email verification OTP has been sent; the admin must verify before signing in.'
          : result.otpDelivery === 'already-sent'
            ? 'Access approved for all subjects. The previously sent verification code is still valid; the admin must verify before signing in.'
          : `Access approved, but the verification OTP was not sent. ${result.otpDeliveryMessage || 'Use Resend verification OTP after checking the email service.'}`
        : 'Access granted for all configured subjects. The admin can now sign in.';
      if (!result.requiresOtp || ['sent', 'already-sent'].includes(result.otpDelivery)) {
        successMessage('admin-invite-message', approvalMessage);
      } else {
        message('admin-invite-message', approvalMessage);
      }
    } catch (error) {
      message('admin-invite-message', error.message);
      giveAccessButton.disabled = false;
    }
  } else if (verifyResendButton) {
    verifyResendButton.disabled = true;
    try {
      await api('/api/auth/resend-otp', {
        method: 'POST',
        body: JSON.stringify({ purpose: 'verify', email: verifyResendButton.dataset.email })
      });
      successMessage('admin-invite-message', 'A new email verification OTP was sent. Access remains unavailable until the admin verifies it.');
    } catch (error) {
      message('admin-invite-message', error.message);
    } finally {
      verifyResendButton.disabled = false;
    }
  } else if (statusButton) {
    statusButton.disabled = true;
    try {
      const active = statusButton.dataset.active === 'true';
      if (!window.confirm(`${active ? 'Activate' : 'Deactivate'} this admin account?`)) {
        statusButton.disabled = false;
        return;
      }
      const reason = window.prompt(`Reason for ${active ? 'activating' : 'deactivating'} this account:`);
      if (reason === null || reason.trim().length < 5) {
        statusButton.disabled = false;
        if (reason !== null) message('admin-invite-message', 'Enter a reason of at least 5 characters.');
        return;
      }
      const result = await api(`/api/admins/${encodeURIComponent(statusButton.dataset.adminId)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ active, confirm: true, reason })
      });
      successMessage('admin-invite-message', active ? 'Admin account activated successfully.' : 'Admin account deactivated successfully.');
      if (result.emailNotification === 'failed' || result.emailNotification === 'not-configured') {
        message('admin-invite-message', result.emailNotification === 'failed'
          ? 'Account status updated, but the status email could not be sent.'
          : 'Account status updated. Email service is not configured.');
      }
      if (result.adminReportSync === 'failed') {
        message('admin-invite-message', 'Account status was updated, but the Google Sheets admin report or audit log could not be updated.');
      }
      await refreshAdmins();
      await refreshAdminAccountAudit();
    } catch (error) { message('admin-invite-message', error.message); statusButton.disabled = false; }
  } else if (resendButton) {
    resendButton.disabled = true;
    try {
      await api('/api/auth/resend-otp', { method: 'POST', body: JSON.stringify({ purpose: 'invite', email: resendButton.dataset.email }) });
      successMessage('admin-invite-message', 'A new temporary password and one-time code were sent. The previous temporary password is no longer valid.');
    } catch (error) { message('admin-invite-message', error.message); }
    finally { resendButton.disabled = false; }
  } else if (editButton) {
    const name = window.prompt('Edit admin name:', editButton.dataset.name);
    if (name === null) return;
    const reason = window.prompt('Reason for editing this admin:');
    if (reason === null || reason.trim().length < 5) {
      if (reason !== null) message('admin-invite-message', 'Enter a reason of at least 5 characters.');
      return;
    }
    try {
      const result = await api(`/api/admins/${encodeURIComponent(editButton.dataset.adminId)}/details`, {
        method: 'PATCH',
        body: JSON.stringify({ name, reason })
      });
      await refreshAdmins();
      successMessage('admin-invite-message', result.adminReportSync === 'failed'
        ? 'Admin details updated, but the Google Sheets account report or audit log could not be updated.'
        : 'Admin details updated.');
    } catch (error) { message('admin-invite-message', error.message); }
  } else if (recoveryButton) {
    if (!window.confirm('Send a password recovery code to this admin’s registered email?')) return;
    try {
      const result = await api(`/api/admins/${encodeURIComponent(recoveryButton.dataset.adminId)}/recovery`, { method: 'POST', body: '{}' });
      await refreshAdminAccountAudit();
      successMessage('admin-invite-message', result.adminReportSync === 'failed'
        ? 'Password recovery code sent and recorded locally, but Google Sheets could not be updated.'
        : 'Password recovery code sent and audited.');
    } catch (error) { message('admin-invite-message', error.message); }
  } else if (removeButton) {
    if (!window.confirm('Remove this admin? This revokes access and removes their name, email, phone, password, and login history. Audit events will remain anonymized.')) return;
    const reason = window.prompt('Reason for removing this admin:');
    if (reason === null || reason.trim().length < 5) {
      if (reason !== null) message('admin-invite-message', 'Enter a reason of at least 5 characters.');
      return;
    }
    try {
      const result = await api(`/api/admins/${encodeURIComponent(removeButton.dataset.adminId)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true, reason })
      });
      await refreshAdmins();
      await refreshAdminAccountAudit();
      successMessage('admin-invite-message', result.adminReportSync === 'failed'
        ? 'Admin access removed and personal account details erased, but Google Sheets could not be updated.'
        : 'Admin access removed. Personal account details and login history were erased; anonymized audit history was retained.');
    } catch (error) { message('admin-invite-message', error.message); }
  }
});
async function initDashboard() {
  show('dashboard-view');
  $('logout').classList.remove('hidden');
  const me = await api('/api/me');
  const isMainAdmin = me.admin?.role === 'MAIN_ADMIN';
  $('open-admin-logins').classList.toggle('hidden', !isMainAdmin);
  const adminConfig = await api('/api/admin/config');
  fillSelect('subject', adminConfig.subjects);
  fillSelect('correction-subject', adminConfig.subjects);
  const tasks = [refreshReport(), refreshQrRecoverySessions()];
  await Promise.all(tasks);
}
setInterval(() => {
  if (!$('dashboard-view').classList.contains('hidden') && dashboardDate && getServerDate() !== dashboardDate) refreshReport();
}, 30000);
(async function boot() {
  await loadConfig();
  if (token) return initStudent();
  const [me, authStatus] = await Promise.all([api('/api/me'), api('/api/auth/status')]);
  if (me.instructor && me.admin?.mustChangePassword) {
    $('logout').classList.remove('hidden');
    showAuthForm('first-password-form');
    show('login-view');
    message('first-password-message', 'Change your temporary password before continuing.');
    return;
  }
  if (me.instructor) return initDashboard();
  bootstrapRequired = authStatus.firstAdminSetupRequired && !authStatus.pendingMainAdminVerification;
  bootstrapMode = authStatus.bootstrapMode;
  $('show-registration-link').classList.remove('hidden');
  if (bootstrapRequired && authStatus.bootstrapAvailable) $('show-registration-link').textContent = 'Set up Main Admin';
  else $('show-registration-link').textContent = 'New Admin? Register Here';
  show('login-view');
})().catch((error) => { show('login-view'); message('login-message', error.message); });
