import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mayReplaceClosedAbsence, recoverClosedSession } from '../qr-session-lifecycle.js';

test('recovers a closed QR session without changing its identity or attendance state', () => {
  const markedStudentKeys = new Set(['alex|P1']);
  const absentStudentKeys = new Set(['sam|P1']);
  const session = {
    id: 'original-session-id',
    url: 'http://attendance.example.test/?session=original-token',
    qr: 'original-qr-image',
    subject: 'Python',
    attendanceDate: '2026-10-12',
    status: 'closed',
    closedAt: 1000,
    closeResult: { added: 1 },
    durationMinutes: 10,
    expiresAt: 500,
    recoveryCount: 0,
    markedStudentKeys,
    absentStudentKeys
  };

  const recovered = recoverClosedSession(session, 2000, 'recovering-admin-id');

  assert.equal(recovered, session);
  assert.equal(session.status, 'active');
  assert.equal(session.closedAt, null);
  assert.equal(session.closeResult, null);
  assert.equal(session.expiresAt, 602000);
  assert.equal(session.recoveryCount, 1);
  assert.equal(session.lastRecoveredAt, new Date(2000).toISOString());
  assert.equal(session.recoveredBy, 'recovering-admin-id');
  assert.equal(session.id, 'original-session-id');
  assert.equal(session.url, 'http://attendance.example.test/?session=original-token');
  assert.equal(session.qr, 'original-qr-image');
  assert.equal(session.markedStudentKeys, markedStudentKeys);
  assert.equal(session.absentStudentKeys, absentStudentKeys);
  assert.deepEqual([...session.markedStudentKeys], ['alex|P1']);
  assert.deepEqual([...session.absentStudentKeys], ['sam|P1']);
});

test('does not recover active or still-finalizing sessions', () => {
  assert.throws(
    () => recoverClosedSession({ status: 'active', closedAt: null, durationMinutes: 5 }),
    (error) => error.code === 'SESSION_NOT_CLOSED'
  );
  assert.throws(
    () => recoverClosedSession({
      status: 'closed',
      closedAt: 1000,
      finalizationPromise: Promise.resolve(),
      durationMinutes: 5
    }),
    (error) => error.code === 'SESSION_FINALIZING'
  );
});

test('rejects invalid recovery durations', () => {
  assert.throws(
    () => recoverClosedSession({ status: 'closed', closedAt: 1000, durationMinutes: 0 }),
    /invalid recovery duration/
  );
});

test('allows only unmarked students with a same-date recovery absence to replace absent status', () => {
  const session = {
    recoveryCount: 1,
    attendanceDate: '2026-10-12',
    absentStudentKeys: new Set(['not-yet-present|P1']),
    markedStudentKeys: new Set(['already-present|P1'])
  };

  assert.equal(mayReplaceClosedAbsence(session, '2026-10-12', 'not-yet-present|P1'), true);
  assert.equal(mayReplaceClosedAbsence(session, '2026-10-12', 'already-present|P1'), false);
  assert.equal(mayReplaceClosedAbsence(session, '2026-10-13', 'not-yet-present|P1'), false);
});
