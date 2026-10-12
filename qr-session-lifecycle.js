export function recoverClosedSession(session, recoveredAt = Date.now(), recoveredBy = null) {
  if (!session || session.status !== 'closed' || !session.closedAt) {
    const error = new Error('Only a fully closed attendance session can be recovered.');
    error.code = 'SESSION_NOT_CLOSED';
    throw error;
  }
  if (session.finalizationPromise) {
    const error = new Error('The attendance session is still being finalized.');
    error.code = 'SESSION_FINALIZING';
    throw error;
  }
  if (!Number.isSafeInteger(session.durationMinutes) || session.durationMinutes < 1) {
    throw new Error('The attendance session has an invalid recovery duration.');
  }

  session.status = 'active';
  session.closedAt = null;
  session.closeResult = null;
  session.expiresAt = recoveredAt + session.durationMinutes * 60 * 1000;
  session.recoveryCount = (Number.isSafeInteger(session.recoveryCount) ? session.recoveryCount : 0) + 1;
  session.lastRecoveredAt = new Date(recoveredAt).toISOString();
  if (recoveredBy) session.recoveredBy = recoveredBy;
  return session;
}

export function mayReplaceClosedAbsence(session, attendanceDate, studentKey) {
  return session?.recoveryCount > 0
    && session.attendanceDate === attendanceDate
    && session.absentStudentKeys?.has(studentKey) === true;
}
