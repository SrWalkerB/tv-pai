import type { IrKey } from '../ir/lg';
import { remoteSupports } from './remoteApi';

// Cada tecla do controle e como ela sai por cada caminho:
// - API de controle remoto (padrão): mapeada em remoteApi.ts
// - linux: código injetado no teclado virtual da Fire TV (modo avançado, ADB)
// - bt: tecla de teclado ("kb") ou de controle de mídia ("cc") no modo Bluetooth
// - ir: código da TV LG (o infravermelho vai para a TV, que repassa à Firestick via HDMI-CEC)
export type KeyName =
  | 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | 'home' | 'menu'
  | 'playpause' | 'rewind' | 'forward' | 'volup' | 'voldown' | 'mute' | 'power' | 'del' | 'input' | 'chup' | 'chdown';

type KeySpec = { linux?: number; bt?: ['kb' | 'cc', number]; ir?: IrKey };

export const KEYS: Record<KeyName, KeySpec> = {
  up: { linux: 103, bt: ['kb', 0x52], ir: 'up' },
  down: { linux: 108, bt: ['kb', 0x51], ir: 'down' },
  left: { linux: 105, bt: ['kb', 0x50], ir: 'left' },
  right: { linux: 106, bt: ['kb', 0x4f], ir: 'right' },
  ok: { linux: 353, bt: ['kb', 0x28], ir: 'ok' },
  back: { linux: 158, bt: ['cc', 0x0224], ir: 'back' },
  home: { linux: 172, bt: ['cc', 0x0223], ir: 'home' },
  menu: { linux: 139, bt: ['cc', 0x0040], ir: 'menu' },
  playpause: { linux: 164, bt: ['cc', 0x00cd], ir: 'playpause' },
  rewind: { linux: 168, bt: ['cc', 0x00b4], ir: 'rewind' },
  forward: { linux: 208, bt: ['cc', 0x00b3], ir: 'forward' },
  volup: { linux: 115, bt: ['cc', 0x00e9], ir: 'volup' },
  voldown: { linux: 114, bt: ['cc', 0x00ea], ir: 'voldown' },
  mute: { linux: 113, bt: ['cc', 0x00e2], ir: 'mute' },
  power: { linux: 116, bt: ['cc', 0x0030], ir: 'power' },
  del: { linux: 14, bt: ['kb', 0x2a] },
  input: { ir: 'input' },
  chup: { ir: 'chup' },
  chdown: { ir: 'chdown' },
};

// remote: API de controle remoto da própria Fire TV (padrão, com PIN). network: ADB (modo avançado).
export type Channel = 'remote' | 'network' | 'bluetooth' | 'ir';

export function supports(channel: Channel, key: KeyName): boolean {
  const spec = KEYS[key];
  if (channel === 'remote') return remoteSupports(key);
  return channel === 'network' ? spec.linux != null : channel === 'bluetooth' ? spec.bt != null : spec.ir != null;
}

// Texto pelo teclado Bluetooth: só ASCII básico (letras, números, espaço e pontuação comum).
const SHIFT = 0x02;
const PUNCT: Record<string, [number, number]> = {
  ' ': [0x2c, 0], '-': [0x2d, 0], '_': [0x2d, SHIFT], '=': [0x2e, 0], '+': [0x2e, SHIFT],
  '.': [0x37, 0], ',': [0x36, 0], '/': [0x38, 0], '?': [0x38, SHIFT], ';': [0x33, 0], ':': [0x33, SHIFT],
  "'": [0x34, 0], '"': [0x34, SHIFT], '!': [0x1e, SHIFT], '@': [0x1f, SHIFT], '#': [0x20, SHIFT],
  '&': [0x24, SHIFT], '(': [0x26, SHIFT], ')': [0x27, SHIFT],
};

export function hidForChar(ch: string): [number, number] | null {
  const c = ch.charCodeAt(0);
  if (c >= 97 && c <= 122) return [0x04 + c - 97, 0];
  if (c >= 65 && c <= 90) return [0x04 + c - 65, SHIFT];
  if (c >= 49 && c <= 57) return [0x1e + c - 49, 0];
  if (ch === '0') return [0x27, 0];
  return PUNCT[ch] ?? null;
}
