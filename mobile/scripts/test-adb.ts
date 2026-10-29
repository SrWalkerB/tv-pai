import fs from 'node:fs';
import os from 'node:os';
import { AdbClient } from '../src/adb/protocol';
import { keyFromPem } from '../src/adb/keys';
import { nodeTransport } from './node-transport';

const host = process.env.TV || '192.168.0.101';
const pem = fs.readFileSync(process.env.KEY || `${os.homedir()}/.android/adbkey`, 'utf8');
(async () => {
  const client = new AdbClient(await nodeTransport(host), keyFromPem(pem));
  let t = Date.now();
  await client.connect({ onAuthPrompt: () => console.log('>> aceite na TV') });
  console.log('conectado em', Date.now() - t, 'ms; maxPayload', client.maxPayload);
  t = Date.now();
  console.log('modelo:', (await client.shell('getprop ro.product.model')).trim(), Date.now() - t, 'ms');
  t = Date.now();
  const png = await client.exec('screencap -p');
  console.log('screencap', png.length, 'bytes', Date.now() - t, 'ms', Buffer.from(png.subarray(1, 4)).toString());
  client.close();
})().catch((e) => { console.error('ERRO', e); process.exit(1); });
