import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  legacySecuritySheetHeaders,
  readSecuritySheetSchema,
  securitySheetHeaders,
  syncSheetRowsById
} from '../admin-sheet-sync.js';

function createSheetsService(sheetValues) {
  const calls = [];
  const service = {
    spreadsheets: {
      values: {
        async get(request) {
          calls.push({ method: 'get', request });
          const title = request.range.match(/^'([^']+)'!/)[1];
          const values = sheetValues[title] || [];
          return {
            data: {
              values: request.range.includes('!A1:ZZ1')
                ? values.slice(0, 1)
                : values.slice(1)
            }
          };
        },
        async update(request) {
          calls.push({ method: 'update', request });
          return { data: {} };
        },
        async batchUpdate(request) {
          calls.push({ method: 'batchUpdate', request });
          return { data: {} };
        },
        async append(request) {
          calls.push({ method: 'append', request });
          return { data: {} };
        }
      }
    }
  };
  return { service, calls };
}

function adminFields(id, email, { name = 'Admin Name', lastStatusChangeAt = '', lastPasswordChangeAt = '' } = {}) {
  return {
    'Admin ID': id,
    'Admin Email': email,
    'Admin Role': 'ADMIN',
    'Account Status': 'Active',
    'Created At': '2026-01-01T00:00:00.000Z',
    'Last Login At': '',
    'Last Status Change At': lastStatusChangeAt,
    'Last Password Change At': lastPasswordChangeAt,
    'Failed Login Attempts': 0,
    'Last Successful Login': '',
    'Account Lock Status': 'Not locked',
    'Admin Name': name
  };
}

test('current Admin Accounts headers are recognized without being rewritten', async () => {
  const { service, calls } = createSheetsService({
    'Admin Accounts': [securitySheetHeaders['Admin Accounts']]
  });

  const schema = await readSecuritySheetSchema(service, 'test-sheet', 'Admin Accounts');
  const result = await syncSheetRowsById({
    service,
    spreadsheetId: 'test-sheet',
    title: 'Admin Accounts',
    schema,
    idHeader: 'Admin ID',
    records: [{ id: 'admin-1', email: 'admin@example.test' }],
    fieldsForRecord: (admin) => adminFields(admin.id, admin.email)
  });

  assert.equal(schema.supported, true);
  assert.equal(schema.legacy, false);
  assert.deepEqual(schema.headers, securitySheetHeaders['Admin Accounts']);
  assert.deepEqual(result, { updated: 0, appended: 1, skippedDuplicates: 0 });
  const append = calls.find((call) => call.method === 'append').request;
  assert.equal(append.range, "'Admin Accounts'!A:L");
  assert.equal(append.requestBody.values[0].length, securitySheetHeaders['Admin Accounts'].length);
  assert.equal(append.requestBody.values[0][11], 'Admin Name');
  assert.deepEqual(calls.filter((call) => call.method === 'update'), []);
});

test('previous current Admin Accounts headers remain supported', async () => {
  const previousHeaders = securitySheetHeaders['Admin Accounts'].slice(0, -1);
  const { service } = createSheetsService({ 'Admin Accounts': [previousHeaders] });
  const schema = await readSecuritySheetSchema(service, 'test-sheet', 'Admin Accounts');

  assert.equal(schema.supported, true);
  assert.equal(schema.legacy, false);
  assert.deepEqual(schema.headers, previousHeaders);
});

test('truncated current Admin Accounts headers sync their recognized fields safely', async () => {
  const truncatedHeaders = securitySheetHeaders['Admin Accounts'].slice(0, 10);
  const { service, calls } = createSheetsService({ 'Admin Accounts': [truncatedHeaders] });
  const schema = await readSecuritySheetSchema(service, 'test-sheet', 'Admin Accounts');
  const result = await syncSheetRowsById({
    service,
    spreadsheetId: 'test-sheet',
    title: 'Admin Accounts',
    schema,
    idHeader: 'Admin ID',
    records: [{ id: 'admin-1', email: 'admin@example.test' }],
    fieldsForRecord: (admin) => adminFields(admin.id, admin.email)
  });

  assert.equal(schema.supported, true);
  assert.deepEqual(result, { updated: 0, appended: 1, skippedDuplicates: 0 });
  const append = calls.find((call) => call.method === 'append').request;
  assert.equal(append.range, "'Admin Accounts'!A:J");
  assert.equal(append.requestBody.values[0].length, 10);
});

