import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { generatePem, keyFromPem, seedRandom } from '../adb/keys';
import type { AdbKey } from '../adb/protocol';
import { nativeKeys } from '../../modules/tv-native';

const KEY_PEM = 'adb-key';
const SETTINGS = 'settings';

export type Settings = {
  host: string;
  tvName: string | null;
  btAddress: string | null;
  target: 'firestick' | 'tv' | null;
  irStyle: 'single' | 'repeat' | 'double' | null;
  // Token do PIN de cada Firestick (por IP): a TV pede o PIN só na primeira vez.
  tokens: Record<string, string>;
  // Impressão digital do certificado de cada Firestick, fixada no pareamento.
  pins: Record<string, string>;
  // Modo avançado (depuração ADB): instalar/desinstalar APK, ver a tela, armazenamento.
  adb: boolean;
};

// Sem IP salvo: na primeira abertura o app procura a Firestick sozinho na rede.
const DEFAULTS: Settings = { host: '', tvName: null, btAddress: null, target: null, irStyle: null, tokens: {}, pins: {}, adb: false };

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await SecureStore.getItemAsync(SETTINGS);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await SecureStore.setItemAsync(SETTINGS, JSON.stringify(s)).catch(() => {});
}

// A chave ADB é gerada uma vez por celular; a TV pede para aceitá-la só na primeira conexão.
// Gerar e assinar ficam no nativo quando o módulo existe; o forge é só a reserva.
export async function loadOrCreateKey(onGenerating?: () => void): Promise<AdbKey> {
  const sign = nativeKeys ? (pem: string, token: Uint8Array) => nativeKeys!.sign(pem, token) : undefined;
  const saved = await SecureStore.getItemAsync(KEY_PEM).catch(() => null);
  if (saved) return keyFromPem(saved, undefined, sign);
  onGenerating?.();
  let pem: string;
  if (nativeKeys) pem = await nativeKeys.generateRsaPem();
  else {
    seedRandom(Crypto.getRandomBytes(64));
    pem = await generatePem();
  }
  await SecureStore.setItemAsync(KEY_PEM, pem);
  return keyFromPem(pem, undefined, sign);
}

// Cache dos banners/ícones extraídos da TV, para não ler os APKs de novo a cada abertura.
export type ArtMeta = { key: string; label: string | null; file: string | null };

const iconDir = new Directory(Paths.cache, 'icons');
const metaFile = new File(Paths.document, 'icons.json');

export function loadArtMeta(): Record<string, ArtMeta> {
  try {
    return metaFile.exists ? JSON.parse(metaFile.textSync()) : {};
  } catch {
    return {};
  }
}

export function saveArt(meta: Record<string, ArtMeta>, pkg: string, key: string, label: string | null, image: Uint8Array | null, name: string | null) {
  let file: string | null = null;
  if (image && name) {
    if (!iconDir.exists) iconDir.create({ idempotent: true, intermediates: true });
    const ext = name.slice(name.lastIndexOf('.')) || '.png';
    const f = new File(iconDir, `${pkg}${ext}`);
    if (f.exists) f.delete();
    f.create();
    f.writeSync(image);
    file = f.uri;
  }
  meta[pkg] = { key, label, file };
  metaFile.writeSync(JSON.stringify(meta));
}

export function forgetArt(meta: Record<string, ArtMeta>, pkg: string) {
  delete meta[pkg];
  metaFile.writeSync(JSON.stringify(meta));
}

// A captura da tela vai para um arquivo novo a cada vez (a Image do RN guarda cache por URI).
let lastScreen: File | null = null;
export function saveScreenshot(png: Uint8Array): string {
  const f = new File(Paths.cache, `tela-${Date.now()}.png`);
  f.create();
  f.writeSync(png);
  if (lastScreen?.exists) lastScreen.delete();
  lastScreen = f;
  return f.uri;
}

export function fileReader(uri: string) {
  const file = new File(uri);
  return {
    size: file.size,
    read: async (offset: number, length: number) => {
      const handle = file.open(FileMode.ReadOnly);
      try {
        handle.offset = offset;
        return await handle.readBytes(length);
      } finally {
        handle.close();
      }
    },
  };
}
