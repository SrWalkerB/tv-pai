// Servidor local que traduz cliques da página web em comandos ADB para a Fire TV.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { createIconStore } = require('./icons');

const TV = process.env.TV_IP || '192.168.0.101:5555';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ADB = process.env.ADB || 'adb';

// [código Linux injetado no teclado virtual, keycode Android usado no modo lento de reserva]
const KEYS = {
  up: [103, 'KEYCODE_DPAD_UP'],
  down: [108, 'KEYCODE_DPAD_DOWN'],
  left: [105, 'KEYCODE_DPAD_LEFT'],
  right: [106, 'KEYCODE_DPAD_RIGHT'],
  ok: [353, 'KEYCODE_DPAD_CENTER'],
  back: [158, 'KEYCODE_BACK'],
  home: [172, 'KEYCODE_HOME'],
  menu: [139, 'KEYCODE_MENU'],
  playpause: [164, 'KEYCODE_MEDIA_PLAY_PAUSE'],
  rewind: [168, 'KEYCODE_MEDIA_REWIND'],
  forward: [208, 'KEYCODE_MEDIA_FAST_FORWARD'],
  volup: [115, 'KEYCODE_VOLUME_UP'],
  voldown: [114, 'KEYCODE_VOLUME_DOWN'],
  mute: [113, 'KEYCODE_VOLUME_MUTE'],
  power: [116, 'KEYCODE_POWER'],
  del: [14, 'KEYCODE_DEL'],
};

// Nomes curados têm prioridade; depois vem o nome lido do APK; por último, um nome derivado do pacote.
const LABELS = {
  'com.amazon.firebat': 'Prime Video',
  'com.amazon.shoptv.firetv.client': 'Amazon Shopping',
  'com.amazon.cloud9': 'Silk Browser',
  'com.amazon.tv.launcher': 'Tela inicial',
  'com.amazon.ftv.screensaver': 'Protetor de tela',
  'com.amazon.ftv.profilepicker': 'Perfis',
  'com.android.documentsui': 'Arquivos',
  'com.android.providers.downloads.ui': 'Downloads',
};

function adb(args, { encoding = 'utf8', timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ADB, ['-s', TV, ...args], { encoding, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr && stderr.toString().trim()) || err.message));
      else resolve(stdout);
    });
  });
}

function connect() {
  return new Promise((resolve) => {
    execFile(ADB, ['connect', TV], { timeout: 8000 }, (_err, stdout) => resolve(String(stdout || '').trim()));
  });
}

// Se a conexão caiu (TV dormiu, Wi-Fi oscilou), reconecta e tenta de novo uma vez.
async function run(args, opts) {
  try {
    return await adb(args, opts);
  } catch (err) {
    await connect();
    return adb(args, opts);
  }
}

// `input keyevent` sobe uma VM Java a cada tecla (~1,2 s na Fire TV). Aqui mantemos um shell
// aberto e escrevemos o evento bruto no teclado virtual da Amazon com o `print` embutido do shell,
// sem criar processo nenhum: ~60 ms por tecla.
class KeyShell {
  constructor() {
    this.proc = null;
    this.device = null;
    this.eventSize = 16;
    this.buf = '';
    this.waiting = null;
    this.queue = Promise.resolve();
  }

  async detect() {
    const [events, arch] = await Promise.all([run(['shell', 'getevent', '-pl']), run(['shell', 'uname', '-m'])]);
    const m = events.match(/add device \d+: (\/dev\/input\/event\d+)\s+name:\s+"amzkeyboard"/);
    this.device = m ? m[1] : null;
    this.eventSize = /64/.test(arch) ? 24 : 16;
    return this.device;
  }

  start() {
    this.proc = spawn(ADB, ['-s', TV, 'shell']);
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      if (this.waiting && this.buf.includes(this.waiting.tag)) {
        this.buf = '';
        this.waiting.resolve();
      }
    });
    this.proc.on('exit', () => { this.proc = null; });
  }

  exec(line) {
    if (!this.proc) this.start();
    return new Promise((resolve, reject) => {
      const tag = `__ok${Date.now()}__`;
      const timer = setTimeout(() => {
        this.waiting = null;
        this.proc?.kill();
        reject(new Error('A TV não respondeu ao comando'));
      }, 3000);
      this.waiting = { tag, resolve: () => { clearTimeout(timer); this.waiting = null; resolve(); } };
      this.proc.stdin.write(`${line}; echo ${tag}\n`);
    });
  }

  bytes(code) {
    const timeLen = this.eventSize === 24 ? 16 : 8;
    const hex = (n, len) => Array.from({ length: len }, (_, i) => '\\x' + ((n >>> (8 * i)) & 255).toString(16).padStart(2, '0')).join('');
    const ev = (type, c, value) => hex(0, timeLen) + hex(type, 2) + hex(c, 2) + hex(value, 4);
    return ev(1, code, 1) + ev(0, 0, 0) + ev(1, code, 0) + ev(0, 0, 0);
  }

  press([code, keycode]) {
    const job = async () => {
      if (!this.device) return run(['shell', 'input', 'keyevent', keycode]);
      try {
        await this.exec(`print -n "${this.bytes(code)}" > ${this.device}`);
      } catch {
        await connect();
        await this.exec(`print -n "${this.bytes(code)}" > ${this.device}`);
      }
    };
    this.queue = this.queue.then(job, job);
    return this.queue;
  }
}

