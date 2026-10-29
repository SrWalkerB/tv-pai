// Extrai ícone/banner e nome real de cada app lendo só pedaços do APK direto na TV,
// sem baixar o APK inteiro (alguns passam de 100 MB).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');

const CACHE = path.join(__dirname, 'cache', 'icons');
const BLOCK = 4096;

function findAapt() {
  const sdk = process.env.ANDROID_HOME || path.join(os.homedir(), 'Library', 'Android', 'sdk');
  const dir = path.join(sdk, 'build-tools');
  try {
    const versions = fs.readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const bin = path.join(dir, v, 'aapt');
      if (fs.existsSync(bin)) return bin;
    }
  } catch {}
  return 'aapt';
}

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

function createIconStore(run) {
  const aapt = findAapt();
  fs.mkdirSync(CACHE, { recursive: true });
  const metaFile = path.join(CACHE, 'meta.json');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
  let pending = 0;

  const shellBuf = (cmd) => run(['exec-out', cmd], { encoding: 'buffer', timeout: 60000 });

  // Lê [off, off+len) do arquivo na TV usando dd em blocos alinhados e corta o excesso aqui.
  async function readRange(apk, off, len) {
    const skip = Math.floor(off / BLOCK);
    const count = Math.ceil((off + len) / BLOCK) - skip;
    const buf = await shellBuf(`dd if='${apk}' bs=${BLOCK} skip=${skip} count=${count} 2>/dev/null`);
    const start = off - skip * BLOCK;
    return buf.subarray(start, start + len);
  }

  async function centralDirectory(apk, size) {
    const tailLen = Math.min(size, 65557);
    const tail = await shellBuf(`tail -c ${tailLen} '${apk}'`);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('fim do zip não encontrado');
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    const cd = await readRange(apk, cdOff, cdSize);
    const entries = new Map();
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      entries.set(cd.toString('utf8', p + 46, p + 46 + nameLen), {
        method: cd.readUInt16LE(p + 10),
        compSize: cd.readUInt32LE(p + 20),
        offset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function readEntry(apk, entry) {
    const header = await readRange(apk, entry.offset, 30);
    const dataOff = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = await readRange(apk, dataOff, entry.compSize);
    return entry.method === 8 ? zlib.inflateRawSync(data) : data;
  }

  // aapt só precisa do manifesto e do resources.arsc para dizer nome, ícone e banner.
  async function badging(apk, entries, tmp) {
    for (const name of ['AndroidManifest.xml', 'resources.arsc']) {
      const e = entries.get(name);
      if (!e) throw new Error(`${name} ausente`);
      fs.writeFileSync(path.join(tmp, name), await readEntry(apk, e));
    }
    const mini = path.join(tmp, 'mini.apk');
    await exec('zip', ['-q', '-0', '-j', mini, path.join(tmp, 'AndroidManifest.xml'), path.join(tmp, 'resources.arsc')]);
    return exec(aapt, ['dump', 'badging', mini]);
  }

  function pickImages(out) {
    const isImage = (p) => p && /\.(png|webp|jpe?g)$/i.test(p);
    const app = out.match(/^application: (.*)$/m)?.[1] || '';
    const banner = app.match(/banner='([^']+)'/)?.[1];
    const icons = [...out.matchAll(/^application-icon-(\d+):'([^']+)'/gm)]
      .map((m) => ({ density: Number(m[1]), file: m[2] }))
      .filter((i) => i.density < 65534 && isImage(i.file))
      .sort((a, b) => b.density - a.density);
    const label = out.match(/^application-label-pt-BR:'([^']*)'/m)?.[1]
      || out.match(/^application-label-pt:'([^']*)'/m)?.[1]
      || out.match(/^application-label:'([^']*)'/m)?.[1]
      || app.match(/label='([^']*)'/)?.[1];
    return { label: label || null, banner: isImage(banner) ? banner : null, icon: icons[0]?.file || app.match(/icon='([^']+\.(?:png|webp))'/)?.[1] || null };
  }

  // O aapt aponta a versão padrão (geralmente mdpi); procura a mesma imagem na maior densidade do APK.
  const DPI = { ldpi: 120, mdpi: 160, tvdpi: 213, hdpi: 240, xhdpi: 320, xxhdpi: 480, xxxhdpi: 640 };
  function sharpest(file, entries) {
    const name = path.basename(file);
    let best = { file, dpi: 0 };
    for (const candidate of entries.keys()) {
      const m = candidate.match(/^res\/(?:drawable|mipmap)(?:-(ldpi|mdpi|tvdpi|hdpi|xhdpi|xxhdpi|xxxhdpi))?(?:-v\d+)?\/([^/]+)$/);
      if (!m || m[2] !== name) continue;
      const dpi = DPI[m[1]] || 160;
      if (dpi > best.dpi) best = { file: candidate, dpi };
    }
    return best.file;
  }

  async function extract(pkg) {
    const apk = (await run(['shell', 'pm', 'path', pkg])).split('\n')[0].replace('package:', '').trim();
    if (!apk) throw new Error('APK não encontrado');
    const size = Number((await run(['shell', 'stat', '-c', '%s', apk])).trim());
    const key = `${apk}:${size}`;
    if (meta[pkg]?.key === key) return meta[pkg];

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvicon-'));
    try {
      const entries = await centralDirectory(apk, size);
      const found = pickImages(await badging(apk, entries, tmp));
      const result = { key, label: found.label, banner: null, icon: null };
      for (const kind of ['banner', 'icon']) {
        const file = found[kind] && sharpest(found[kind], entries);
        if (!file || !entries.has(file)) continue;
        const ext = path.extname(file).toLowerCase();
        const out = `${pkg}.${kind}${ext}`;
        fs.writeFileSync(path.join(CACHE, out), await readEntry(apk, entries.get(file)));
        result[kind] = out;
      }
      meta[pkg] = result;
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
      return result;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  return {
    get pending() { return pending; },
    info(pkg) { return meta[pkg] || null; },
    // Lê pacote e nome de um APK que está no Mac (antes de instalar).
    async inspect(file) {
      const out = await exec(aapt, ['dump', 'badging', file]);
      const pkg = out.match(/^package: name='([^']+)'/m)?.[1];
      if (!pkg) throw new Error('arquivo não parece um APK válido');
      return { pkg, label: pickImages(out).label || pkg };
    },
    async refresh(pkg) {
      try { return await extract(pkg); } catch (err) { console.warn(`ícone de ${pkg}: ${err.message}`); return null; }
    },
    forget(pkg) {
      const info = meta[pkg];
      if (!info) return;
      for (const f of [info.banner, info.icon]) if (f) fs.rmSync(path.join(CACHE, f), { force: true });
      delete meta[pkg];
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    },
    file(name) {
      const safe = path.basename(name);
      const full = path.join(CACHE, safe);
      return safe !== 'meta.json' && fs.existsSync(full) ? full : null;
    },
    // Roda em fila, um app por vez, para não disputar a conexão com os comandos do controle.
    async warm(pkgs) {
      pending = pkgs.length;
      for (const pkg of pkgs) {
        try { await extract(pkg); } catch (err) { console.warn(`ícone de ${pkg}: ${err.message}`); }
        pending--;
      }
    },
  };
}

module.exports = { createIconStore };
