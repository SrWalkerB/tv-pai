import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Zip } from '../src/apk/zip';
import { readAppInfo } from '../src/apk/manifest';

const aapt = `${process.env.HOME}/Library/Android/sdk/build-tools/36.0.0/aapt`;
(async () => {
  for (const file of process.argv.slice(2)) {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const read = async (off: number, len: number) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return new Uint8Array(b); };
    const t = Date.now();
    const zip = await Zip.open(read, size);
    const info = await readAppInfo(zip);
    const ms = Date.now() - t;
    const img = info.banner || info.icon;
    const bytes = img ? await zip.file(img) : null;
    const badging = execFileSync(aapt, ['dump', 'badging', file]).toString();
    const ref = {
      pkg: badging.match(/^package: name='([^']+)'/m)?.[1],
      label: badging.match(/^application-label-pt-BR:'([^']*)'/m)?.[1] || badging.match(/^application-label:'([^']*)'/m)?.[1],
      banner: badging.match(/banner='([^']+)'/)?.[1],
    };
    console.log(file.split('/').pop(), `${ms}ms`);
    console.log('  nosso:', JSON.stringify(info), bytes ? `img ${bytes.length}B png=${bytes[1] === 0x50}` : '');
    console.log('  aapt :', JSON.stringify(ref));
  }
})().catch((e) => { console.error(e); process.exit(1); });