const keys = new KeyShell();
const icons = createIconStore(run);

function prettify(pkg) {
  const parts = pkg.split('.').filter((p) => !['com', 'amazon', 'android', 'tv', 'app', 'firetv', 'client'].includes(p));
  const word = parts[parts.length - 1] || pkg;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

async function queryLaunchers(category) {
  const out = await run(['shell', 'cmd', 'package', 'query-activities', '-a', 'android.intent.action.MAIN', '-c', category]);
  const apps = [];
  let name = null;
  for (const line of out.split('\n')) {
    const n = line.match(/^ {6}name=(\S+)/);
    if (n) { name = n[1]; continue; }
    const p = line.match(/^ {6}packageName=(\S+)/);
    if (p && name) { apps.push({ pkg: p[1], activity: name }); name = null; }
  }
  return apps;
}

async function listApps() {
  const [tv, all, third] = await Promise.all([
    queryLaunchers('android.intent.category.LEANBACK_LAUNCHER'),
    queryLaunchers('android.intent.category.LAUNCHER'),
    run(['shell', 'pm', 'list', 'packages', '-3']),
  ]);
  // Só apps instalados pelo usuário podem ser removidos; os de sistema a Fire TV não deixa.
  const removable = new Set(third.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean));
  const byPkg = new Map();
  for (const a of tv) if (!byPkg.has(a.pkg)) byPkg.set(a.pkg, { ...a, tv: true });
  for (const a of all) if (!byPkg.has(a.pkg)) byPkg.set(a.pkg, { ...a, tv: false });
  return [...byPkg.values()]
    .map((a) => {
      const info = icons.info(a.pkg);
      return {
        ...a,
        label: LABELS[a.pkg] || info?.label || prettify(a.pkg),
        banner: info?.banner ? `/icons/${info.banner}` : null,
        icon: info?.icon ? `/icons/${info.icon}` : null,
        removable: removable.has(a.pkg),
      };
    })
    .sort((a, b) => Number(b.tv) - Number(a.tv) || a.label.localeCompare(b.label, 'pt-BR'));
}

async function currentApp() {
  const out = await run(['shell', 'dumpsys', 'window', 'windows']);
  const m = out.match(/mCurrentFocus=Window\{\S+ \S+ ([^/\s}]+)/);
  return m ? m[1] : null;
}

// `input text` não aceita espaço nem caracteres especiais crus: espaço vira %s e o resto é escapado para o shell da TV.
function escapeText(text) {
  return text.replace(/[^A-Za-z0-9]/g, (c) => (c === ' ' ? '%s' : '\\' + c));
}

// Mensagens do instalador do Android traduzidas para algo que dá para agir.
const INSTALL_ERRORS = {
  INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'Já existe uma versão desse app com assinatura diferente. Desinstale a atual e tente de novo.',
  INSTALL_FAILED_VERSION_DOWNGRADE: 'A TV já tem uma versão mais nova desse app.',
  INSTALL_FAILED_INSUFFICIENT_STORAGE: 'Falta espaço na TV. Desinstale algum app e tente de novo.',
  INSTALL_FAILED_NO_MATCHING_ABIS: 'Esse APK foi feito para outro tipo de processador (a Fire TV usa armeabi-v7a).',
  INSTALL_FAILED_OLDER_SDK: 'Esse APK precisa de um Android mais novo que o da TV (7.1).',
  INSTALL_PARSE_FAILED_NOT_APK: 'O arquivo não é um APK válido.',
  INSTALL_FAILED_INVALID_APK: 'O arquivo não é um APK válido.',
};

function installError(output) {
  const code = output.match(/(INSTALL_[A-Z_]+)/)?.[1];
  return (code && INSTALL_ERRORS[code]) || `A TV recusou a instalação: ${code || output.trim().split('\n').pop()}`;
}

const MAX_APK = 2 * 1024 ** 3;

function saveUpload(req) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), `tvpai-${Date.now()}.apk`);
    const out = fs.createWriteStream(file);
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_APK) { req.destroy(); out.destroy(); fs.rmSync(file, { force: true }); reject(Object.assign(new Error('APK maior que 2 GB'), { status: 413 })); }
    });
    req.pipe(out);
    out.on('finish', () => resolve(file));
    out.on('error', reject);
    req.on('error', reject);
  });
}

