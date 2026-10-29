import { inflateRaw } from 'pako';

// Leitor de zip que só busca os pedaços necessários. A mesma lógica serve para um APK na TV
// (lido por `dd` via ADB) e para um APK no celular (lido do arquivo escolhido).
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

export type ZipEntry = { name: string; method: number; compSize: number; offset: number };

export class Zip {
  private constructor(private read: RangeReader, readonly entries: Map<string, ZipEntry>) {}

  static async open(read: RangeReader, size: number): Promise<Zip> {
    const tailLen = Math.min(size, 65557);
    const tail = await read(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('O arquivo não é um APK válido');
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const cdSize = tv.getUint32(eocd + 12, true);
    const cdOff = tv.getUint32(eocd + 16, true);
    const cd = await read(cdOff, cdSize);
    const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const decoder = new TextDecoder();
    const entries = new Map<string, ZipEntry>();
    for (let p = 0; p + 46 <= cd.length && v.getUint32(p, true) === 0x02014b50;) {
      const nameLen = v.getUint16(p + 28, true);
      const extraLen = v.getUint16(p + 30, true);
      const commentLen = v.getUint16(p + 32, true);
      const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));
      entries.set(name, {
        name,
        method: v.getUint16(p + 10, true),
        compSize: v.getUint32(p + 20, true),
        offset: v.getUint32(p + 42, true),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new Zip(read, entries);
  }

  async file(name: string): Promise<Uint8Array> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`${name} não está no APK`);
    const header = await this.read(e.offset, 30);
    const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const dataOff = e.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    const data = await this.read(dataOff, e.compSize);
    return e.method === 8 ? inflateRaw(data) : data;
  }
}
