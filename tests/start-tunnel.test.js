import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import {
  ensurePortAvailable,
  findQuickTunnelUrl,
  resolveCloudflaredCommand
} from '../scripts/start-tunnel.js';

test('extracts the Cloudflare Quick Tunnel URL from startup output', () => {
  assert.equal(
    findQuickTunnelUrl('INF Your quick Tunnel has been created! Visit it at https://silver-fox.trycloudflare.com'),
    'https://silver-fox.trycloudflare.com'
  );
});

test('does not accept a non-Cloudflare host as a Quick Tunnel URL', () => {
  assert.equal(findQuickTunnelUrl('https://attendance.example.com'), null);
});

test('finds the standard winget install when cloudflared is missing from PATH', () => {
  assert.equal(
    resolveCloudflaredCommand({ 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }),
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
  );
});

test('falls back to the PATH command when cloudflared is not in standard install locations', () => {
  assert.equal(resolveCloudflaredCommand({}, () => false), 'cloudflared');
});

test('detects a port already occupied on all network interfaces', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const { port } = server.address();
  try {
    await assert.rejects(ensurePortAvailable(port), { code: 'EADDRINUSE' });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
