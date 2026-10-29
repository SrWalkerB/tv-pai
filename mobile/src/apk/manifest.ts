import type { Zip } from './zip';

// Leitura do AndroidManifest.xml binário (AXML) e do resources.arsc, o suficiente para descobrir
// pacote, nome, ícone e banner de um app. Substitui o `aapt`, que não existe no celular.

const RES_STRING_POOL = 0x0001;
const RES_TABLE = 0x0002;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_RESOURCE_MAP = 0x0180;
const RES_TABLE_PACKAGE = 0x0200;
const RES_TABLE_TYPE = 0x0201;

const ATTR_LABEL = 0x01010001;
const ATTR_ICON = 0x01010002;
const ATTR_BANNER = 0x010103f2;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;

type Value = { type: number; data: number; text?: string };

function readStringPool(v: DataView, start: number): string[] {
  const count = v.getUint32(start + 8, true);
  const flags = v.getUint32(start + 16, true);
  const stringsStart = start + v.getUint32(start + 20, true);
  const utf8 = (flags & 0x100) !== 0;
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  const dec8 = new TextDecoder('utf-8');
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = stringsStart + v.getUint32(start + 28 + i * 4, true);
    if (utf8) {
      // Dois comprimentos (em caracteres e em bytes), cada um com 1 ou 2 bytes.
      if (bytes[p] & 0x80) p += 2; else p += 1;
      let len = bytes[p];
      if (len & 0x80) { len = ((len & 0x7f) << 8) | bytes[p + 1]; p += 2; } else p += 1;
      out.push(dec8.decode(bytes.subarray(p, p + len)));
    } else {
      let len = v.getUint16(p, true);
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | v.getUint16(p + 2, true); p += 4; } else p += 2;
      let s = '';
      for (let k = 0; k < len; k++) s += String.fromCharCode(v.getUint16(p + k * 2, true));
      out.push(s);
    }
  }
  return out;
}

type ManifestInfo = { pkg: string | null; label: Value | null; icon: Value | null; banner: Value | null };

export function parseManifest(buf: Uint8Array): ManifestInfo {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const info: ManifestInfo = { pkg: null, label: null, icon: null, banner: null };
  let strings: string[] = [];
  let resMap: number[] = [];
  let p = v.getUint16(2, true);
  while (p + 8 <= buf.length) {
    const type = v.getUint16(p, true);
    const size = v.getUint32(p + 4, true);
    if (size <= 0) break;
    if (type === RES_STRING_POOL) strings = readStringPool(v, p);
    else if (type === RES_XML_RESOURCE_MAP) {
      resMap = [];
      for (let q = p + 8; q < p + size; q += 4) resMap.push(v.getUint32(q, true));
    } else if (type === RES_XML_START_ELEMENT) {
      const name = strings[v.getUint32(p + 20, true)];
      const attrStart = v.getUint16(p + 24, true);
      const attrSize = v.getUint16(p + 26, true);
      const attrCount = v.getUint16(p + 28, true);
      for (let a = 0; a < attrCount; a++) {
        const q = p + 16 + attrStart + a * attrSize;
        const nameIdx = v.getUint32(q + 4, true);
        const raw = v.getUint32(q + 8, true);
        const value: Value = { type: v.getUint8(q + 15), data: v.getUint32(q + 16, true) };
        if (value.type === TYPE_STRING) value.text = strings[value.data];
        else if (raw !== 0xffffffff) value.text = strings[raw];
        const resId = resMap[nameIdx];
        if (name === 'manifest' && strings[nameIdx] === 'package') info.pkg = value.text ?? null;
        if (name === 'application') {
          if (resId === ATTR_LABEL) info.label = value;
          else if (resId === ATTR_ICON) info.icon = value;
          else if (resId === ATTR_BANNER) info.banner = value;
        }
      }
      if (name === 'application') break;
    }
    p += size;
  }
  return info;
}

type Candidate = { lang: string; country: string; density: number; value: Value };

class ResourceTable {
  private globals: string[] = [];
  // typeId -> entryIndex -> valores por configuração
  private types = new Map<number, Map<number, Candidate[]>>();
  private packageId = 0x7f;

  constructor(buf: Uint8Array) {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (v.getUint16(0, true) !== RES_TABLE) throw new Error('resources.arsc inválido');
    let p = v.getUint16(2, true);
    while (p + 8 <= buf.length) {
      const type = v.getUint16(p, true);
      const size = v.getUint32(p + 4, true);
      if (size <= 0) break;
      if (type === RES_STRING_POOL) this.globals = readStringPool(v, p);
      else if (type === RES_TABLE_PACKAGE) this.readPackage(v, p, size);
      p += size;
    }
  }

