// Cliente ADB pela rede (protocolo de transporte do adbd) em TypeScript puro.
// Não depende de React Native: recebe o socket TCP pronto, então roda igual no Node (testes) e no celular.

export type Transport = {
  write(data: Uint8Array): void;
  onData(cb: (data: Uint8Array) => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): void;
};

export type AdbKey = {
  // Assina o token de 20 bytes do AUTH (PKCS#1 v1.5 com DigestInfo SHA-1).
  sign(token: Uint8Array): Uint8Array | Promise<Uint8Array>;
  // Chave pública no formato do Android (base64 + " nome"), enviada quando a TV ainda não conhece a chave.
  publicKey(): string;
};

const A_CNXN = 0x4e584e43;
const A_AUTH = 0x48545541;
const A_OPEN = 0x4e45504f;
const A_OKAY = 0x59414b4f;
const A_CLSE = 0x45534c43;
const A_WRTE = 0x45545257;

const AUTH_TOKEN = 1;
const AUTH_SIGNATURE = 2;
const AUTH_RSAPUBLICKEY = 3;

const VERSION = 0x01000000;
const MAX_DATA = 256 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function text(b: Uint8Array): string {
  return decoder.decode(b);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

type Packet = { command: number; arg0: number; arg1: number; data: Uint8Array };

function encodePacket(command: number, arg0: number, arg1: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(24 + data.length);
  const view = new DataView(out.buffer);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum = (sum + data[i]) >>> 0;
  view.setUint32(0, command, true);
  view.setUint32(4, arg0 >>> 0, true);
  view.setUint32(8, arg1 >>> 0, true);
  view.setUint32(12, data.length, true);
  view.setUint32(16, sum, true);
  view.setUint32(20, (command ^ 0xffffffff) >>> 0, true);
  out.set(data, 24);
  return out;
}

export class AdbStream {
  remoteId = 0;
  closed = false;
  private chunks: Uint8Array[] = [];
  private dataListeners: ((d: Uint8Array) => void)[] = [];
  private closeListeners: (() => void)[] = [];
  private ready: (() => void) | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private client: AdbClient, readonly localId: number) {}

  onData(cb: (d: Uint8Array) => void) {
    this.dataListeners.push(cb);
    for (const c of this.chunks.splice(0)) cb(c);
  }

  onClose(cb: () => void) {
    if (this.closed) cb();
    else this.closeListeners.push(cb);
  }

  // Cada WRTE precisa esperar o OKAY da TV antes do próximo (controle de fluxo do adbd).
  write(data: Uint8Array): Promise<void> {
    const job = async () => {
      for (let off = 0; off < data.length; off += this.client.maxPayload) {
        if (this.closed) throw new Error('Conexão com a TV fechada');
        const part = data.subarray(off, off + this.client.maxPayload);
        await new Promise<void>((resolve) => {
          // Conexão morta sem aviso (Wi-Fi caiu, celular dormiu) nunca manda o OKAY: o vigia derruba
          // tudo para quem espera receber erro e o app reconectar, em vez de travar para sempre.
          const stop = this.client.watch();
          this.ready = () => { stop(); resolve(); };
          this.client.send(A_WRTE, this.localId, this.remoteId, part);
        });
      }
    };
    this.writeChain = this.writeChain.then(job, job);
    return this.writeChain;
  }

  close() {
    if (this.closed) return;
    this.client.send(A_CLSE, this.localId, this.remoteId);
    this.finish();
  }

  /** @internal */
  handleOkay() {
    const r = this.ready;
    this.ready = null;
    r?.();
  }

  /** @internal */
  handleData(d: Uint8Array) {
    if (this.dataListeners.length) for (const cb of this.dataListeners) cb(d);
    else this.chunks.push(d);
  }

  /** @internal */
  finish() {
    if (this.closed) return;
    this.closed = true;
    this.handleOkay();
    for (const cb of this.closeListeners.splice(0)) cb();
  }
}

export type ConnectOptions = {
  // Chamado quando a TV mostra "Permitir depuração?" e espera alguém aceitar no controle.
  onAuthPrompt?: () => void;
  timeoutMs?: number;
};

