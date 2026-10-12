import crypto from 'node:crypto';

const deviceUsedByAnotherStudent = 'This device is registered to another student and cannot be used to mark attendance for this account. Please contact your instructor.';
const studentNeedsRecovery = 'This device needs verification before attendance can be marked. Please contact your instructor.';

export function initializeDeviceRegistry(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_registry (
      id TEXT PRIMARY KEY,
      device_hash TEXT NOT NULL,
      student_key TEXT NOT NULL,
      student_id TEXT,
      student_name TEXT NOT NULL,
      batch TEXT NOT NULL,
      course TEXT NOT NULL,
      registered_ip TEXT NOT NULL DEFAULT '',
      first_registered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unlocked')),
      last_attendance_subject TEXT NOT NULL DEFAULT '',
      last_attendance_date TEXT NOT NULL DEFAULT '',
      admin_unlock_timestamp TEXT,
      unlock_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS device_registry_active_device_idx
      ON device_registry(device_hash) WHERE status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS device_registry_active_student_idx
      ON device_registry(student_key) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS device_registry_seen_idx ON device_registry(last_seen_at);
    CREATE TABLE IF NOT EXISTS legacy_student_device_locks (
      student_key TEXT PRIMARY KEY,
      device_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      admin_id TEXT NOT NULL REFERENCES admins(id),
      acting_admin_role TEXT NOT NULL DEFAULT 'ADMIN',
      target_admin_id TEXT,
      action TEXT NOT NULL,
      affected_record TEXT NOT NULL,
      reason TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT 'success'
    );
    CREATE INDEX IF NOT EXISTS admin_audit_timestamp_idx ON admin_audit_log(timestamp);
  `);
}

export function importLegacyStudentLocks(db, locks) {
  if (!locks || typeof locks !== 'object') return 0;
  const importLock = db.prepare(`
    INSERT OR IGNORE INTO legacy_student_device_locks (student_key, device_hash, created_at)
    VALUES (?, ?, ?)
  `);
  const transaction = db.transaction((entries) => {
    let imported = 0;
    for (const [studentKey, value] of entries) {
      if (!/^[a-f0-9]{64}$/.test(studentKey) || !/^[a-f0-9]{64}$/.test(value?.deviceTokenHash || '')) continue;
      const result = importLock.run(studentKey, value.deviceTokenHash, new Date(value.createdAt || Date.now()).toISOString());
      imported += result.changes;
    }
    return imported;
  });
  return transaction(Object.entries(locks));
}

export function studentIdentityKey(student) {
  const identity = student.id
    ? `id:${String(student.id).trim().toLowerCase()}`
    : `name:${String(student.name || '').trim().toLowerCase()}|${String(student.batch || '').trim()}`;
  return crypto.createHash('sha256')
    .update(identity)
    .digest('hex');
}

function legacyStudentIdentityKey(student) {
  return crypto.createHash('sha256')
    .update(`${String(student.name || '').trim().toLowerCase()}|${String(student.batch || '').trim()}`)
    .digest('hex');
}

export function checkDeviceOwner(db, student, deviceHash) {
  const normalizedName = String(student.name || '').trim().toLowerCase();
  const batch = String(student.batch || '').trim();
  const existingDevice = db.prepare(`
    SELECT student_name AS studentName, batch FROM device_registry
    WHERE device_hash = ? AND status = 'active'
  `).get(deviceHash);
  if (existingDevice && (
    existingDevice.studentName.trim().toLowerCase() !== normalizedName
    || existingDevice.batch !== batch
  )) {
    return { allowed: false, reason: deviceUsedByAnotherStudent };
  }
  const legacyDevice = db.prepare(`
    SELECT student_key FROM legacy_student_device_locks WHERE device_hash = ?
  `).get(deviceHash);
  if (legacyDevice && legacyDevice.student_key !== legacyStudentIdentityKey(student)) {
    return { allowed: false, reason: deviceUsedByAnotherStudent };
  }
  return { allowed: true };
}

export function bindDevice(db, { student, deviceHash, ipAddress, now = new Date().toISOString() }) {
  if (!student?.name || !student?.batch || !/^[a-f0-9]{64}$/.test(deviceHash)) {
    throw new Error('A trusted student record and valid device identifier are required.');
  }
  const studentKey = studentIdentityKey(student);
  const legacyStudentKey = legacyStudentIdentityKey(student);
  const transaction = db.transaction(() => {
    const existingDevice = db.prepare(`
      SELECT * FROM device_registry WHERE device_hash = ? AND status = 'active'
    `).get(deviceHash);
    if (existingDevice && existingDevice.student_key !== studentKey) {
      return { allowed: false, reason: deviceUsedByAnotherStudent };
    }
    const legacyDevice = db.prepare(`
      SELECT * FROM legacy_student_device_locks WHERE device_hash = ?
    `).get(deviceHash);
    if (legacyDevice && legacyDevice.student_key !== legacyStudentKey) {
      return { allowed: false, reason: deviceUsedByAnotherStudent };
    }
    const existingStudent = db.prepare(`
      SELECT * FROM device_registry WHERE student_key = ? AND status = 'active'
    `).get(studentKey);
    if (existingStudent && existingStudent.device_hash !== deviceHash) {
      return { allowed: false, reason: studentNeedsRecovery };
    }
    const legacyStudent = db.prepare(`
      SELECT * FROM legacy_student_device_locks WHERE student_key = ?
    `).get(legacyStudentKey);
    if (legacyStudent && legacyStudent.device_hash !== deviceHash) {
      return { allowed: false, reason: studentNeedsRecovery };
    }

    if (!existingDevice) {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO device_registry
          (id, device_hash, student_key, student_id, student_name, batch, course,
           registered_ip, first_registered_at, last_seen_at, status,
           last_attendance_subject, last_attendance_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '', '')
      `).run(id, deviceHash, studentKey, String(student.id || ''), student.name, student.batch,
        student.course, ipAddress, now, now);
    } else {
      db.prepare(`
        UPDATE device_registry
        SET student_id = ?, student_name = ?, batch = ?, course = ?,
            registered_ip = ?, last_seen_at = ?
        WHERE id = ? AND status = 'active'
      `).run(String(student.id || ''), student.name, student.batch, student.course, ipAddress, now, existingDevice.id);
    }
    if (legacyStudent) {
      db.prepare('DELETE FROM legacy_student_device_locks WHERE student_key = ?').run(legacyStudentKey);
    }
    const record = db.prepare(`
      SELECT * FROM device_registry WHERE device_hash = ? AND status = 'active'
    `).get(deviceHash);
    return { allowed: true, newlyBound: !existingDevice, record };
  });
  try {
    return transaction();
  } catch (error) {
    if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE' && error.code !== 'SQLITE_BUSY') throw error;
    const deviceOwner = checkDeviceOwner(db, student, deviceHash);
    if (!deviceOwner.allowed) return deviceOwner;
    const activeStudent = db.prepare(`
      SELECT * FROM device_registry WHERE student_key = ? AND status = 'active'
    `).get(studentKey);
    if (activeStudent && activeStudent.device_hash !== deviceHash) {
      return { allowed: false, reason: studentNeedsRecovery };
    }
    const activeDevice = db.prepare(`
      SELECT * FROM device_registry WHERE device_hash = ? AND status = 'active'
    `).get(deviceHash);
    if (activeStudent && activeDevice?.id === activeStudent.id) {
      return { allowed: true, newlyBound: false, record: activeDevice };
    }
    throw error;
  }
}

