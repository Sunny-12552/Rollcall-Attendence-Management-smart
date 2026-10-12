export function calendarDatesBetween(startDate, endDate) {
  const dates = [];
  const current = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(current.getTime()) || Number.isNaN(end.getTime()) || current > end) return dates;

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export function newestFirstDates(dates) {
  return [...dates].sort((left, right) => right.localeCompare(left));
}

export function isHolidayDate(date, configuredHolidays = []) {
  if (configuredHolidays instanceof Set ? configuredHolidays.has(date) : configuredHolidays.includes(date)) return true;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.getUTCDay() === 0;
}

export function isCountedClassStatus(status) {
  return ['Present', 'Absent'].includes(String(status || '').trim());
}

export function statusForUnmarkedDate(statuses, isHoliday) {
  if (isHoliday) return 'Holiday';
  if (statuses.some(isCountedClassStatus)) return 'Absent';
  return '';
}
