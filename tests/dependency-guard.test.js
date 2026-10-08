import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generatePrivateKey } from 'viem/accounts';

// The decode-uri-component audit exception rests on the browser wallet-UI tree (wagmi,
// WalletConnect, query-string, decode-uri-component) never loading. This drives a real paid tool
// call, with signing, against a local fake lounge and fails if that tree loads.
const root = fileURLToPath(new URL('..', import.meta.url));
const tripwire = `--require ${path.join(root, 'tests/support/wallet-ui-tripwire.cjs')} --import ${pathToFileURL(path.join(root, 'tests/support/wallet-ui-tripwire.mjs')).href}`;

test('the paid path signs and pays without loading the wallet-UI tree', async t => {
  let paid = 0;
  const lounge = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (!req.url.startsWith('/api/play/walk')) return res.writeHead(404).end('{}');
    if (!req.headers['x-payment']) return res.writeHead(402).end(JSON.stringify({ x402Version: 1, error: 'X-PAYMENT header is required', accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '20000', resource: 'http://127.0.0.1/api/play/walk', description: 'test', mimeType: 'application/json', payTo: '0x000000000000000000000000000000000000dEaD', maxTimeoutSeconds: 60, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', extra: { name: 'USD Coin', version: '2' } }] }));
    paid++;
    assert.match(req.headers['x-lounge-retrieval-key'], /^[A-Za-z0-9_-]{32}$/);
    res.setHeader('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: true, transaction: '0x' + '2'.repeat(64), network: 'base' })).toString('base64'));
    res.end(JSON.stringify({ puzzleId: 'guard-test', prompt: 'F1', oneAttempt: true }));
  });
  lounge.listen(0, '127.0.0.1'); await once(lounge, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lounge-mcp-guard-'));
  t.after(async () => { lounge.closeAllConnections(); await new Promise(r => lounge.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const messages = [{ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'guard', version: '0' } } }, { method: 'notifications/initialized' }, { id: 2, method: 'tools/call', params: { name: 'lounge_play', arguments: { game: 'walk' } } }];
  const input = path.join(dir, 'in'), output = path.join(dir, 'out'), log = path.join(dir, 'tripwire.log');
  fs.writeFileSync(input, messages.map(m => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n');
  const fds = [fs.openSync(input, 'r'), fs.openSync(output, 'w'), 'ignore'];
  const child = spawn(process.execPath, ['index.js'], { cwd: root, stdio: fds, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_OPTIONS: tripwire, TRIPWIRE_FILE: log, PRIVATE_KEY: generatePrivateKey(), MAX_SPEND_USD: '1', LOUNGE_URL: `http://127.0.0.1:${lounge.address().port}`, LOUNGE_STATE_DIR: path.join(dir, 'state') } });
  fds.slice(0, 2).forEach(fd => fs.closeSync(fd));
  const until = Date.now() + 20000;
  while (!fs.readFileSync(output, 'utf8').includes('"id":2') && Date.now() < until && child.exitCode === null) await new Promise(r => setTimeout(r, 50));
  child.kill(); if (child.exitCode === null) await once(child, 'exit');
  const reply = fs.readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(m => m.id === 2);
  assert.equal(JSON.parse(reply.result.content[0].text).puzzleId, 'guard-test');
  assert.equal(paid, 1);
  assert.equal(fs.existsSync(log), false, fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
});

test('the tripwire detects a load, and no package source imports that tree', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lounge-mcp-tripwire-')), log = path.join(dir, 'tripwire.log');
  try {
    const run = spawn(process.execPath, ['--require', path.join(root, 'tests/support/wallet-ui-tripwire.cjs'), '-e', `require(${JSON.stringify(path.join(root, 'node_modules', 'query-string'))})`], { env: { PATH: process.env.PATH, TRIPWIRE_FILE: log }, stdio: 'ignore' });
    await once(run, 'exit');
    assert.match(fs.readFileSync(log, 'utf8'), /query-string/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  for (const file of ['index.js', 'budget.js', 'purchase-recovery.js'])
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /['"](x402\/paywall|wagmi|@wagmi\/[^'"]*|@walletconnect\/[^'"]*|query-string|decode-uri-component)['"]/, file);
});