export function recordDeviceAttendance(db, id, subject, date, lastSeenAt = new Date().toISOString()) {
  return db.prepare(`
    UPDATE device_registry
    SET last_attendance_subject = ?, last_attendance_date = ?, last_seen_at = ?
    WHERE id = ? AND status = 'active'
  `).run(subject, date, lastSeenAt, id).changes === 1;
}

export function releaseNewDeviceBinding(db, id) {
  return db.prepare("DELETE FROM device_registry WHERE id = ? AND status = 'active'").run(id).changes === 1;
}

export function listDeviceRegistry(db) {
  return db.prepare(`
    SELECT * FROM (
    SELECT id, device_hash AS deviceHash, student_id AS studentId,
      student_name AS studentName, batch, course,
      registered_ip AS registeredIp, first_registered_at AS firstRegisteredAt,
      last_seen_at AS lastSeenAt, status,
      last_attendance_subject AS lastAttendanceSubject,
      last_attendance_date AS lastAttendanceDate,
      admin_unlock_timestamp AS adminUnlockTimestamp, unlock_reason AS unlockReason
    FROM device_registry
    UNION ALL
    SELECT 'legacy-' || device_hash AS id, device_hash AS deviceHash, '' AS studentId,
      'Legacy device lock (student must check in to migrate)' AS studentName,
      '' AS batch, '' AS course, '' AS registeredIp, created_at AS firstRegisteredAt,
      created_at AS lastSeenAt, 'active' AS status, '' AS lastAttendanceSubject,
      '' AS lastAttendanceDate, NULL AS adminUnlockTimestamp, '' AS unlockReason
    FROM legacy_student_device_locks
    )
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, lastSeenAt DESC
  `).all();
}

