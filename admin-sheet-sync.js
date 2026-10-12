export const securitySheetHeaders = {
  'Device Registry': [
    'Student ID', 'Student Name', 'Batch', 'Course', 'Device ID Hash',
    'Registered IP Address', 'First Registered At', 'Last Seen At', 'Device Status',
    'Last Attendance Subject', 'Last Attendance Date', 'Admin Unlock Timestamp', 'Unlock Reason'
  ],
  'Admin Accounts': [
    'Admin ID', 'Admin Email', 'Admin Role', 'Account Status', 'Created At',
    'Last Login At', 'Last Status Change At', 'Last Password Change At', 'Failed Login Attempts',
    'Last Successful Login', 'Account Lock Status', 'Admin Name'
  ],
  'Admin Audit Log': [
    'Audit ID', 'Timestamp', 'Admin ID', 'Admin Email', 'Action', 'Affected Record', 'Reason',
    'Acting Admin Role', 'Target Admin ID', 'Result'
  ]
};

export const legacySecuritySheetHeaders = {
  'Admin Accounts': [
    'Admin ID', 'Admin Email', 'Admin Role', 'Account Status', 'Created At',
    'Last Login At', 'Last Password Change At', 'Failed Login Attempts',
    'Last Successful Login', 'Account Lock Status'
  ],
  'Admin Audit Log': [
    'Audit ID', 'Timestamp', 'Admin ID', 'Admin Email', 'Action', 'Affected Record', 'Reason'
  ]
};

const sheetSyncQueues = new Map();

export function columnName(index) {
  let value = '';
  let current = index + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    value = String.fromCharCode(65 + remainder) + value;
    current = Math.floor((current - 1) / 26);
  }
  return value;
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function normalizedHeaders(row = []) {
  return row.map((value) => String(value ?? '').trim());
}

function sameHeaders(actual, expected) {
  return actual.length === expected.length
    && expected.every((header, index) => actual[index] === header);
}

function mismatchColumns(actual, expectedSchemas) {
  const closest = expectedSchemas
    .map((headers) => ({
      headers,
      differenceCount: Array.from(
        { length: Math.max(actual.length, headers.length) },
        (_, index) => actual[index] === headers[index] ? 0 : 1
      ).reduce((total, mismatch) => total + mismatch, 0)
    }))
    .sort((left, right) => left.differenceCount - right.differenceCount)[0];
  if (!closest) return { columns: [], firstMismatch: null };
  const mismatchedIndexes = Array.from({ length: Math.max(actual.length, closest.headers.length) }, (_, index) => index)
    .filter((index) => actual[index] !== closest.headers[index]);
  const firstMismatchIndex = mismatchedIndexes[0];
  return {
    columns: mismatchedIndexes.map(columnName),
    firstMismatch: firstMismatchIndex === undefined
      ? null
      : {
        column: columnName(firstMismatchIndex),
        expected: closest.headers[firstMismatchIndex],
        actual: actual[firstMismatchIndex],
        schema: closest.headers
      }
  };
}

function safeHeaderDiagnostic(value) {
  if (value === undefined) return '<missing>';
  const header = String(value).trim();
  if (!header) return '<blank>';
  if (
    header.length > 80
    || /@|\b\d{7,}\b|(?:bearer|token|secret|password|key)\s*[:=]/i.test(header)
  ) return '<redacted>';
  return JSON.stringify(header);
}

