import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
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
} from '../device-registry.js';

function createDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-device-registry-'));
  const databasePath = path.join(directory, 'registry.sqlite');
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE admins (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, removed_at TEXT);
    INSERT INTO admins (id, name, email) VALUES ('admin-1', 'Test admin', 'admin@example.test');
  `);
  initializeDeviceRegistry(db);
  return {
    db,
    databasePath,
    cleanup() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

const studentA = { id: 'STU-000001', name: 'Student A', batch: 'P1', course: 'Python Full Stack' };
const studentB = { id: 'STU-000002', name: 'Student B', batch: 'P1', course: 'Python Full Stack' };
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('a device stays with one student across subjects, dates, and restarts', () => {
  const testDb = createDatabase();
  const firstHash = hash('phone-a');
  const first = bindDevice(testDb.db, {
    student: studentA,
    deviceHash: firstHash,
    ipAddress: '192.168.1.20',
    now: '2026-10-09T10:00:00.000Z'
  });
  assert.equal(first.allowed, true);
  assert.equal(first.newlyBound, true);
  assert.equal(recordDeviceAttendance(testDb.db, first.record.id, 'Python', '2026-10-09'), true);
  assert.equal(bindDevice(testDb.db, {
    student: studentA,
    deviceHash: firstHash,
    ipAddress: '2001:db8::20',
    now: '2026-10-10T10:00:00.000Z'
  }).allowed, true);
  assert.equal(checkDeviceOwner(testDb.db, studentB, firstHash).allowed, false);
  assert.equal(bindDevice(testDb.db, {
    student: studentA,
    deviceHash: hash('phone-b'),
    ipAddress: '192.168.1.21'
  }).allowed, false);
  testDb.db.close();

  const reopened = new Database(testDb.databasePath);
  const registry = listDeviceRegistry(reopened);
  assert.equal(registry.length, 1);
  assert.equal(registry[0].studentId, studentA.id);
  assert.equal(registry[0].registeredIp, '2001:db8::20');
  assert.equal(registry[0].lastAttendanceSubject, 'Python');
  assert.equal(registry[0].lastAttendanceDate, '2026-10-09');
  reopened.close();
  fs.rmSync(path.dirname(testDb.databasePath), { recursive: true, force: true });
});

test('concurrent device claims cannot bind a device to two students', async () => {
  const { db, cleanup } = createDatabase();
  try {
    const deviceHash = hash('shared-phone');
    const claims = await Promise.all([
      Promise.resolve().then(() => bindDevice(db, { student: studentA, deviceHash, ipAddress: '192.168.1.30' })),
      Promise.resolve().then(() => bindDevice(db, { student: studentB, deviceHash, ipAddress: '192.168.1.31' }))
    ]);
    assert.equal(claims.filter((claim) => claim.allowed).length, 1);
    assert.equal(listDeviceRegistry(db).filter((record) => record.status === 'active').length, 1);
  } finally {
    cleanup();
  }
});

test('legacy student locks migrate and continue blocking device switches', () => {
  const { db, cleanup } = createDatabase();
  try {
    const oldStudentKey = hash(`${studentA.name.toLowerCase()}|${studentA.batch}`);
    const deviceHash = hash('legacy-phone');
    assert.equal(importLegacyStudentLocks(db, {
      [oldStudentKey]: { deviceTokenHash: deviceHash, createdAt: 1_791_529_200_000 }
    }), 1);
    assert.equal(checkDeviceOwner(db, studentA, deviceHash).allowed, true);
    assert.equal(checkDeviceOwner(db, studentB, deviceHash).allowed, false);
    const binding = bindDevice(db, { student: studentA, deviceHash, ipAddress: '192.168.1.40' });
    assert.equal(binding.allowed, true);
    assert.equal(binding.newlyBound, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM legacy_student_device_locks').get().count, 0);
  } finally {
    cleanup();
  }
});

test('admin unlock is reasoned, re-registration is allowed, and unlock is auditable', () => {
  const { db, cleanup } = createDatabase();
  try {
    const binding = bindDevice(db, {
      student: studentA,
      deviceHash: hash('unlock-phone'),
      ipAddress: '192.168.1.50'
    });
    const unlocked = unlockDevice(db, {
      id: binding.record.id,
      adminId: 'admin-1',
      reason: 'Student received a replacement phone.',
      now: '2026-10-09T12:00:00.000Z'
    });
    assert.equal(unlocked.status, 'unlocked');
    assert.equal(db.prepare('SELECT registered_ip FROM device_registry WHERE id = ?').get(binding.record.id).registered_ip, '');
    assert.equal(listAdminAuditLog(db)[0].action, 'device_unlock');
    assert.equal(listAdminAuditLog(db)[0].reason, 'Student received a replacement phone.');
    assert.equal(bindDevice(db, {
      student: studentA,
      deviceHash: hash('replacement-phone'),
      ipAddress: '2001:db8::51'
    }).allowed, true);
    assert.equal(releaseNewDeviceBinding(db, binding.record.id), false);
  } finally {
    cleanup();
  }
});
