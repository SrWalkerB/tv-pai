import { AdbClient, AdbStream, push, text, utf8, type AdbKey, type Transport } from '../adb/protocol';
import { Zip, type RangeReader } from '../apk/zip';
import { readAppInfo, type AppInfo } from '../apk/manifest';
import { KEYS, type KeyName } from './keys';

export type TvApp = { pkg: string; activity: string; tv: boolean; removable: boolean; label: string };

export type DeviceInfo = {
  model: string;
  modelName: string;
  fireOs: string | null;
  android: string;
  storageTotal: number | null;
  storageFree: number | null;
  resolution: string | null;
  host: string;
};

// Nomes comerciais dos modelos mais comuns (o sistema só informa o código, como AFTMM).
// Espaço da partição de dados. Aceita três formatos:
// - stat -f: "4096 1395000 820000" (tamanho do bloco, blocos totais, blocos livres)
// - df do toybox: "/dev/block/... 5579000 2200000 3379000 40% /data" (em KB)
// - df antigo do toolbox (Fire OS 6): "/data 5.3G 2.1G 3.2G 4096" (com sufixo)
export function parseStorage(out: string): { total: number; free: number } {
  const cols = out.trim().split(/\s+/);
  if (cols.length === 3 && cols.every((c) => /^\d+$/.test(c))) {
    const [block, blocks, avail] = cols.map(Number);
    return { total: block * blocks, free: block * avail };
  }
  const size = (v: string | undefined) => {
    const m = v?.match(/^([\d.]+)([KMGT])?$/i);
    if (!m) return NaN;
    const unit = m[2] ? 1024 ** ('KMGT'.indexOf(m[2].toUpperCase()) + 1) : 1024;
    return Number(m[1]) * unit;
  };
  return { total: size(cols[1]), free: size(cols[3]) };
}

const MODEL_NAMES: Record<string, string> = {
  AFTMM: 'Fire TV Stick 4K',
  AFTKA: 'Fire TV Stick 4K Max',
  AFTSSS: 'Fire TV Stick (3ª geração)',
  AFTSS: 'Fire TV Stick Lite',
};

// Nomes curados para apps da Amazon cujo nome interno não ajuda.
const LABELS: Record<string, string> = {
  'com.amazon.firebat': 'Prime Video',
  'com.amazon.shoptv.firetv.client': 'Amazon Shopping',
  'com.amazon.cloud9': 'Silk Browser',
  'com.amazon.tv.launcher': 'Tela inicial',
  'com.amazon.ftv.screensaver': 'Protetor de tela',
  'com.amazon.ftv.profilepicker': 'Perfis',
  'com.amazon.venezia': 'Appstore',
  'com.netflix.ninja': 'Netflix',
  'com.amazon.firetv.youtube': 'YouTube',
  'com.disney.disneyplus': 'Disney+',
  'com.hbo.hbonow': 'HBO Max',
  'com.globo.globotv': 'Globoplay',
  'com.cbs.ca': 'Paramount+',
  'tv.pluto.android': 'Pluto TV',
  'com.crunchyroll.crunchyroid': 'Crunchyroll',
  'cm.aptoidetv.pt': 'Aptoide TV',
  'com.esaba.downloader': 'Downloader',
  'com.angel.tv': 'Angel Studios',
  'com.amazon.bueller.music': 'Amazon Music',
};

