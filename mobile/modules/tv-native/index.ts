import { requireOptionalNativeModule, type EventSubscription } from 'expo';

// Os dois módulos são opcionais: no Expo Go, ou num celular sem o hardware, o app segue só pela rede.

type FireIrModule = {
  hasEmitter(): boolean;
  carrierRanges(): [number, number][];
  transmit(frequency: number, pattern: number[]): Promise<number>;
};

export type BtDevice = { name: string; address: string; bonded: boolean };
export type BtState = { state: 'connected' | 'connecting' | 'disconnected'; name: string; address: string };

type FireBtModule = {
  isSupported(): boolean;
  isEnabled(): boolean;
  requestEnable(): boolean;
  requestDiscoverable(seconds: number): boolean;
  bondedDevices(): BtDevice[];
  startScan(): boolean;
  stopScan(): void;
  register(): Promise<boolean>;
  pair(address: string): boolean;
  connect(address: string): boolean;
  disconnect(): void;
  connectedHost(): BtDevice | null;
  sendKey(kind: 'kb' | 'cc', code: number, modifier: number): Promise<void>;
  addListener(event: 'onState', cb: (e: BtState) => void): EventSubscription;
  addListener(event: 'onDevice', cb: (e: BtDevice) => void): EventSubscription;
  addListener(event: 'onBond', cb: (e: { address: string; name: string; state: 'bonded' | 'bonding' | 'none' }) => void): EventSubscription;
};

export type FoundTv = { name: string; host: string };

// Descoberta das Fire TVs na rede (mDNS), com o nome que aparece nas configurações da TV.
export const discovery = requireOptionalNativeModule<{
  start(): boolean;
  stop(): void;
  addListener(event: 'onTv', cb: (e: FoundTv) => void): EventSubscription;
}>('TvDiscovery');

const ir = requireOptionalNativeModule<FireIrModule>('FireIr');
export const bt = requireOptionalNativeModule<FireBtModule>('FireBt');
// Chave e assinatura RSA feitas pelo Android (rápido). Sem o módulo nativo, o JS (forge) faz sozinho.
export const nativeKeys = requireOptionalNativeModule<{
  generateRsaPem(): Promise<string>;
  sign(pem: string, token: Uint8Array): Promise<Uint8Array>;
}>('TvKeys');

export function hasIrEmitter(): boolean {
  try {
    return ir?.hasEmitter() ?? false;
  } catch {
    return false;
  }
}

export function irCarrierRanges(): [number, number][] {
  try {
    return ir?.carrierRanges() ?? [];
  } catch {
    return [];
  }
}

// Devolve quantos ms o emissor levou para aceitar o sinal.
export function transmitIr(frequency: number, pattern: number[]): Promise<number> {
  if (!ir) return Promise.reject(new Error('Infravermelho indisponível neste app'));
  return ir.transmit(frequency, pattern);
}

export function btSupported(): boolean {
  try {
    return bt?.isSupported() ?? false;
  } catch {
    return false;
  }
}

// HTTP(S) para a API de controle remoto da Fire TV, aceitando o certificado próprio dela
// (só para endereços da rede local; o nativo recusa qualquer outro).
export const tvHttp = requireOptionalNativeModule<{
  request(
    method: string, url: string, headers: Record<string, string>, body: string | null, timeoutMs: number, pin: string | null,
  ): Promise<{ status: number; body: string; fingerprint: string | null }>;
}>('TvHttp');