test('legacy Admin Accounts headers stay in place and sync fields by header name', async () => {
  const legacyHeaders = legacySecuritySheetHeaders['Admin Accounts'];
  const existing = ['admin-1', 'old@example.test', 'ADMIN', 'Active', 'created', 'login', 'password-changed', 0, '', 'Not locked'];
  const { service, calls } = createSheetsService({ 'Admin Accounts': [legacyHeaders, existing] });
  const schema = await readSecuritySheetSchema(service, 'test-sheet', 'Admin Accounts');
  assert.equal(schema.supported, true);
  assert.equal(schema.legacy, true);

  const result = await syncSheetRowsById({
    service,
    spreadsheetId: 'test-sheet',
    title: 'Admin Accounts',
    schema,
    idHeader: 'Admin ID',
    records: [
      { id: 'admin-1', email: 'updated@example.test' },
      { id: 'admin-2', email: 'new@example.test' }
    ],
    fieldsForRecord: (admin) => adminFields(admin.id, admin.email, {
      lastStatusChangeAt: 'status-change-not-in-legacy-schema',
      lastPasswordChangeAt: admin.id === 'admin-1' ? 'updated-password-change' : ''
    })
  });

  assert.deepEqual(result, { updated: 1, appended: 1, skippedDuplicates: 0 });
  assert.deepEqual(calls.filter((call) => call.method !== 'get').map((call) => call.method), ['batchUpdate', 'append']);
  const update = calls.find((call) => call.method === 'batchUpdate').request;
  assert.equal(update.requestBody.data[0].range, "'Admin Accounts'!A2:J2");
  assert.deepEqual(update.requestBody.data[0].values[0], [
    'admin-1', 'updated@example.test', 'ADMIN', 'Active', '2026-01-01T00:00:00.000Z',
    '', 'updated-password-change', 0, '', 'Not locked'
  ]);
  const append = calls.find((call) => call.method === 'append').request;
  assert.equal(append.range, "'Admin Accounts'!A:J");
  assert.equal(append.requestBody.values[0].length, legacyHeaders.length);
  assert.equal(append.requestBody.values[0][6], '');
  assert.equal(append.requestBody.values[0][9], 'Not locked');
});

test('unknown Admin Accounts headers are diagnosed without modifying or syncing the sheet', async () => {
  const { service, calls } = createSheetsService({
    'Admin Accounts': [
      ['Admin Email', 'Admin ID', 'Role', 'Status'],
      ['admin@example.test', 'admin-1', 'ADMIN', 'Active']
    ]
  });

  const schema = await readSecuritySheetSchema(service, 'test-sheet', 'Admin Accounts');
  assert.equal(schema.supported, false);
  assert.match(schema.reason, /differs from supported schemas at/);
  const result = await syncSheetRowsById({
    service,
    spreadsheetId: 'test-sheet',
    title: 'Admin Accounts',
    schema,
    idHeader: 'Admin ID',
    records: [{ id: 'admin-2', email: 'new@example.test' }],
    fieldsForRecord: (admin) => adminFields(admin.id, admin.email)
  });
  assert.equal(result.skipped, true);
  assert.deepEqual(calls.map((call) => call.method), ['get']);
});

test('10-column Admin Accounts mismatch at H identifies current and actual header safely', async () => {
  const actualHeaders = [...legacySecuritySheetHeaders['Admin Accounts']];
  actualHeaders[7] = 'Failed Attempts';
  const sensitiveRow = [
    'admin-id-that-must-not-be-logged',
    'private.person@example.test',
    'ADMIN',
    'Active',
    'private-record-data',
    'private-record-data',
    'private-record-data',
    'private-record-data',
    'private-record-data',
    'private-record-data'
  ];
  const { service, calls } = createSheetsService({ 'Admin Accounts': [actualHeaders, sensitiveRow] });

  assert.equal(securitySheetHeaders['Admin Accounts'][7], 'Last Password Change At');
  assert.equal(legacySecuritySheetHeaders['Admin Accounts'][7], 'Failed Login Attempts');

  const schema = await readSecuritySheetSchema(service, 'test-sheet', 'Admin Accounts');
  assert.equal(schema.supported, false);
  assert.match(
    schema.reason,
    /first mismatch at H: expected "Failed Login Attempts" \(legacy schema\), found "Failed Attempts"/
  );
  assert.doesNotMatch(schema.reason, /admin-id-that-must-not-be-logged|private\.person@example\.test|private-record-data/);

  const result = await syncSheetRowsById({
    service,
    spreadsheetId: 'test-sheet',
    title: 'Admin Accounts',
    schema,
    idHeader: 'Admin ID',
    records: [{ id: 'admin-new', email: 'new@example.test' }],
    fieldsForRecord: (admin) => adminFields(admin.id, admin.email)
  });
  assert.equal(result.skipped, true);
  assert.deepEqual(calls.map((call) => call.method), ['get']);
});