async function installApk(req) {
  const file = await saveUpload(req);
  try {
    const head = Buffer.alloc(2);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head.toString() !== 'PK') throw Object.assign(new Error('O arquivo não é um APK válido.'), { status: 400 });
    const { pkg, label } = await icons.inspect(file).catch(() => {
      throw Object.assign(new Error('O arquivo não é um APK válido.'), { status: 400 });
    });
    const output = await run(['install', '-r', file], { timeout: 10 * 60 * 1000 }).catch((err) => err.message);
    if (!/^Success/m.test(output)) throw Object.assign(new Error(installError(output)), { status: 422 });
    await icons.refresh(pkg);
    return { ok: true, pkg, label: LABELS[pkg] || icons.info(pkg)?.label || label };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

function send(res, status, body, type = 'application/json', cache = 'no-store') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const routes = {
  'GET /api/status': async () => {
    const state = (await run(['get-state'])).trim();
    return { tv: TV, state, app: await currentApp().catch(() => null), fastKeys: Boolean(keys.device), iconsPending: icons.pending };
  },
  'GET /api/apps': async () => ({ apps: await listApps(), iconsPending: icons.pending }),
  'POST /api/key': async (body) => {
    const key = KEYS[body.key];
    if (!key) throw Object.assign(new Error(`Tecla desconhecida: ${body.key}`), { status: 400 });
    await keys.press(key);
    return { ok: true };
  },
  'POST /api/text': async (body) => {
    const text = String(body.text || '');
    if (!text) throw Object.assign(new Error('Texto vazio'), { status: 400 });
    if (/[^\x20-\x7E]/.test(text)) throw Object.assign(new Error('A TV só aceita texto sem acentos por este caminho'), { status: 400 });
    await run(['shell', 'input', 'text', escapeText(text)]);
    return { ok: true };
  },
  'POST /api/launch': async (body) => {
    const apps = await listApps();
    const app = apps.find((a) => a.pkg === body.pkg);
    if (!app) throw Object.assign(new Error(`App não encontrado: ${body.pkg}`), { status: 404 });
    await run(['shell', 'am', 'start', '-n', `${app.pkg}/${app.activity}`]);
    return { ok: true, label: app.label };
  },
  'POST /api/uninstall': async (body) => {
    const apps = await listApps();
    const app = apps.find((a) => a.pkg === body.pkg);
    if (!app) throw Object.assign(new Error(`App não encontrado: ${body.pkg}`), { status: 404 });
    if (!app.removable) throw Object.assign(new Error(`${app.label} é um app do sistema e a Fire TV não deixa removê-lo.`), { status: 403 });
    const output = await run(['uninstall', app.pkg], { timeout: 60000 }).catch((err) => err.message);
    if (!/^Success/m.test(output)) throw Object.assign(new Error(`A TV não desinstalou ${app.label}: ${output.trim()}`), { status: 422 });
    icons.forget(app.pkg);
    return { ok: true, label: app.label };
  },
};

const IMAGE_TYPES = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;
  try {
    if (key === 'GET /api/screen') {
      const png = await run(['exec-out', 'screencap', '-p'], { encoding: 'buffer' });
      if (!png.length) return send(res, 409, { error: 'Este app bloqueia captura de tela (ex.: Netflix)' });
      return send(res, 200, png, 'image/png');
    }
    if (key === 'POST /api/install') return send(res, 200, await installApk(req));
    if (req.method === 'GET' && url.pathname.startsWith('/icons/')) {
      const file = icons.file(decodeURIComponent(url.pathname.slice('/icons/'.length)));
      if (!file) return send(res, 404, { error: 'Ícone não encontrado' });
      return send(res, 200, fs.readFileSync(file), IMAGE_TYPES[path.extname(file)] || 'application/octet-stream', 'max-age=86400');
    }
    if (routes[key]) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      return send(res, 200, await routes[key](body));
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html')), 'text/html; charset=utf-8');
    }
    send(res, 404, { error: 'Não encontrado' });
  } catch (err) {
    send(res, err.status || 502, { error: err.message });
  }
});

connect().then(async (msg) => {
  console.log(`adb: ${msg}`);
  server.listen(PORT, HOST, () => console.log(`Controle da TV em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
  try {
    const device = await keys.detect();
    console.log(device ? `teclas rápidas via ${device}` : 'teclado virtual não encontrado; usando input keyevent (lento)');
    keys.start();
  } catch (err) {
    console.warn(`detecção de teclado falhou: ${err.message}`);
  }
  try {
    const pkgs = (await listApps()).map((a) => a.pkg);
    await icons.warm(pkgs);
    console.log('ícones prontos');
  } catch (err) {
    console.warn(`ícones: ${err.message}`);
  }
});