export class AdbClient {
  maxPayload = 4096;
  connected = false;
  private buf: Uint8Array = new Uint8Array(0);
  private streams = new Map<number, AdbStream>();
  private pendingOpen = new Map<number, { resolve: (s: AdbStream) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private authStage: 'signature' | 'publickey' | 'done' = 'signature';
  private onConnect: (() => void) | null = null;
  private onFail: ((e: Error) => void) | null = null;
  private closeListeners: ((err?: Error) => void)[] = [];
  private opts: ConnectOptions = {};
  private extendTimeout: (() => void) | null = null;
  private lastRx = Date.now();

  constructor(private transport: Transport, private key: AdbKey) {
    transport.onData((d) => this.receive(d));
    transport.onClose((err) => this.teardown(err || new Error('A TV fechou a conexão')));
  }

  onClose(cb: (err?: Error) => void) {
    this.closeListeners.push(cb);
  }

  connect(opts: ConnectOptions = {}): Promise<void> {
    this.opts = opts;
    return new Promise((resolve, reject) => {
      let timer = setTimeout(() => reject(new Error('A TV não respondeu a tempo')), opts.timeoutMs ?? 10000);
      this.extendTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(() => reject(new Error('Ninguém aceitou o pedido de depuração na TV')), 90000);
      };
      this.onConnect = () => { clearTimeout(timer); resolve(); };
      this.onFail = (e) => { clearTimeout(timer); reject(e); };
      this.send(A_CNXN, VERSION, MAX_DATA, utf8('host::\0'));
    });
  }

  send(command: number, arg0: number, arg1: number, data?: Uint8Array) {
    this.transport.write(encodePacket(command, arg0, arg1, data));
  }

  open(service: string): Promise<AdbStream> {
    if (!this.connected) return Promise.reject(new Error('Não conectado à TV'));
    const id = this.nextId++;
    const stream = new AdbStream(this, id);
    this.streams.set(id, stream);
    return new Promise((resolve, reject) => {
      const stop = this.watch();
      this.pendingOpen.set(id, {
        resolve: (s) => { stop(); resolve(s); },
        reject: (e) => { stop(); reject(e); },
      });
      this.send(A_OPEN, id, 0, utf8(service + '\0'));
    });
  }

  // Roda um comando sem terminal (serviço exec:) e devolve toda a saída em bytes.
  async exec(command: string): Promise<Uint8Array> {
    const stream = await this.open('exec:' + command);
    return new Promise((resolve) => {
      const parts: Uint8Array[] = [];
      stream.onData((d) => parts.push(d));
      stream.onClose(() => resolve(concat(parts)));
    });
  }

  async shell(command: string): Promise<string> {
    return text(await this.exec(command));
  }

