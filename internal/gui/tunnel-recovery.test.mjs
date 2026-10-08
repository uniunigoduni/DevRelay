import assert from 'node:assert/strict';
import test from 'node:test';
import { isRestartableTunnel, isPermanentTunnelError, tunnelRetryDelayMs, newRecoveryState, recoverTunnel } from './tunnel-recovery.mjs';

test('only stable-URL tunnel types are restarted', () => {
  assert.equal(isRestartableTunnel({ kind: 'openai-secure-tunnel' }), true);
  assert.equal(isRestartableTunnel({ provider: 'tailscale' }), true);
  assert.equal(isRestartableTunnel({ provider: 'cloudflare', variant: 'named' }), true);
  assert.equal(isRestartableTunnel({ provider: 'cloudflare', variant: 'quick' }), false);
});
test('retry delays are bounded and configuration failures stop promptly', () => {
  assert.deepEqual([1,2,3,4,5,6,7].map(tunnelRetryDelayMs), [1000,2000,4000,8000,15000,30000,30000]);
  assert.equal(isPermanentTunnelError(new Error('invalid credentials')), true);
  assert.equal(isPermanentTunnelError(new Error('not signed in')), true);
  assert.equal(isPermanentTunnelError(new Error('cloudflared updated, exit code 11')), false);
});
test('reconnect succeeds after transient failures without restarting the MCP server', async () => {
  let clock = 0, attempts = 0;
  const events = [];
  const result = await recoverTunnel({
    start: async () => { if (++attempts < 3) throw Error('network temporarily unavailable'); return { pid: 123 }; },
    runtimeAlive: () => true, shouldStop: () => false,
    pause: async (delay) => { clock += delay; return true; }, now: () => clock,
    report: (name) => events.push(name)
  });
  assert.equal(result.tunnel.pid, 123);
  assert.equal(attempts, 3);
  assert.deepEqual(events, ['begin', 'retry', 'failure', 'retry', 'failure', 'retry', 'success']);
});
test('consecutive short-lived connections share recovery budget', async () => {
  let clock = 0;
  const attempts = [];
  const opts = {
    start: async (attempt) => { attempts.push(attempt); return { pid: attempt }; },
    runtimeAlive: () => true, shouldStop: () => false,
    pause: async (delay) => { clock += delay; return true; }, now: () => clock, report: () => {}
  };
  const first = await recoverTunnel(opts);
  clock += 100;
  const second = await recoverTunnel({ ...opts, previous: first.state, uptimeMs: 100 });
  assert.deepEqual(attempts, [1, 2]);
  const state = newRecoveryState(second.state, 60_000, clock);
  assert.equal(state.attempts, 0);
  assert.equal(state.startedAt, clock);
});
test('timeout, permanent error, and user stop do not loop indefinitely', async () => {
  let clock = 0;
  const opts = { start: async () => { throw Error('temporary offline'); }, runtimeAlive: () => true,
    shouldStop: () => false, pause: async (ms) => { clock += ms; return true; }, now: () => clock,
    report: () => {}, windowMs: 5000 };
  await assert.rejects(recoverTunnel(opts), /timed out/);
  await assert.rejects(recoverTunnel({ ...opts, start: async () => { throw Error('invalid credentials'); }, windowMs: 20000 }), /invalid credentials/);
  assert.equal(await recoverTunnel({ ...opts, shouldStop: () => true }), null);
});

test('Windows launcher parses without PowerShell syntax errors', { skip: process.platform !== 'win32' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/DevRelay-Launcher.ps1');
  const parse = '$tokens=$null;$errors=$null;$null=[System.Management.Automation.Language.Parser]::ParseFile($env:DEVRELAY_TEST_PS1,[ref]$tokens,[ref]$errors);if($errors.Count -gt 0){$errors | Out-String | Write-Error;exit 1}';
  execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(parse, 'utf16le').toString('base64')], {
    env: { ...process.env, DEVRELAY_TEST_PS1: script }, timeout: 15_000
  });
});
