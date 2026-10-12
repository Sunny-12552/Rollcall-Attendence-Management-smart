import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function findQuickTunnelUrl(output) {
  return String(output).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0] || null;
}

export function resolveCloudflaredCommand(env = process.env, exists = fs.existsSync) {
  const candidates = [
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'cloudflared', 'cloudflared.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'cloudflared', 'cloudflared.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe')
  ].filter(Boolean);
  return candidates.find((candidate) => exists(candidate)) || 'cloudflared';
}

export async function ensurePortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => server.close(resolve));
  });
}

async function startTunnel() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a whole number between 1 and 65535.');
  }
  try {
    await ensurePortAvailable(port);
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      throw new Error(`Port ${port} is already in use. Stop the running attendance app with Ctrl+C in its original terminal, then run npm run start:tunnel here. The app must restart with the tunnel URL so its QR codes use the public HTTPS address.`);
    }
    else throw error;
  }

  let cloudflared;
  let serverProcess = null;
  let tunnelUrl = null;
  let shuttingDown = false;
  const outputBuffers = { stdout: '', stderr: '' };
  let startupTimer;

  const stop = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(startupTimer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.exitCode = exitCode;
    if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
    if (cloudflared && cloudflared.exitCode === null) cloudflared.kill();
  };
  const onSignal = () => stop(0);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const launchServer = (url) => {
    if (serverProcess || shuttingDown) return;
    tunnelUrl = url;
    console.log(`\nStudent QR links will use: ${tunnelUrl}`);
    console.log('Starting attendance server. Keep this window open while students are checking in.\n');
    serverProcess = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, APP_URL: tunnelUrl },
      stdio: 'inherit'
    });
    serverProcess.once('error', (error) => {
      console.error('Unable to start the attendance server:', error.message);
      stop(1);
    });
    serverProcess.once('exit', (code) => {
      if (!shuttingDown) stop(code || 0);
    });
  };

  try {
    await new Promise((resolve, reject) => {
      cloudflared = spawn(resolveCloudflaredCommand(), [
        'tunnel',
        '--url',
        `http://127.0.0.1:${port}`,
        '--no-autoupdate'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      for (const streamName of ['stdout', 'stderr']) {
        cloudflared[streamName].on('data', (chunk) => {
          process[streamName].write(chunk);
          if (tunnelUrl) return;
          outputBuffers[streamName] = (outputBuffers[streamName] + chunk.toString()).slice(-2048);
          const url = findQuickTunnelUrl(outputBuffers[streamName]);
          if (url) {
            clearTimeout(startupTimer);
            launchServer(url);
            resolve();
          }
        });
      }

      cloudflared.once('error', (error) => {
        if (error.code === 'ENOENT' && resolveCloudflaredCommand() === 'cloudflared') {
          reject(new Error('cloudflared was not found in PATH or the standard Windows install locations. Open a new terminal after installing it, or add its install folder to PATH.'));
        } else {
          reject(new Error(`Unable to start cloudflared: ${error.message}`));
        }
      });
      cloudflared.once('exit', (code) => {
        if (!tunnelUrl && !shuttingDown) {
          reject(new Error(`cloudflared exited before creating a public URL (exit code ${code ?? 'unknown'}).`));
        } else if (tunnelUrl && !shuttingDown) {
          stop(code || 1);
        }
      });
      startupTimer = setTimeout(() => {
        reject(new Error('Timed out waiting for Cloudflare to provide a public URL.'));
        stop(1);
      }, 60000);
    });
  } catch (error) {
    stop(1);
    throw error;
  }

}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  startTunnel().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
