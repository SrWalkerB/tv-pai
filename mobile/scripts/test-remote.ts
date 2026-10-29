// Testa o cliente da API de controle remoto contra a TV, com o token do PIN.
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { FireTvRemote, type HttpRequest } from '../src/tv/remoteApi';

// Mesmo contrato do módulo nativo: confere o pin e devolve a impressão digital vista.
const request: HttpRequest = (method, url, headers, body, timeoutMs, pin) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const payload = body ?? '';
  const allHeaders = method === 'GET' ? headers : { ...headers, 'Content-Length': String(Buffer.byteLength(payload)) };
  const req = mod.request(u, { method, headers: allHeaders, timeout: timeoutMs, rejectUnauthorized: false, agent: false }, (res) => {
    const cert = (res.socket as TLSSocket).getPeerCertificate?.();
    const fingerprint = cert?.raw ? crypto.createHash('sha256').update(cert.raw).digest('hex') : null;
    if (pin && fingerprint && fingerprint !== pin) { req.destroy(); reject(new Error('pin diferente')); return; }
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, fingerprint }));
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('timeout')));
  if (body) req.write(body);
  req.end();
});

(async () => {
  const token = fs.readFileSync(process.argv[2], 'utf8').trim();
  const tv = new FireTvRemote('192.168.0.101', request, token);
  console.log('status:', await tv.status());
  const apps = await tv.apps();
  console.log('apps:', apps.length, apps.slice(0, 4).map((a) => a.label).join(', '));
  let t = Date.now(); await tv.press('right'); console.log('right', Date.now() - t, 'ms');
  t = Date.now(); await tv.press('left'); console.log('left', Date.now() - t, 'ms');
  console.log('pin fixado:', tv.pin?.slice(0, 16) + '…');
  const pinned = new FireTvRemote('192.168.0.101', request, token, tv.pin);
  console.log('com pin certo:', (await pinned.status()).osVersion);
  const wrongPin = new FireTvRemote('192.168.0.101', request, token, '00'.repeat(32));
  await wrongPin.status().then(() => console.log('pin errado aceito?!'), (e) => console.log('pin errado →', e.message));
  const bad = new FireTvRemote('192.168.0.101', request, 'token-errado');
  await bad.status().then(() => console.log('token errado aceito?!'), (e) => console.log('token errado →', e.constructor.name));
})().catch((e) => { console.error('ERRO', e); process.exit(1); });