  private readPackage(v: DataView, start: number, size: number) {
    this.packageId = v.getUint32(start + 8, true);
    let p = start + v.getUint16(start + 2, true);
    while (p + 8 <= start + size) {
      const type = v.getUint16(p, true);
      const chunkSize = v.getUint32(p + 4, true);
      if (chunkSize <= 0) break;
      if (type === RES_TABLE_TYPE) this.readType(v, p);
      p += chunkSize;
    }
  }

  private readType(v: DataView, start: number) {
    const headerSize = v.getUint16(start + 2, true);
    const typeId = v.getUint8(start + 8);
    const flags = v.getUint8(start + 9);
    const entryCount = v.getUint32(start + 12, true);
    const entriesStart = start + v.getUint32(start + 16, true);
    const cfg = start + 20;
    const cfgSize = v.getUint32(cfg, true);
    const lang = cfgSize >= 12 ? String.fromCharCode(v.getUint8(cfg + 8), v.getUint8(cfg + 9)).replace(/\0/g, '') : '';
    const country = cfgSize >= 12 ? String.fromCharCode(v.getUint8(cfg + 10), v.getUint8(cfg + 11)).replace(/\0/g, '') : '';
    const density = cfgSize >= 16 ? v.getUint16(cfg + 14, true) : 0;
    const sparse = (flags & 0x01) !== 0;
    const offset16 = (flags & 0x02) !== 0;

    let table = this.types.get(typeId);
    if (!table) this.types.set(typeId, (table = new Map()));
    const offsets = start + headerSize;
    for (let i = 0; i < entryCount; i++) {
      let index = i;
      let off: number;
      if (sparse) {
        index = v.getUint16(offsets + i * 4, true);
        off = v.getUint16(offsets + i * 4 + 2, true) * 4;
      } else if (offset16) {
        const raw = v.getUint16(offsets + i * 2, true);
        if (raw === 0xffff) continue;
        off = raw * 4;
      } else {
        off = v.getUint32(offsets + i * 4, true);
        if (off === 0xffffffff) continue;
      }
      const e = entriesStart + off;
      const entryFlags = v.getUint16(e + 2, true);
      let value: Value;
      if (entryFlags & 0x0008) {
        // Entrada compacta: o tipo do valor fica no byte alto das flags.
        value = { type: entryFlags >> 8, data: v.getUint32(e + 4, true) };
      } else {
        if (entryFlags & 0x0001) continue; // valor complexo (estilo, array): não interessa aqui
        const vs = e + v.getUint16(e, true);
        value = { type: v.getUint8(vs + 3), data: v.getUint32(vs + 4, true) };
      }
      if (value.type === TYPE_STRING) value.text = this.globals[value.data];
      let list = table.get(index);
      if (!list) table.set(index, (list = []));
      list.push({ lang, country, density, value });
    }
  }

  candidates(id: number, depth = 0): Candidate[] {
    if (depth > 5 || id >>> 24 !== this.packageId) return [];
    const list = this.types.get((id >> 16) & 0xff)?.get(id & 0xffff) ?? [];
    const out: Candidate[] = [];
    for (const c of list) {
      if (c.value.type === TYPE_REFERENCE) {
        for (const r of this.candidates(c.value.data, depth + 1)) out.push({ ...r, lang: r.lang || c.lang, country: r.country || c.country });
      } else out.push(c);
    }
    return out;
  }
}

const IMAGE = /\.(png|webp|jpe?g)$/i;

function bestImage(table: ResourceTable, value: Value | null): string | null {
  if (!value) return null;
  if (value.type !== TYPE_REFERENCE) return value.text && IMAGE.test(value.text) ? value.text : null;
  const score = (d: number) => (d === 0 || d === 0xffff ? 160 : d === 0xfffe ? -1 : d);
  const images = table.candidates(value.data)
    .filter((c) => c.value.text && IMAGE.test(c.value.text) && !c.lang)
    .sort((a, b) => score(b.density) - score(a.density));
  return images[0]?.value.text ?? null;
}

function bestLabel(table: ResourceTable | null, value: Value | null): string | null {
  if (!value) return null;
  if (value.type !== TYPE_REFERENCE) return value.text ?? null;
  if (!table) return null;
  const strings = table.candidates(value.data).filter((c) => c.value.text);
  const pick = strings.find((c) => c.lang === 'pt' && c.country === 'BR')
    || strings.find((c) => c.lang === 'pt')
    || strings.find((c) => !c.lang)
    || strings[0];
  return pick?.value.text ?? null;
}

export type AppInfo = { pkg: string | null; label: string | null; banner: string | null; icon: string | null };

export async function readAppInfo(zip: Zip): Promise<AppInfo> {
  const manifest = parseManifest(await zip.file('AndroidManifest.xml'));
  const table = zip.entries.has('resources.arsc') ? new ResourceTable(await zip.file('resources.arsc')) : null;
  return {
    pkg: manifest.pkg,
    label: bestLabel(table, manifest.label),
    banner: table ? bestImage(table, manifest.banner) : null,
    icon: table ? bestImage(table, manifest.icon) : null,
  };
}