export async function readSecuritySheetSchema(service, spreadsheetId, title) {
  const currentHeaders = securitySheetHeaders[title];
  if (!currentHeaders) throw new Error(`No configured security-sheet schema for "${title}".`);
  const response = await service.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title}'!A1:ZZ1`
  });
  const headerRow = normalizedHeaders(response.data.values?.[0]);
  while (headerRow.length && !headerRow.at(-1)) headerRow.pop();
  if (!headerRow.length) {
    const body = await service.spreadsheets.values.get({
      spreadsheetId,
      range: `'${title}'!A2:ZZ10000`
    });
    if ((body.data.values || []).some((row) => row.some(hasValue))) {
      return { supported: false, reason: 'data exists but the header row is empty' };
    }
    await service.spreadsheets.values.update({
      spreadsheetId,
      range: `'${title}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [currentHeaders] }
    });
    return { supported: true, headers: currentHeaders, legacy: false, created: true };
  }

  const legacyHeaders = legacySecuritySheetHeaders[title];
  const previousAdminAccountsHeaders = title === 'Admin Accounts'
    ? currentHeaders.slice(0, -1)
    : null;
  const truncatedAdminAccountsHeaders = previousAdminAccountsHeaders?.slice(0, 10);
  const supportedHeaders = [
    currentHeaders,
    ...(legacyHeaders ? [legacyHeaders] : []),
    ...(previousAdminAccountsHeaders ? [previousAdminAccountsHeaders, truncatedAdminAccountsHeaders] : [])
  ];
  const matchedHeaders = supportedHeaders.find((candidate) => sameHeaders(headerRow, candidate));
  if (!matchedHeaders) {
    const { columns, firstMismatch } = mismatchColumns(headerRow, supportedHeaders);
    const schemaLabel = firstMismatch
      ? (firstMismatch.schema === currentHeaders ? 'current' : 'legacy')
      : 'supported';
    const mismatchDiagnostic = firstMismatch
      ? `; first mismatch at ${firstMismatch.column}: expected ${safeHeaderDiagnostic(firstMismatch.expected)} (${schemaLabel} schema), found ${safeHeaderDiagnostic(firstMismatch.actual)}`
      : '';
    return {
      supported: false,
      reason: `header row has ${headerRow.length} populated columns; it differs from supported schemas at ${columns.join(', ') || 'unknown columns'}${mismatchDiagnostic}`
    };
  }
  return {
    supported: true,
    headers: matchedHeaders,
    legacy: legacyHeaders === matchedHeaders
  };
}

export async function syncSheetRowsById(options) {
  const key = `${options.spreadsheetId}:${options.title}`;
  const previous = sheetSyncQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  sheetSyncQueues.set(key, current);
  await previous;
  try {
    return await syncSheetRowsByIdNow(options);
  } finally {
    release();
    if (sheetSyncQueues.get(key) === current) sheetSyncQueues.delete(key);
  }
}

async function syncSheetRowsByIdNow({
  service,
  spreadsheetId,
  title,
  schema,
  idHeader,
  records,
  fieldsForRecord,
  onDuplicate = () => {},
  onSkipped = () => {}
}) {
  if (!schema?.supported) return { skipped: true, reason: schema?.reason || 'unsupported sheet schema' };
  const idColumn = schema.headers.indexOf(idHeader);
  if (idColumn < 0) return { skipped: true, reason: `recognized schema is missing key column "${idHeader}"` };

  const response = await service.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title}'!A2:ZZ10000`
  });
  const existingRows = response.data.values || [];
  if (existingRows.some((row) => row.slice(schema.headers.length).some(hasValue))) {
    const result = { skipped: true, reason: 'data exists outside the recognized header columns' };
    onSkipped(result.reason);
    return result;
  }

  const existingById = new Map();
  const duplicateIds = new Set();
  for (const [index, row] of existingRows.entries()) {
    const id = String(row[idColumn] ?? '');
    if (!id) continue;
    if (existingById.has(id)) duplicateIds.add(id);
    else existingById.set(id, { row, sheetRow: index + 2 });
  }
  if (duplicateIds.size) onDuplicate(duplicateIds.size);

  const updates = [];
  const newRows = [];
  const seenRecordIds = new Set();
  const endColumn = columnName(schema.headers.length - 1);
  for (const record of records) {
    const fieldValues = fieldsForRecord(record);
    const id = String(fieldValues[idHeader] ?? '');
    if (!id || seenRecordIds.has(id)) continue;
    seenRecordIds.add(id);
    if (duplicateIds.has(id)) continue;
    const row = schema.headers.map((header) => fieldValues[header] ?? '');
    const existing = existingById.get(id);
    if (!existing) {
      newRows.push(row);
    } else if (row.some((value, index) => String(existing.row[index] ?? '') !== String(value ?? ''))) {
      updates.push({
        range: `'${title}'!A${existing.sheetRow}:${endColumn}${existing.sheetRow}`,
        values: [row]
      });
    }
  }

  if (updates.length) {
    await service.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: updates }
    });
  }
  if (newRows.length) {
    await service.spreadsheets.values.append({
      spreadsheetId,
      range: `'${title}'!A:${endColumn}`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: newRows }
    });
  }
  return { updated: updates.length, appended: newRows.length, skippedDuplicates: duplicateIds.size };
}
