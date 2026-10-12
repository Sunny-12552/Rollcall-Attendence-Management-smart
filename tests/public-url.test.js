import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePublicUrl } from '../public-url.js';

const networkInterfaces = {
  Ethernet: [
    { address: '192.168.1.42', family: 'IPv4', internal: false },
    { address: '127.0.0.1', family: 'IPv4', internal: true }
  ]
};

test('uses the machine LAN address when APP_URL is set to localhost', () => {
  assert.equal(
    resolvePublicUrl(undefined, { configuredUrl: 'http://localhost:3000', networkInterfaces }),
    'http://192.168.1.42:3000'
  );
});

test('prefers Wi-Fi over virtual adapters for local QR URLs', () => {
  assert.equal(
    resolvePublicUrl(undefined, {
      configuredUrl: 'http://localhost:3000',
      networkInterfaces: {
        Ethernet: [{ address: '192.168.56.1', family: 'IPv4', internal: false }],
        'ZeroTier One': [{ address: '10.24.173.207', family: 'IPv4', internal: false }],
        'Wi-Fi': [{ address: '192.168.1.8', family: 'IPv4', internal: false }]
      }
    }),
    'http://192.168.1.8:3000'
  );
});

test('preserves an explicitly configured public URL', () => {
  assert.equal(
    resolvePublicUrl(undefined, { configuredUrl: 'https://attendance.example.com/', networkInterfaces }),
    'https://attendance.example.com'
  );
});

test('replaces a loopback request host with the machine LAN address', () => {
  assert.equal(
    resolvePublicUrl({ headers: { host: '127.0.0.1:3000' } }, { networkInterfaces }),
    'http://192.168.1.42:3000'
  );
});

test('uses the public HTTPS host from a reverse proxy for QR URLs', () => {
  assert.equal(
    resolvePublicUrl({
      headers: {
        'x-forwarded-host': 'rollcall.example.com',
        'x-forwarded-proto': 'https',
        host: 'internal-service:3000'
      }
    }, { networkInterfaces }),
    'https://rollcall.example.com'
  );
});

test('uses a public proxy host for QR links when APP_URL is set to localhost', () => {
  assert.equal(
    resolvePublicUrl({
      headers: {
        'x-forwarded-host': 'strategic-remaining-wells-repair.trycloudflare.com',
        'x-forwarded-proto': 'https',
        host: 'localhost:3000'
      }
    }, { configuredUrl: 'http://localhost:3000', networkInterfaces }),
    'https://strategic-remaining-wells-repair.trycloudflare.com'
  );
});

test('rejects a local URL when no phone-accessible LAN address exists', () => {
  assert.throws(
    () => resolvePublicUrl(undefined, {
      configuredUrl: 'http://localhost:3000',
      networkInterfaces: { Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }
    }),
    /No LAN IPv4 address is available/
  );
});

test('rejects an invalid configured APP_URL instead of generating a broken QR', () => {
  assert.throws(
    () => resolvePublicUrl(undefined, { configuredUrl: 'not-a-url' }),
    /APP_URL must be a valid absolute URL/
  );
});

test('rejects non-web APP_URL schemes instead of generating an unscannable QR', () => {
  assert.throws(
    () => resolvePublicUrl(undefined, { configuredUrl: 'javascript:alert(1)' }),
    /APP_URL must use HTTP or HTTPS/
  );
});

test('rejects non-web forwarded protocols instead of generating an unscannable QR', () => {
  assert.throws(
    () => resolvePublicUrl({
      headers: { 'x-forwarded-host': 'rollcall.example.com', 'x-forwarded-proto': 'javascript' }
    }),
    /APP_URL must use HTTP or HTTPS/
  );
});
