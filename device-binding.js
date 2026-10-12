export function bindDeviceToStudent(locks, studentKey, deviceTokenHash, createdAt = Date.now()) {
  const existing = locks.get(studentKey);
  if (existing) {
    return {
      allowed: existing.deviceTokenHash === deviceTokenHash,
      newlyBound: false
    };
  }

  locks.set(studentKey, { deviceTokenHash, createdAt });
  return { allowed: true, newlyBound: true };
}
