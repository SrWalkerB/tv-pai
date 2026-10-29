import forge from 'node-forge';
import type { AdbKey } from './protocol';

function toBinary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function fromBinary(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// Formato RSAPublicKey do adbd: tamanho em palavras, n0inv, módulo, R² mod n e expoente,
// tudo em palavras de 32 bits little-endian. Depois vira base64 + " nome".
function androidPublicKey(key: forge.pki.rsa.PublicKey, name: string): string {
  const WORDS = 64;
  const n = BigInt('0x' + key.n.toString(16));
  const e = Number(key.e.toString());
  const two32 = 1n << 32n;

  const n0 = n % two32;
  let inv = n0;
  for (let i = 0; i < 5; i++) inv = (inv * (2n - n0 * inv)) % two32;
  const n0inv = (two32 - ((inv % two32) + two32) % two32) % two32;

  const rr = (1n << BigInt(WORDS * 32 * 2)) % n;

  const out = new Uint8Array(4 + 4 + WORDS * 4 * 2 + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, WORDS, true);
  view.setUint32(4, Number(n0inv), true);
  let nn = n;
  let r = rr;
  for (let i = 0; i < WORDS; i++) {
    view.setUint32(8 + i * 4, Number(nn % two32), true);
    view.setUint32(8 + WORDS * 4 + i * 4, Number(r % two32), true);
    nn >>= 32n;
    r >>= 32n;
  }
  view.setUint32(8 + WORDS * 8, e, true);
  return forge.util.encode64(toBinary(out)) + ' ' + name;
}

export function keyFromPem(
  pem: string,
  name = 'tvpai@celular',
  // No celular a assinatura RSA vai para o código nativo (o forge em JS puro é lento demais no Hermes).
  nativeSign?: (pem: string, token: Uint8Array) => Promise<Uint8Array>,
): AdbKey {
  const priv = forge.pki.privateKeyFromPem(pem) as forge.pki.rsa.PrivateKey;
  const pub = forge.pki.setRsaPublicKey(priv.n, priv.e);
  const pubText = androidPublicKey(pub, name);
  // O lado nativo lê PKCS#8; chaves geradas pelo forge vêm em PKCS#1 ("RSA PRIVATE KEY").
  const pkcs8 = nativeSign ? forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(priv))) : '';
  return {
    sign(token) {
      if (nativeSign) return nativeSign(pkcs8, token);
      // O token já é tratado como o "hash": só embrulhamos no DigestInfo de SHA-1, como o adb faz.
      const md = { algorithm: 'sha1', digest: () => forge.util.createBuffer(toBinary(token)) };
      return fromBinary(priv.sign(md as unknown as forge.md.MessageDigest));
    },
    publicKey: () => pubText,
  };
}

// Gera a chave sem travar a interface: o forge faz o trabalho em pedaços pequenos.
export function generatePem(): Promise<string> {
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001, workers: -1 }, (err, pair) => {
      if (err) reject(err);
      else resolve(forge.pki.privateKeyToPem(pair.privateKey));
    });
  });
}

// O PRNG do forge precisa de entropia de verdade no celular (o Hermes não tem crypto.getRandomValues).
export function seedRandom(bytes: Uint8Array) {
  (forge.random as unknown as { collect(seed: string): void }).collect(toBinary(bytes));
}
