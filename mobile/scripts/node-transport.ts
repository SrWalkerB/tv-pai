// Transporte TCP do Node para testar o núcleo do app contra a TV sem precisar do celular.
import net from 'node:net';
import type { Transport } from '../src/adb/protocol';

export function nodeTransport(host: string, port = 5555): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port }, () => {
      resolve({
        write: (d) => { sock.write(d); },
        onData: (cb) => { sock.on('data', (b: Buffer) => cb(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))); },
        onClose: (cb) => { sock.on('close', () => cb()); sock.on('error', (e) => cb(e)); },
        close: () => sock.destroy(),
      });
    });
    sock.once('error', reject);
  });
}