function prettify(pkg: string): string {
  const parts = pkg.split('.').filter((p) => !['com', 'amazon', 'android', 'tv', 'app', 'firetv', 'client'].includes(p));
  const word = parts[parts.length - 1] || pkg;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// Aspas simples para o sh da TV: tudo que vem de fora (texto, caminhos) passa por aqui.
function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const INSTALL_ERRORS: Record<string, string> = {
  INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'Já existe uma versão desse app com assinatura diferente. Desinstale a atual e tente de novo.',
  INSTALL_FAILED_VERSION_DOWNGRADE: 'A TV já tem uma versão mais nova desse app.',
  INSTALL_FAILED_INSUFFICIENT_STORAGE: 'Falta espaço na TV. Desinstale algum app e tente de novo.',
  INSTALL_FAILED_NO_MATCHING_ABIS: 'Esse APK foi feito para outro tipo de processador (a Fire TV usa armeabi-v7a).',
  INSTALL_FAILED_OLDER_SDK: 'Esse APK precisa de um Android mais novo que o da TV (7.1).',
  INSTALL_PARSE_FAILED_NOT_APK: 'O arquivo não é um APK válido.',
  INSTALL_FAILED_INVALID_APK: 'O arquivo não é um APK válido.',
};

export class FireTvNetwork {
  private client: AdbClient | null = null;
  private keyShell: AdbStream | null = null;
  private keyShellOut = '';
  private keyWaiter: { tag: string; resolve: () => void } | null = null;
  private keyQueue: Promise<void> = Promise.resolve();
  private inputDevice: string | null = null;
  private eventSize = 16;
  private closeListeners: ((err?: Error) => void)[] = [];
  lastLatency: number | null = null;

  constructor(
    readonly host: string,
    private key: AdbKey,
    private openTransport: (host: string, port: number) => Promise<Transport>,
    readonly port = 5555,
  ) {}

  get connected() {
    return this.client?.connected ?? false;
  }

  onClose(cb: (err?: Error) => void) {
    this.closeListeners.push(cb);
  }

  async connect(onAuthPrompt?: () => void): Promise<void> {
    let transport: Transport;
    try {
      transport = await this.openTransport(this.host, this.port);
    } catch {
      throw new Error(`Não achei a TV em ${this.host}. Confira o IP e se a depuração ADB está ligada.`);
    }
    const client = new AdbClient(transport, this.key);
    try {
      await client.connect({ onAuthPrompt });
    } catch (err) {
      const msg = (err as Error).message;
      // A Fire TV aceita só uma conexão ADB por vez: se outro aparelho está conectado, ela derruba a nossa na hora.
      if (/fechou|reset|closed/i.test(msg)) throw new Error('A TV está conectada a outro controle (o Mac, por exemplo). Desconecte o outro e tente de novo.');
      throw err;
    }
    this.client = client;
    client.onClose((err) => {
      this.keyShell = null;
      for (const cb of this.closeListeners) cb(err);
    });
    const [events, arch] = await Promise.all([this.shell('getevent -pl'), this.shell('uname -m')]);
    this.inputDevice = events.match(/add device \d+: (\/dev\/input\/event\d+)\s+name:\s+"amzkeyboard"/)?.[1] ?? null;
    this.eventSize = /64/.test(arch) ? 24 : 16;
  }

  disconnect() {
    this.client?.close();
    this.client = null;
    this.keyShell = null;
  }

  private need(): AdbClient {
    if (!this.client?.connected) throw new Error('Não conectado à TV pela rede');
    return this.client;
  }

  shell(command: string): Promise<string> {
    return this.need().shell(command);
  }

  exec(command: string): Promise<Uint8Array> {
    return this.need().exec(command);
  }

  // Mesma técnica do servidor do Mac: um sh aberto e o evento bruto escrito no teclado virtual
  // com o `print` embutido do shell (~60 ms por tecla, contra ~1,2 s do `input keyevent`).
  private eventBytes(code: number): string {
    const timeLen = this.eventSize === 24 ? 16 : 8;
    const hex = (n: number, len: number) =>
      Array.from({ length: len }, (_, i) => '\\x' + ((n >>> (8 * i)) & 255).toString(16).padStart(2, '0')).join('');
    const ev = (type: number, c: number, value: number) => hex(0, timeLen) + hex(type, 2) + hex(c, 2) + hex(value, 4);
    return ev(1, code, 1) + ev(0, 0, 0) + ev(1, code, 0) + ev(0, 0, 0);
  }

  private async openKeyShell(): Promise<AdbStream> {
    const stream = await this.need().open('exec:sh');
    stream.onData((d) => {
      this.keyShellOut += text(d);
      if (this.keyWaiter && this.keyShellOut.includes(this.keyWaiter.tag)) {
        this.keyShellOut = '';
        this.keyWaiter.resolve();
      }
    });
    stream.onClose(() => {
      if (this.keyShell === stream) this.keyShell = null;
    });
    return stream;
  }

  private async runInKeyShell(line: string): Promise<void> {
    if (!this.keyShell) this.keyShell = await this.openKeyShell();
    const stream = this.keyShell;
    const tag = `__ok${Date.now()}__`;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.keyWaiter = null;
        stream.close();
        reject(new Error('A TV não respondeu ao comando'));
      }, 3000);
      this.keyWaiter = { tag, resolve: () => { clearTimeout(timer); this.keyWaiter = null; resolve(); } };
      stream.write(utf8(`${line}; echo ${tag}\n`)).catch(reject);
    });
  }

  press(name: KeyName): Promise<void> {
    const code = KEYS[name].linux;
    if (code == null) return Promise.reject(new Error('Essa tecla só existe no infravermelho'));
    const job = async () => {
      const t = Date.now();
      if (this.inputDevice) await this.runInKeyShell(`print -n "${this.eventBytes(code)}" > ${this.inputDevice}`);
      else await this.shell(`input keyevent ${code}`);
      this.lastLatency = Date.now() - t;
    };
    this.keyQueue = this.keyQueue.then(job, job);
    return this.keyQueue;
  }

  async typeText(value: string): Promise<void> {
    if (/[^\x20-\x7E]/.test(value)) throw new Error('A TV só aceita texto sem acentos por este caminho');
    const escaped = value.replace(/ /g, '%s');
    await this.shell(`input text ${quote(escaped)}`);
  }

  private async queryLaunchers(category: string) {
    const out = await this.shell(`cmd package query-activities -a android.intent.action.MAIN -c ${category}`);
    const apps: { pkg: string; activity: string }[] = [];
    let name: string | null = null;
    for (const line of out.split('\n')) {
      const n = line.match(/^ {6}name=(\S+)/);
      if (n) { name = n[1]; continue; }
      const p = line.match(/^ {6}packageName=(\S+)/);
      if (p && name) { apps.push({ pkg: p[1], activity: name }); name = null; }
    }
    return apps;
  }

  async listApps(labelFor?: (pkg: string) => string | null | undefined): Promise<TvApp[]> {
    const tv = await this.queryLaunchers('android.intent.category.LEANBACK_LAUNCHER');
    const all = await this.queryLaunchers('android.intent.category.LAUNCHER');
    const third = await this.shell('pm list packages -3');
    const removable = new Set(third.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean));
    const byPkg = new Map<string, { pkg: string; activity: string; tv: boolean }>();
    for (const a of tv) if (!byPkg.has(a.pkg)) byPkg.set(a.pkg, { ...a, tv: true });
    for (const a of all) if (!byPkg.has(a.pkg)) byPkg.set(a.pkg, { ...a, tv: false });
    return [...byPkg.values()]
      .map((a) => ({ ...a, removable: removable.has(a.pkg), label: LABELS[a.pkg] || labelFor?.(a.pkg) || prettify(a.pkg) }))
      .sort((a, b) => Number(b.tv) - Number(a.tv) || a.label.localeCompare(b.label, 'pt-BR'));
  }

  async currentApp(): Promise<string | null> {
    const out = await this.shell('dumpsys window windows | grep mCurrentFocus');
    return out.match(/mCurrentFocus=Window\{\S+ \S+ ([^/\s}]+)/)?.[1] ?? null;
  }

  async launch(app: TvApp): Promise<void> {
    await this.shell(`am start -n ${quote(`${app.pkg}/${app.activity}`)}`);
  }

  async screenshot(): Promise<Uint8Array> {
    const png = await this.exec('screencap -p');
    if (!png.length) throw new Error('Este app bloqueia captura de tela (ex.: Netflix)');
    return png;
  }

  async uninstall(app: TvApp): Promise<void> {
    if (!app.removable) throw new Error(`${app.label} é um app do sistema e a Fire TV não deixa removê-lo.`);
    const out = await this.shell(`pm uninstall ${quote(app.pkg)}`);
    if (!/Success/.test(out)) throw new Error(`A TV não desinstalou ${app.label}: ${out.trim()}`);
  }

  // Envia o APK para /data/local/tmp e instala com o pm, como o `adb install` faz.
  // A fase de envio pode ser cancelada; a de instalação (pm install) não, então avisamos quando ela começa.
  async install(
    read: RangeReader,
    size: number,
    onProgress?: (sent: number) => void,
    isCancelled?: () => boolean,
    onInstalling?: () => void,
  ): Promise<void> {
    const remote = `/data/local/tmp/tvpai-${Date.now()}.apk`;
    try {
      await push(this.need(), read, size, remote, onProgress, isCancelled);
    } catch (err) {
      await this.shell(`rm -f ${quote(remote)}`).catch(() => {});
      throw err;
    }
    onInstalling?.();
    try {
      const out = await this.shell(`pm install -r ${quote(remote)}`);
      if (!/Success/.test(out)) {
        const code = out.match(/(INSTALL_[A-Z_]+)/)?.[1];
        throw new Error((code && INSTALL_ERRORS[code]) || `A TV recusou a instalação: ${code || out.trim()}`);
      }
    } finally {
      await this.shell(`rm -f ${quote(remote)}`).catch(() => {});
    }
  }

  // Lê só o necessário do APK na TV (via dd em blocos) para achar nome, ícone e banner.
  async apkRemote(pkg: string): Promise<{ key: string; zip: Zip } | null> {
    const apk = (await this.shell(`pm path ${quote(pkg)}`)).split('\n')[0].replace('package:', '').trim();
    if (!apk) return null;
    const size = Number((await this.shell(`stat -c %s ${quote(apk)}`)).trim());
    if (!size) return null;
    const BLOCK = 4096;
    const read: RangeReader = async (off, len) => {
      const skip = Math.floor(off / BLOCK);
      const count = Math.ceil((off + len) / BLOCK) - skip;
      const buf = await this.exec(`dd if=${quote(apk)} bs=${BLOCK} skip=${skip} count=${count} 2>/dev/null`);
      const start = off - skip * BLOCK;
      return buf.subarray(start, start + len);
    };
    return { key: `${apk}:${size}`, zip: await Zip.open(read, size) };
  }

  async appArt(pkg: string): Promise<{ key: string; info: AppInfo; image: Uint8Array | null; imageName: string | null } | null> {
    const remote = await this.apkRemote(pkg);
    if (!remote) return null;
    const info = await readAppInfo(remote.zip);
    const imageName = info.banner || info.icon;
    const image = imageName && remote.zip.entries.has(imageName) ? await remote.zip.file(imageName) : null;
    return { key: remote.key, info, image, imageName };
  }

  // Endereço Bluetooth da própria Firestick, para o celular pedir o pareamento sem passar pelos menus da TV.
  async bluetoothAddress(): Promise<string | null> {
    const MAC = /([0-9A-F]{2}(?::[0-9A-F]{2}){5})/i;
    const fromSettings = (await this.shell('settings get secure bluetooth_address').catch(() => '')).trim();
    if (MAC.test(fromSettings) && !/^00:00:00/.test(fromSettings)) return fromSettings.match(MAC)![1].toUpperCase();
    const dump = await this.shell('dumpsys bluetooth_manager | grep -m1 -i "address:"').catch(() => '');
    return dump.match(MAC)?.[1].toUpperCase() ?? null;
  }

  // Processadores que a TV aceita, do preferido para o menos (a Fire TV Stick 4K é só 32 bits).
  async abis(): Promise<string[]> {
    const out = (await this.shell('getprop ro.product.cpu.abilist')).trim();
    return out ? out.split(',').map((a) => a.trim()).filter(Boolean) : [];
  }

  // Informações da Firestick para a tela de Dispositivos (uma ida só ao shell da TV).
  async deviceInfo(): Promise<DeviceInfo> {
    const sep = '__tvpai__';
    const out = await this.shell(
      [
        'getprop ro.product.model',
        'getprop ro.build.version.name',
        'getprop ro.build.version.release',
        // Tamanho do bloco, blocos totais e livres; o df fica de reserva (o formato dele muda entre versões).
        "stat -f -c '%S %b %a' /data 2>/dev/null || df /data | tail -1",
        'wm size',
      ].join(`; echo ${sep}; `),
    );
    const [model, fireOs, android, df, size] = out.split(sep).map((p) => p.trim());
    const { total, free } = parseStorage(df);
    return {
      model,
      modelName: MODEL_NAMES[model] ?? `Fire TV (${model})`,
      fireOs: fireOs.match(/Fire OS [\d.]+/i)?.[0] ?? null,
      android,
      storageTotal: Number.isFinite(total) ? total : null,
      storageFree: Number.isFinite(free) ? free : null,
      resolution: size.match(/(\d+x\d+)/)?.[1] ?? null,
      host: this.host,
    };
  }

  // Abre "Controles e dispositivos Bluetooth" na própria TV (atalho para parear o modo Bluetooth).
  // A Fire TV não tem a ação padrão BLUETOOTH_SETTINGS; esta é a da Amazon.
  async openBluetoothPairing(): Promise<void> {
    await this.shell('am start -a android.settings.CONTROLLERS_SETTINGS');
  }
}
