// Cliente da API de controle remoto que a própria Fire TV oferece (a mesma do app oficial da Amazon).
// Não precisa de depuração ADB: na primeira vez a TV mostra um PIN, a pessoa digita no celular e
// recebe um token que vale para as próximas conexões. TypeScript puro: o HTTP vem de fora.
import type { KeyName } from './keys';

export type HttpRequest = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number,
  // Impressão digital SHA-256 do certificado fixado (null = primeiro pareamento, ainda sem pin).
  pin: string | null,
) => Promise<{ status: number; body: string; fingerprint: string | null }>;

export type RemoteApp = { pkg: string; label: string; icon: string | null };

// Chave pública usada pelos apps de controle (não é segredo do usuário; o que autoriza é o token do PIN).
const API_KEY = '0987654321';

// Teclas do controle → comandos da API. Play/pausa alterna entre "play" e "pause" (a API não tem toggle).
const ACTIONS: Partial<Record<KeyName, string>> = {
  up: 'dpad_up',
  down: 'dpad_down',
  left: 'dpad_left',
  right: 'dpad_right',
  ok: 'select',
  back: 'back',
  home: 'home',
  menu: 'menu',
  volup: 'volume_up',
  voldown: 'volume_down',
  mute: 'mute',
  power: 'sleep',
};

const MEDIA: Partial<Record<KeyName, { action: string; body?: object }>> = {
  rewind: { action: 'scan', body: { direction: 'back', durationInSeconds: 10 } },
  forward: { action: 'scan', body: { direction: 'forward', durationInSeconds: 10 } },
};

export function remoteSupports(key: KeyName): boolean {
  return key in ACTIONS || key in MEDIA || key === 'playpause';
}

// A TV não reconhece mais o token (reset, pareamento removido): é preciso mostrar o PIN de novo.
export class NeedsPairingError extends Error {
  constructor() {
    super('A TV pediu um novo pareamento');
  }
}

export class FireTvRemote {
  private playing = true;

  constructor(
    readonly host: string,
    private http: HttpRequest,
    public token: string | null = null,
    // Certificado fixado no pareamento: depois dele, uma TV com outro certificado é recusada.
    public pin: string | null = null,
  ) {}

  private async call(method: string, path: string, body?: object, timeoutMs = 5000): Promise<string> {
    const headers: Record<string, string> = { 'x-api-key': API_KEY, 'Content-Type': 'application/json' };
    if (this.token) headers['x-client-token'] = this.token;
    const res = await this.http(method, `https://${this.host}:8080${path}`, headers, body ? JSON.stringify(body) : null, timeoutMs, this.pin);
    // Primeiro contato (pareamento): fixa o certificado que a TV apresentou.
    if (!this.pin && res.fingerprint) this.pin = res.fingerprint;
    if (res.status === 403 && /client token|unauthorized/i.test(res.body)) throw new NeedsPairingError();
    if (res.status >= 400) {
      let msg = res.body;
      try { msg = JSON.parse(res.body).description ?? msg; } catch {}
      throw new Error(`A TV recusou o comando: ${msg}`);
    }
    return res.body;
  }

  // Acorda o serviço de controle remoto da TV pelo DIAL (como o app oficial faz).
  async wake(): Promise<void> {
    await this.http('POST', `http://${this.host}:8009/apps/FireTVRemote`, {}, '', 4000, null).catch(() => {});
  }

  async showPin(friendlyName: string): Promise<void> {
    await this.wake();
    await this.call('POST', '/v1/FireTV/pin/display', { friendlyName });
  }

  async verifyPin(pin: string): Promise<string> {
    const body = await this.call('POST', '/v1/FireTV/pin/verify', { pin });
    const token = JSON.parse(body).description as string | undefined;
    if (!token || /fail|invalid|incorrect/i.test(token)) throw new Error('PIN incorreto. Confira o número na TV.');
    this.token = token;
    return token;
  }

  async status(): Promise<{ osVersion: string | null }> {
    const body = JSON.parse(await this.call('GET', '/v1/FireTV/status'));
    return { osVersion: body.osVersion ?? null };
  }

  async press(key: KeyName): Promise<void> {
    const action = ACTIONS[key];
    if (action) {
      await this.call('POST', `/v1/FireTV?action=${action}`);
      return;
    }
    if (key === 'playpause') {
      this.playing = !this.playing;
      await this.call('POST', `/v1/media?action=${this.playing ? 'play' : 'pause'}`);
      return;
    }
    const media = MEDIA[key];
    if (media) {
      await this.call('POST', `/v1/media?action=${media.action}`, media.body);
      return;
    }
    throw new Error('Essa tecla precisa do modo avançado (depuração ADB)');
  }

  async typeText(text: string): Promise<void> {
    await this.call('POST', '/v1/FireTV/text', { text });
  }

  async apps(): Promise<RemoteApp[]> {
    const list = JSON.parse(await this.call('GET', '/v1/FireTV/apps', undefined, 8000)) as {
      appId: string; name: string; iconArtSmallUri?: string; isInstalled?: boolean;
    }[];
    return list
      .filter((a) => a.isInstalled !== false)
      .map((a) => ({ pkg: a.appId, label: a.name, icon: a.iconArtSmallUri ?? null }))
      .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  }

  async launch(pkg: string): Promise<void> {
    await this.call('POST', `/v1/FireTV/app/${encodeURIComponent(pkg)}`);
  }
}
