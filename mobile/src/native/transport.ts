import TcpSocket from 'react-native-tcp-socket';
import type { Transport } from '../adb/protocol';

export function tcpTransport(host: string, port: number): Promise<Transport> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = TcpSocket.createConnection({ host, port, connectTimeout: 4000 }, () => {
      settled = true;
      sock.setNoDelay(true);
      resolve({
        write: (d) => { sock.write(d); },
        onData: (cb) => {
          sock.on('data', (b) => {
            const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
            cb(bytes);
          });
        },
        onClose: (cb) => {
          sock.on('close', () => cb());
          sock.on('error', (e) => cb(e instanceof Error ? e : new Error(String(e))));
        },
        close: () => { sock.destroy(); },
      });
    });
    sock.once('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}
