import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calendarDatesBetween,
  isHolidayDate,
  isCountedClassStatus,
  newestFirstDates,
  statusForUnmarkedDate
} from '../attendance-calendar.js';
import { bindDeviceToStudent } from '../device-binding.js';

test('calendar date range includes every date from start to end', () => {
  assert.deepEqual(calendarDatesBetween('2026-09-16', '2026-09-19'), [
    '2026-09-16',
    '2026-09-17',
    '2026-09-18',
    '2026-09-19'
  ]);
});

test('attendance sheet dates are ordered newest first', () => {
  assert.deepEqual(newestFirstDates(['2026-09-16', '2026-09-19', '2026-09-17']), [
    '2026-09-19',
    '2026-09-17',
    '2026-09-16'
  ]);
});

test('Sundays are holidays and configured holidays are preserved', () => {
  assert.equal(isHolidayDate('2026-10-11'), true);
  assert.equal(isHolidayDate('2026-10-12'), false);
  assert.equal(isHolidayDate('2026-10-12', new Set(['2026-10-12'])), true);
});

test('a student stays bound to the first marking device while that device can be reused', () => {
  const locks = new Map();
  assert.deepEqual(bindDeviceToStudent(locks, 'student-1', 'device-a', 1), {
    allowed: true,
    newlyBound: true
  });
  assert.deepEqual(bindDeviceToStudent(locks, 'student-1', 'device-a', 2), {
    allowed: true,
    newlyBound: false
  });
  assert.deepEqual(bindDeviceToStudent(locks, 'student-1', 'device-b', 3), {
    allowed: false,
    newlyBound: false
  });
});

test('unmarked dates remain blank unless there is an actual attendance mark', () => {
  assert.equal(isCountedClassStatus(''), false);
  assert.equal(isCountedClassStatus('Holiday'), false);
  assert.equal(isCountedClassStatus('Present'), true);
  assert.equal(isCountedClassStatus('Absent'), true);
  assert.equal(statusForUnmarkedDate(['', ''], false), '');
  assert.equal(statusForUnmarkedDate(['', ''], true), 'Holiday');
  assert.equal(statusForUnmarkedDate(['Present', ''], false), 'Absent');
  assert.equal(statusForUnmarkedDate(['Absent', 'Holiday'], false), 'Absent');
});