  // Vigia de conexão morta: enquanto alguém espera uma resposta, se a TV passar `ms` sem mandar
  // NADA, o socket morreu sem avisar e a conexão é fechada. Resposta lenta não conta: com ícones ou
  // tela chegando, a resposta de um comando novo vem atrás de megabytes, mas os pacotes continuam vindo.
  /** @internal */
  watch(ms = 5000): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const idle = Date.now() - this.lastRx;
      if (idle >= ms) this.close();
      else timer = setTimeout(check, ms - idle);
    };
    timer = setTimeout(check, ms);
    return () => clearTimeout(timer);
  }

  close() {
    this.transport.close();
    this.teardown(new Error('Conexão encerrada'));
  }

  private teardown(err: Error) {
    const wasConnected = this.connected;
    this.connected = false;
    this.onFail?.(err);
    this.onFail = null;
    for (const p of this.pendingOpen.values()) p.reject(err);
    this.pendingOpen.clear();
    for (const s of this.streams.values()) s.finish();
    this.streams.clear();
    if (wasConnected) for (const cb of this.closeListeners) cb(err);
  }

  private receive(chunk: Uint8Array) {
    this.lastRx = Date.now();
    this.buf = this.buf.length ? concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 24) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const len = view.getUint32(12, true);
      if (this.buf.length < 24 + len) break;
      const packet: Packet = {
        command: view.getUint32(0, true),
        arg0: view.getUint32(4, true),
        arg1: view.getUint32(8, true),
        data: this.buf.slice(24, 24 + len),
      };
      this.buf = this.buf.subarray(24 + len);
      this.handle(packet);
    }
  }

  private handle(p: Packet) {
    switch (p.command) {
      case A_AUTH: {
        if (p.arg0 !== AUTH_TOKEN) return;
        if (this.authStage === 'signature') {
          this.authStage = 'publickey';
          Promise.resolve(this.key.sign(p.data))
            .then((sig) => this.send(A_AUTH, AUTH_SIGNATURE, 0, sig))
            .catch((err: Error) => this.onFail?.(err));
        } else if (this.authStage === 'publickey') {
          // A TV não reconheceu a assinatura: manda a chave pública e espera alguém aceitar na tela.
          this.authStage = 'done';
          this.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, utf8(this.key.publicKey() + '\0'));
          this.extendTimeout?.();
          this.opts.onAuthPrompt?.();
        }
        return;
      }
      case A_CNXN: {
        this.maxPayload = Math.min(p.arg1 || 4096, MAX_DATA);
        this.connected = true;
        this.onConnect?.();
        this.onConnect = null;
        this.onFail = null;
        return;
      }
      case A_OKAY: {
        const localId = p.arg1;
        const pending = this.pendingOpen.get(localId);
        const stream = this.streams.get(localId);
        if (!stream) return;
        if (pending) {
          stream.remoteId = p.arg0;
          this.pendingOpen.delete(localId);
          pending.resolve(stream);
        } else {
          stream.handleOkay();
        }
        return;
      }
      case A_WRTE: {
        const stream = this.streams.get(p.arg1);
        if (!stream) return;
        this.send(A_OKAY, stream.localId, p.arg0);
        stream.handleData(p.data);
        return;
      }
      case A_CLSE: {
        const localId = p.arg1;
        const pending = this.pendingOpen.get(localId);
        if (pending) {
          this.pendingOpen.delete(localId);
          pending.reject(new Error('A TV recusou o comando'));
        }
        const stream = this.streams.get(localId);
        if (stream) {
          this.streams.delete(localId);
          if (!stream.closed) this.send(A_CLSE, localId, p.arg0);
          stream.finish();
        }
        return;
      }
    }
  }
}

// Envia um arquivo para a TV pelo serviço sync: (o mesmo que `adb push` usa).
export async function push(
  client: AdbClient,
  data: Uint8Array | ((offset: number, length: number) => Promise<Uint8Array>),
  size: number,
  remotePath: string,
  onProgress?: (sent: number) => void,
  // Consultado entre os pedaços: se devolver true, o envio para e o push lança "Envio cancelado".
  isCancelled?: () => boolean,
): Promise<void> {
  const stream = await client.open('sync:');
  const replies: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  stream.onData((d) => { replies.push(d); wake?.(); });
  stream.onClose(() => wake?.());

  const header = (id: string, n: number) => {
    const b = new Uint8Array(8);
    b.set(utf8(id), 0);
    new DataView(b.buffer).setUint32(4, n, true);
    return b;
  };

  const target = utf8(`${remotePath},${0o644}`);
  await stream.write(concat([header('SEND', target.length), target]));

  const CHUNK = 64 * 1024;
  for (let off = 0; off < size; off += CHUNK) {
    if (isCancelled?.()) {
      stream.close();
      throw new Error('Envio cancelado');
    }
    const len = Math.min(CHUNK, size - off);
    const part = typeof data === 'function' ? await data(off, len) : data.subarray(off, off + len);
    await stream.write(concat([header('DATA', part.length), part]));
    onProgress?.(off + part.length);
  }
  await stream.write(header('DONE', Math.floor(Date.now() / 1000)));

  while (true) {
    const all = concat(replies);
    if (all.length >= 8) {
      const id = text(all.subarray(0, 4));
      if (id === 'OKAY') break;
      if (id === 'FAIL') {
        const n = new DataView(all.buffer, all.byteOffset).getUint32(4, true);
        if (all.length >= 8 + n) {
          stream.close();
          throw new Error(`A TV recusou o arquivo: ${text(all.subarray(8, 8 + n))}`);
        }
      }
    }
    if (stream.closed) throw new Error('A TV fechou a conexão durante o envio');
    await new Promise<void>((r) => (wake = r));
  }
  await stream.write(header('QUIT', 0));
  stream.close();
}