export function unlockDevice(db, { id, adminId, actingAdminRole = 'ADMIN', reason, now = new Date().toISOString() }) {
  const transaction = db.transaction(() => {
    if (id.startsWith('legacy-')) {
      const deviceHash = id.slice('legacy-'.length);
      const legacy = db.prepare('SELECT * FROM legacy_student_device_locks WHERE device_hash = ?').get(deviceHash);
      if (!legacy) return null;
      db.prepare('DELETE FROM legacy_student_device_locks WHERE device_hash = ?').run(deviceHash);
      db.prepare(`
        INSERT INTO admin_audit_log
          (id, timestamp, admin_id, acting_admin_role, action, affected_record, reason)
        VALUES (?, ?, ?, ?, 'legacy_device_unlock', ?, ?)
      `).run(crypto.randomUUID(), now, adminId, actingAdminRole, id, reason);
      return { id, status: 'unlocked', adminUnlockTimestamp: now, unlockReason: reason };
    }
    const record = db.prepare("SELECT * FROM device_registry WHERE id = ? AND status = 'active'").get(id);
    if (!record) return null;
    const updated = db.prepare(`
      UPDATE device_registry
      SET status = 'unlocked', registered_ip = '',
        admin_unlock_timestamp = ?, unlock_reason = ?
      WHERE id = ? AND status = 'active'
    `).run(now, reason, id);
    if (updated.changes !== 1) return null;
    db.prepare(`
      INSERT INTO admin_audit_log
        (id, timestamp, admin_id, acting_admin_role, action, affected_record, reason)
      VALUES (?, ?, ?, ?, 'device_unlock', ?, ?)
    `).run(crypto.randomUUID(), now, adminId, actingAdminRole, id, reason);
    return { ...record, status: 'unlocked', adminUnlockTimestamp: now, unlockReason: reason };
  });
  return transaction();
}

export function listAdminAuditLog(db, limit = 200, scope = 'all') {
  const scopeFilter = scope === 'devices'
    ? "AND log.action IN ('device_unlock', 'legacy_device_unlock')"
    : scope === 'accounts'
      ? "AND (substr(log.action, 1, 6) = 'admin_' OR substr(log.action, 1, 11) = 'main_admin_')"
      : '';
  return db.prepare(`
    SELECT log.id, log.timestamp, log.admin_id AS adminId,
      CASE WHEN admins.name = 'Removed admin' THEN 'Removed admin' ELSE admins.email END AS adminEmail,
      log.acting_admin_role AS actingAdminRole, log.target_admin_id AS targetAdminId,
      log.action, log.affected_record AS affectedRecord, log.reason, log.result
    FROM admin_audit_log AS log JOIN admins ON admins.id = log.admin_id
    WHERE 1 = 1 ${scopeFilter}
    ORDER BY log.timestamp DESC LIMIT ?
  `).all(Math.min(Math.max(Number(limit) || 200, 1), 10000));
}
