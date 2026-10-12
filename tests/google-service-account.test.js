import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadGoogleServiceAccountCredentials } from '../google-service-account.js';

test('loads Google service-account credentials from JSON or a file path', (t) => {
  const credentials = { type: 'service_account', client_email: 'attendance@example.test' };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-service-account-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'service-account.json');
  fs.writeFileSync(filePath, JSON.stringify(credentials));

  assert.deepEqual(loadGoogleServiceAccountCredentials({ json: JSON.stringify(credentials) }), credentials);
  assert.deepEqual(loadGoogleServiceAccountCredentials({ filePath }), credentials);
  assert.deepEqual(loadGoogleServiceAccountCredentials({ json: filePath }), credentials,
    'a file path accidentally set in GOOGLE_SERVICE_ACCOUNT_JSON is read as a file');
  assert.equal(loadGoogleServiceAccountCredentials({ filePath: '', json: '' }), null);
});

test('reports invalid service-account JSON without exposing its contents', () => {
  assert.throws(
    () => loadGoogleServiceAccountCredentials({ json: '{"private_key":"do-not-leak"' }),
    (error) => error.message.includes('GOOGLE_SERVICE_ACCOUNT_JSON')
      && !error.message.includes('do-not-leak')
  );
});