test('a blank header row with existing data is not initialized or overwritten', async () => {
  const { service, calls } = createSheetsService({
    'Admin Accounts': [[], ['unrecognized', 'existing data']]
  });

  const schema = await readSecuritySheetSchema(service, 'test-sheet', 'Admin Accounts');

  assert.equal(schema.supported, false);
  assert.match(schema.reason, /data exists but the header row is empty/);
  assert.deepEqual(calls.map((call) => call.method), ['get', 'get']);
});

test('duplicate existing admin IDs are not updated or appended again', async () => {
  const headers = securitySheetHeaders['Admin Accounts'];
  const row = ['admin-1', 'admin@example.test'];
  const { service, calls } = createSheetsService({
    'Admin Accounts': [headers, row, row]
  });
  const schema = await readSecuritySheetSchema(service, 'test-sheet', 'Admin Accounts');
  let duplicateCount = 0;
  const result = await syncSheetRowsById({
    service,
    spreadsheetId: 'test-sheet',
    title: 'Admin Accounts',
    schema,
    idHeader: 'Admin ID',
    records: [{ id: 'admin-1', email: 'admin@example.test' }],
    fieldsForRecord: (admin) => adminFields(admin.id, admin.email),
    onDuplicate: (count) => { duplicateCount = count; }
  });

  assert.equal(duplicateCount, 1);
  assert.deepEqual(result, { updated: 0, appended: 0, skippedDuplicates: 1 });
  assert.deepEqual(calls.map((call) => call.method), ['get', 'get']);
});

test('data outside the recognized headers is left untouched and synchronization is skipped', async () => {
  const headers = securitySheetHeaders['Admin Accounts'];
  const { service, calls } = createSheetsService({
    'Admin Accounts': [headers, ['admin-existing', 'admin@example.test', '', '', '', '', '', '', '', '', '', '', 'unmapped-data']]
  });
  const schema = await readSecuritySheetSchema(service, 'test-sheet', 'Admin Accounts');
  let skipReason = '';
  const result = await syncSheetRowsById({
    service,
    spreadsheetId: 'test-sheet',
    title: 'Admin Accounts',
    schema,
    idHeader: 'Admin ID',
    records: [{ id: 'admin-new', email: 'new@example.test' }],
    fieldsForRecord: (admin) => adminFields(admin.id, admin.email),
    onSkipped: (reason) => { skipReason = reason; }
  });

  assert.equal(result.skipped, true);
  assert.match(skipReason, /outside the recognized header columns/);
  assert.deepEqual(calls.map((call) => call.method), ['get', 'get']);
});

test('Admin Audit Log legacy schema is supported without moving existing fields', async () => {
  const title = 'Admin Audit Log';
  const { service, calls } = createSheetsService({
    [title]: [legacySecuritySheetHeaders[title], ['audit-1', 'timestamp', 'admin-1', 'admin@example.test']]
  });

  const schema = await readSecuritySheetSchema(service, 'test-sheet', title);

  assert.equal(schema.supported, true);
  assert.equal(schema.legacy, true);
  assert.deepEqual(calls.map((call) => call.method), ['get']);
});

test('Google Sheets read and write failures are returned to the caller', async () => {
  const readFailure = createSheetsService({});
  readFailure.service.spreadsheets.values.get = async () => { throw new Error('read failed'); };
  await assert.rejects(
    readSecuritySheetSchema(readFailure.service, 'test-sheet', 'Admin Accounts'),
    /read failed/
  );

  const { service } = createSheetsService({});
  const schema = { supported: true, headers: securitySheetHeaders['Admin Accounts'], rows: [] };
  service.spreadsheets.values.append = async () => { throw new Error('append failed'); };
  await assert.rejects(
    syncSheetRowsById({
      service,
      spreadsheetId: 'test-sheet',
      title: 'Admin Accounts',
      schema,
      idHeader: 'Admin ID',
      records: [{ id: 'admin-1', email: 'admin@example.test' }],
      fieldsForRecord: (admin) => adminFields(admin.id, admin.email)
    }),
    /append failed/
  );
});
