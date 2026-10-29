import { Buffer } from 'buffer';

// O Hermes tem TextEncoder, mas nem sempre TextDecoder; o núcleo ADB/APK usa os dois.
const g = globalThis as { TextDecoder?: unknown; Buffer?: unknown };

if (typeof g.TextDecoder === 'undefined') {
  g.TextDecoder = class {
    decode(input?: Uint8Array) {
      if (!input) return '';
      return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('utf8');
    }
  };
}

// react-native-tcp-socket entrega os dados como Buffer.
if (typeof g.Buffer === 'undefined') g.Buffer = Buffer;
