import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';
import { bt, btSupported, discovery, hasIrEmitter, transmitIr, tvHttp, type BtDevice, type FoundTv } from '../modules/tv-native';
import * as Application from 'expo-application';
import { FireTvNetwork, type DeviceInfo, type TvApp } from './tv/network';
import { FireTvRemote, NeedsPairingError } from './tv/remoteApi';
import { KEYS, hidForChar, supports, type Channel, type KeyName } from './tv/keys';
import { IR_FREQUENCY, NEC_PERIOD_MS, lgPattern, type IrStyle } from './ir/lg';
import { Zip } from './apk/zip';
import { readAppInfo } from './apk/manifest';
import { tcpTransport } from './native/transport';
import {
  fileReader, forgetArt, loadArtMeta, loadOrCreateKey, loadSettings, saveArt, saveScreenshot, saveSettings,
  type ArtMeta, type Settings,
} from './native/storage';
import type { AdbKey } from './adb/protocol';

export type NetStatus = 'off' | 'connecting' | 'auth' | 'on' | 'error';
// API de controle remoto (padrão): 'pin' = a TV está mostrando o PIN e esperamos a pessoa digitar.
export type RemoteStatus = 'off' | 'connecting' | 'pin' | 'on' | 'error';
export type Target = 'firestick' | 'tv';
export type Transfer = {
  label: string;
  pkg: string | null;
  sent: number;
  total: number;
  phase: 'sending' | 'installing' | 'done' | 'cancelled' | 'error';
  message: string | null;
};
export type AppItem = TvApp & { art: string | null };

// A Firestick aparece no Bluetooth com nomes como "Fire TV de Walker" ou o modelo (AFTMM).
const FIRE_NAME = /fire\s?tv|^aft|amazon/i;

async function askBluetoothPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const perms = Platform.Version >= 31
    ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT, PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(perms);
  return perms.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED);
}

// Registro do infravermelho, para a pessoa ver o que de fato saiu do celular.
// airMs: duração do sinal no ar. emitMs: quanto o emissor do celular segurou a chamada.
export type IrEvent = {
  id: number; at: number; key: KeyName; result: 'sent' | 'dropped' | 'error'; why?: string; airMs?: number; emitMs?: number;
};
export type IrStats = { sent: number; dropped: number; errors: number; queued: number; sending: boolean };
const IR_ZERO: IrStats = { sent: 0, dropped: 0, errors: 0, queued: 0, sending: false };

// Toques que esperam enquanto um sinal sai. O infravermelho é lento (~240 ms no sinal duplo), então
// guarda até 3 toques; os outros caminhos guardam 1. Toque além disso é descartado (e contado).
const QUEUE_IR = 3;
const QUEUE_OTHER = 1;
// Segurando volume ou canal pelo infravermelho: no máximo 10 passos por vez, para nunca disparar sozinho.
const HOLD_MAX_IR_LEVEL = 10;
const HOLD_MAX_IR = 25;

// Tempo máximo de uma tecla na fila. Se a TV não responder, a fila é liberada e as próximas teclas
// voltam a funcionar (antes, uma conexão morta travava o controle até reiniciar o app).
const KEY_DEADLINE_MS = 8000;

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('A TV demorou para responder. Tente de novo; se continuar, reconecte em Dispositivos.')), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

function irAirtime(pattern: number[]): number {
  return Math.max(NEC_PERIOD_MS, pattern.reduce((a, b) => a + b, 0) / 1000) + 20;
}

export function useTv() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [preparing, setPreparing] = useState<string | null>('Abrindo…');
  const [net, setNet] = useState<NetStatus>('off');
  const [netError, setNetError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [target, setTargetState] = useState<Target>('firestick');
  const [apps, setApps] = useState<AppItem[]>([]);
  const [currentPkg, setCurrentPkg] = useState<string | null>(null);
  const [irAvailable] = useState(() => hasIrEmitter());
  const [btAvailable] = useState(() => btSupported());
  const [btEnabled, setBtEnabled] = useState(false);
  const [btReady, setBtReady] = useState(false);
  const [btHost, setBtHost] = useState<BtDevice | null>(null);
  const [btDevices, setBtDevices] = useState<BtDevice[]>([]);
  const [btScanning, setBtScanning] = useState(false);
  const [btError, setBtError] = useState<string | null>(null);
  const [btPairing, setBtPairing] = useState<'idle' | 'working' | 'bonding' | 'failed'>('idle');
  const [found, setFound] = useState<FoundTv[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [irLog, setIrLog] = useState<IrEvent[]>([]);
  const [irStats, setIrStats] = useState<IrStats>(IR_ZERO);
  const irSeq = useRef(0);

  const [remote, setRemote] = useState<RemoteStatus>('off');
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const remoteRef = useRef<FireTvRemote | null>(null);

  const keyRef = useRef<AdbKey | null>(null);
  const tvRef = useRef<FireTvNetwork | null>(null);
  const artRef = useRef<Record<string, ArtMeta>>(loadArtMeta());
  const settingsRef = useRef<Settings | null>(null);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...(settingsRef.current as Settings), ...patch };
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
  }, []);

  const setTarget = useCallback((t: Target) => {
    setTargetState(t);
    updateSettings({ target: t });
  }, [updateSettings]);

  // ---------- Rede (ADB) ----------

  const withArt = useCallback((list: TvApp[]): AppItem[] => list.map((a) => ({ ...a, art: artRef.current[a.pkg]?.file ?? null })), []);

  const refreshArt = useCallback(async (list: TvApp[]) => {
    const tv = tvRef.current;
    if (!tv) return;
    for (const app of list) {
      if (!tv.connected) return;
      try {
        const remote = await tv.apkRemote(app.pkg);
        if (!remote) continue;
        if (artRef.current[app.pkg]?.key === remote.key) continue;
        const info = await readAppInfo(remote.zip);
        const name = info.banner || info.icon;
        const image = name && remote.zip.entries.has(name) ? await remote.zip.file(name) : null;
        saveArt(artRef.current, app.pkg, remote.key, info.label, image, name);
        setApps((prev) => prev.map((p) => (p.pkg === app.pkg ? { ...p, art: artRef.current[app.pkg].file, label: p.label === app.pkg ? info.label || p.label : p.label } : p)));
      } catch {
        // um APK estranho não deve impedir os outros
      }
    }
  }, []);

  const loadApps = useCallback(async () => {
    const tv = tvRef.current;
    if (!tv?.connected) return;
    const list = await tv.listApps((pkg) => artRef.current[pkg]?.label);
    setApps(withArt(list));
    refreshArt(list);
  }, [withArt, refreshArt]);

  // Reconexão automática: quando a conexão cai com o app aberto, tenta de novo com intervalos crescentes.
  const retryRef = useRef<{ attempt: number; timer?: ReturnType<typeof setTimeout> }>({ attempt: 0 });
  const pausedRef = useRef(false);
  const connectRef = useRef<(host?: string, name?: string, silent?: boolean) => Promise<void>>(async () => {});
  const [reconnecting, setReconnecting] = useState(false);

  const scheduleReconnect = useCallback(() => {
    const r = retryRef.current;
    clearTimeout(r.timer);
    if (pausedRef.current || !settingsRef.current?.adb || !settingsRef.current?.host || r.attempt >= 8) { setReconnecting(false); return; }
    const delay = [1, 2, 4, 8, 15][Math.min(r.attempt, 4)] * 1000;
    r.attempt++;
    setReconnecting(true);
    r.timer = setTimeout(() => connectRef.current(undefined, undefined, true), delay);
  }, []);

  const connectNetwork = useCallback(async (host?: string, name?: string, silent = false) => {
    const key = keyRef.current;
    if (!key) return;
    const target = (host ?? settingsRef.current?.host ?? '').trim();
    if (!target) return;
    clearTimeout(retryRef.current.timer);
    tvRef.current?.disconnect();
    setNet('connecting');
    setNetError(null);
    const tv = new FireTvNetwork(target, key, tcpTransport);
    tv.onClose(() => {
      if (tvRef.current !== tv) return;
      setNet('off');
      if (!pausedRef.current) scheduleReconnect();
    });
    try {
      await tv.connect(() => setNet('auth'));
      tvRef.current = tv;
      retryRef.current.attempt = 0;
      setReconnecting(false);
      setNet('on');
      if (host) updateSettings({ host: target, ...(name ? { tvName: name } : {}) });
      loadApps().catch(() => {});
      tv.currentApp().then(setCurrentPkg).catch(() => {});
    } catch (err) {
      setNet('error');
      setNetError((err as Error).message);
      if (silent) scheduleReconnect();
    }
  }, [loadApps, updateSettings, scheduleReconnect]);

  useEffect(() => { connectRef.current = connectNetwork; }, [connectNetwork]);

  // O Android congela o app em segundo plano e a conexão morre sem aviso, mas a Firestick (que aceita
  // só uma conexão) continua segurando a vaga. Então: ao sair do app, fecha a conexão direitinho;
  // ao voltar, reconecta sozinho (a chave já está autorizada, leva menos de 1 segundo).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        pausedRef.current = true;
        clearTimeout(retryRef.current.timer);
        setReconnecting(false);
        const tv = tvRef.current;
        tvRef.current = null;
        tv?.disconnect();
        setNet('off');
      } else if (state === 'active' && pausedRef.current) {
        pausedRef.current = false;
        retryRef.current.attempt = 0;
        if (settingsRef.current?.adb && settingsRef.current?.host && keyRef.current) {
          setReconnecting(true);
          connectRef.current(undefined, undefined, true);
        }
      }
    });
    return () => sub.remove();
  }, []);

  // ---------- Conexão padrão: API de controle remoto da Fire TV (PIN) ----------

  const loadRemoteApps = useCallback(async () => {
    const r = remoteRef.current;
    if (!r || tvRef.current?.connected) return; // com o modo avançado, a lista vem do ADB (tem mais detalhes)
    const list = await r.apps();
    setApps(list.map((a) => ({ pkg: a.pkg, activity: '', tv: true, removable: false, label: a.label, art: a.icon })));
  }, []);

  // Conecta pela API. Com token salvo, só confere; sem token (ou recusado), pede o PIN na TV.
  const connectRemote = useCallback(async (host?: string, name?: string) => {
    const target = (host ?? settingsRef.current?.host ?? '').trim();
    if (!target) return;
    if (!tvHttp) { setRemote('error'); setRemoteError('Esta versão do app não tem a conexão pela rede.'); return; }
    if (host) updateSettings({ host: target, ...(name ? { tvName: name } : {}) });
    const r = new FireTvRemote(
      target, tvHttp.request,
      settingsRef.current?.tokens?.[target] ?? null,
      settingsRef.current?.pins?.[target] ?? null,
    );
    remoteRef.current = r;
    setRemote('connecting');
    setRemoteError(null);
    try {
      if (r.token) {
        try {
          await r.status();
          // Pareado antes do pinning existir: fixa o certificado agora, no primeiro contato.
          if (r.pin && !settingsRef.current?.pins?.[target]) {
            updateSettings({ pins: { ...(settingsRef.current?.pins ?? {}), [target]: r.pin } });
          }
          setRemote('on');
          loadRemoteApps().catch(() => {});
          return;
        } catch (err) {
          if (!(err instanceof NeedsPairingError)) throw err;
        }
      }
      await r.showPin('Controle da TV');
      setRemote('pin');
    } catch (err) {
      setRemote('error');
      setRemoteError(`Não achei a Firestick em ${target}. Confira se ela está ligada e no mesmo Wi-Fi.`);
      void err;
    }
  }, [updateSettings, loadRemoteApps]);

  const submitPin = useCallback(async (pin: string) => {
    const r = remoteRef.current;
    if (!r) return;
    setRemoteError(null);
    try {
      const token = await r.verifyPin(pin.trim());
      updateSettings({
        tokens: { ...(settingsRef.current?.tokens ?? {}), [r.host]: token },
        ...(r.pin ? { pins: { ...(settingsRef.current?.pins ?? {}), [r.host]: r.pin } } : {}),
      });
      setRemote('on');
      loadRemoteApps().catch(() => {});
    } catch (err) {
      setRemoteError((err as Error).message);
    }
  }, [updateSettings, loadRemoteApps]);

  const resendPin = useCallback(async () => {
    const r = remoteRef.current;
    if (!r) return;
    setRemoteError(null);
    await r.showPin('Controle da TV').catch((e: Error) => setRemoteError(e.message));
  }, []);

  // A TV esqueceu o pareamento (reset, por exemplo): volta para a tela do PIN sozinho.
  const handleRemoteError = useCallback((err: unknown) => {
    if (err instanceof NeedsPairingError) {
      setRemote('pin');
      remoteRef.current?.showPin('Controle da TV').catch(() => {});
      throw new Error('A TV pediu o PIN de novo. Digite o número que apareceu nela.');
    }
    throw err;
  }, []);

  // Lista de apps de onde estiver disponível: ADB (mais detalhes) ou a API da Amazon.
  const reloadApps = useCallback(
    () => (tvRef.current?.connected ? loadApps() : loadRemoteApps()),
    [loadApps, loadRemoteApps],
  );

  // Modo avançado (ADB): liga e desliga sob demanda.
  const setAdvanced = useCallback(async (on: boolean) => {
    updateSettings({ adb: on });
    if (on) await connectRef.current();
    else {
      clearTimeout(retryRef.current.timer);
      const tv = tvRef.current;
      tvRef.current = null;
      tv?.disconnect();
      setNet('off');
      setNetError(null);
      loadRemoteApps().catch(() => {});
    }
  }, [updateSettings, loadRemoteApps]);

  // ---------- Bluetooth ----------

  const listBonded = useCallback(() => {
    try {
      const bonded = (bt?.bondedDevices() ?? []).filter((d) => FIRE_NAME.test(d.name));
      setBtDevices((prev) => {
        const map = new Map(prev.map((d) => [d.address, d]));
        for (const d of bonded) map.set(d.address, d);
        return [...map.values()];
      });
    } catch {}
  }, []);

  const scanBluetooth = useCallback(() => {
    if (!bt || !bt.isEnabled()) return;
    listBonded();
    setBtScanning(true);
    bt.startScan();
    setTimeout(() => { bt?.stopScan(); setBtScanning(false); }, 12000);
  }, [listBonded]);

  const startBluetooth = useCallback(async () => {
    if (!bt || !btAvailable) return;
    setBtError(null);
    if (!(await askBluetoothPermissions())) { setBtError('Sem permissão de Bluetooth. Libere nas configurações do app.'); return; }
    if (!bt.isEnabled()) {
      // Pede para o sistema ligar o Bluetooth e espera o usuário responder.
      bt.requestEnable();
      for (let i = 0; i < 30 && !bt.isEnabled(); i++) await new Promise((r) => setTimeout(r, 500));
    }
    setBtEnabled(bt.isEnabled());
    if (!bt.isEnabled()) return;
    try {
      await bt.register();
      setBtReady(true);
    } catch (err) {
      setBtError((err as Error).message);
      return;
    }
    const saved = settingsRef.current?.btAddress;
    if (saved) bt.connect(saved);
    scanBluetooth();
  }, [btAvailable, scanBluetooth]);

  const connectBluetooth = useCallback((device: BtDevice) => {
    if (!bt) return;
    updateSettings({ btAddress: device.address });
    if (!bt.connect(device.address)) setBtError('Não deu para conectar. Pareie o celular pela TV primeiro.');
  }, [updateSettings]);

  // Primeira vez: a TV precisa procurar o celular. Se a rede estiver ligada, abrimos a tela certa na TV.
  const pairBluetoothViaTv = useCallback(async () => {
    if (!bt) return;
    bt.requestDiscoverable(120);
    if (tvRef.current?.connected) await tvRef.current.openBluetoothPairing().catch(() => {});
  }, []);

  // Com a rede ligada, o app lê o endereço Bluetooth da Firestick e o próprio celular pede o pareamento.
  // Sem rede, cai no caminho manual: o celular fica visível e a pessoa pareia pelos menus da TV.
  const pairBluetooth = useCallback(async () => {
    if (!bt) return;
    setBtError(null);
    if (!btReady) await startBluetooth();
    const tv = tvRef.current;
    if (!tv?.connected) { pairBluetoothViaTv(); return; }
    setBtPairing('working');
    try {
      const address = await tv.bluetoothAddress();
      if (!address) throw new Error('A TV não informou o endereço Bluetooth dela');
      updateSettings({ btAddress: address });
      if (!bt.pair(address)) throw new Error('O Bluetooth do celular recusou o pareamento');
    } catch (err) {
      setBtPairing('failed');
      setBtError(`${(err as Error).message}. Tente pelo caminho manual.`);
    }
  }, [btReady, startBluetooth, pairBluetoothViaTv, updateSettings]);

  // ---------- Descoberta ----------

  // Procura Fire TVs pela rede (mDNS, com o nome de verdade) e pelo Bluetooth ao mesmo tempo.
  const discover = useCallback((seconds = 8): Promise<FoundTv[]> => {
    return new Promise((resolve) => {
      if (!discovery) { resolve([]); return; }
      const seen = new Map<string, FoundTv>();
      setFound([]);
      setDiscovering(true);
      const sub = discovery.addListener('onTv', (tv) => {
        if (seen.has(tv.host)) return;
        seen.set(tv.host, tv);
        setFound([...seen.values()]);
      });
      discovery.start();
      if (bt?.isEnabled()) scanBluetooth();
      setTimeout(() => {
        discovery?.stop();
        sub.remove();
        setDiscovering(false);
        resolve([...seen.values()]);
      }, seconds * 1000);
    });
  }, [scanBluetooth]);

  useEffect(() => {
    if (!bt) return;
    const s3 = bt.addListener('onBond', (e) => {
      if (e.state === 'bonding') setBtPairing('bonding');
      else if (e.state === 'bonded') { setBtPairing('idle'); listBonded(); }
      else setBtPairing((p) => (p === 'idle' ? p : 'failed'));
    });
    return () => s3.remove();
  }, [listBonded]);

  useEffect(() => {
    if (!bt) return;
    const s1 = bt.addListener('onState', (e) => {
      if (e.state === 'connected') {
        setBtHost({ name: e.name, address: e.address, bonded: true });
        updateSettings({ btAddress: e.address });
      } else if (e.state === 'disconnected') setBtHost((h) => (h?.address === e.address ? null : h));
    });
    const s2 = bt.addListener('onDevice', (d) => {
      if (!FIRE_NAME.test(d.name)) return;
      setBtDevices((prev) => (prev.some((p) => p.address === d.address) ? prev : [...prev, d]));
    });
    return () => { s1.remove(); s2.remove(); };
  }, [updateSettings]);

  // ---------- Início ----------

  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      settingsRef.current = s;
      setSettings(s);
      if (s.target) setTargetState(s.target);
      keyRef.current = await loadOrCreateKey(() => setPreparing('Criando a chave de segurança do celular… (só na primeira vez)'));
      setPreparing(null);
      startBluetooth();
      if (s.host) {
        connectRemote();
        if (s.adb) connectNetwork();
      } else {
        // Primeira vez: procura sozinho e, se achar uma Firestick só, já pede o PIN na TV.
        const tvs = await discover();
        if (tvs.length === 1) connectRemote(tvs[0].host, tvs[0].name);
      }
    })();
    return () => tvRef.current?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A pessoa escolhe O QUE controlar (Firestick ou TV); o caminho é decidido aqui.
  // Firestick: API com PIN (padrão), ADB (modo avançado) e, sem rede, Bluetooth. TV: infravermelho LG.
  const firestickChannel: Channel | null = remote === 'on' ? 'remote' : net === 'on' ? 'network' : btHost ? 'bluetooth' : null;
  const activeTarget: Target = target === 'tv' && irAvailable ? 'tv' : 'firestick';
  const activeChannel: Channel = activeTarget === 'tv' ? 'ir' : firestickChannel ?? 'network';

  // Volume é sempre o da TV LG: no modo Firestick ele também sai pelo infravermelho quando o celular
  // tem emissor (pelo HDMI-CEC ficava lento). Assim só existe um volume para quem usa o controle.
  const channelFor = useCallback((key: KeyName): Channel => {
    const isVolume = key === 'volup' || key === 'voldown' || key === 'mute';
    if (isVolume && irAvailable) return 'ir';
    // Teclas que a API não tem (como Apagar) usam o ADB quando o modo avançado está ligado.
    if (activeChannel === 'remote' && !supports('remote', key) && net === 'on') return 'network';
    return activeChannel;
  }, [activeChannel, irAvailable, net]);

  // ---------- Ações ----------

  const logIr = useCallback((e: Omit<IrEvent, 'id' | 'at'>) => {
    const ev: IrEvent = { ...e, id: ++irSeq.current, at: Date.now() };
    setIrLog((l) => [ev, ...l].slice(0, 30));
    setIrStats((st) => ({
      ...st,
      sent: st.sent + (e.result === 'sent' ? 1 : 0),
      dropped: st.dropped + (e.result === 'dropped' ? 1 : 0),
      errors: st.errors + (e.result === 'error' ? 1 : 0),
    }));
  }, []);

  const resetIr = useCallback(() => { setIrLog([]); setIrStats((st) => ({ ...IR_ZERO, sending: st.sending, queued: st.queued })); }, []);

  // Um sinal de cada vez. No Xiaomi o transmit() pode devolver antes do sinal terminar de sair; se o
  // próximo começar antes, ele corta o anterior no meio e a TV perde os dois. Então esperamos o tempo no ar.
  const fireIr = useCallback(async (key: KeyName, style: IrStyle, why?: string) => {
    const ir = KEYS[key].ir;
    if (!ir) throw new Error('Essa tecla não existe no infravermelho');
    const pattern = lgPattern(ir, style);
    const airMs = Math.round(irAirtime(pattern));
    const started = Date.now();
    const emitMs = await transmitIr(IR_FREQUENCY, pattern);
    logIr({ key, result: 'sent', airMs, emitMs: typeof emitMs === 'number' ? emitMs : Date.now() - started, why });
    const left = airMs - (Date.now() - started);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }, [logIr]);

  const send = useCallback(async (key: KeyName, repeat: boolean) => {
    const t = Date.now();
    const via = channelFor(key);
    if (via === 'ir') {
      await fireIr(key, settingsRef.current?.irStyle ?? 'double', repeat ? 'segurando' : undefined);
    } else if (via === 'remote') {
      const r = remoteRef.current;
      if (!r) throw new Error('A Firestick não está conectada. Abra Dispositivos para conectar.');
      await r.press(key).catch(handleRemoteError);
    } else if (via === 'bluetooth') {
      const spec = KEYS[key].bt;
      if (!spec || !bt) throw new Error('Essa tecla não existe no Bluetooth');
      await bt.sendKey(spec[0], spec[1], 0);
    } else {
      // Apertou logo ao voltar para o app? Conecta primeiro e manda a tecla, em vez de dar erro.
      if (!tvRef.current?.connected && settingsRef.current?.host) await connectRef.current(undefined, undefined, true);
      const tv = tvRef.current;
      if (!tv?.connected) throw new Error('A Firestick não está conectada. Abra Dispositivos para conectar.');
      await tv.press(key);
    }
    setLatency(Date.now() - t);
  }, [channelFor, handleRemoteError, fireIr]);

  // Enquanto um envio não termina, os toques esperam numa fila curta. Repetições de "segurar" que
  // chegam com algo ainda saindo são descartadas: nunca sai uma rajada atrasada depois que o dedo saiu.
  const busyRef = useRef(false);
  const queueRef = useRef<{ key: KeyName; repeat: boolean }[]>([]);
  const irQueued = () => queueRef.current.filter((q) => channelFor(q.key) === 'ir').length;

  const press = useCallback(async (key: KeyName, repeat = false) => {
    const isIr = channelFor(key) === 'ir';
    if (busyRef.current) {
      if (repeat) {
        if (isIr) logIr({ key, result: 'dropped', why: 'segurando: o sinal anterior ainda estava saindo' });
        return;
      }
      if (queueRef.current.length >= (isIr ? QUEUE_IR : QUEUE_OTHER)) {
        if (isIr) logIr({ key, result: 'dropped', why: 'toques rápidos demais: a fila já estava cheia' });
        return;
      }
      queueRef.current.push({ key, repeat });
      if (isIr) setIrStats((st) => ({ ...st, queued: irQueued() }));
      return;
    }
    busyRef.current = true;
    try {
      let next: { key: KeyName; repeat: boolean } | undefined = { key, repeat };
      while (next) {
        const ir = channelFor(next.key) === 'ir';
        if (ir) setIrStats((st) => ({ ...st, sending: true, queued: irQueued() }));
        try {
          await withDeadline(send(next.key, next.repeat), ir ? 3000 : KEY_DEADLINE_MS);
        } catch (e) {
          if (ir) logIr({ key: next.key, result: 'error', why: (e as Error).message });
          throw e;
        }
        next = queueRef.current.shift();
      }
    } finally {
      // Deu erro? Os toques que esperavam não fazem mais sentido.
      queueRef.current = [];
      busyRef.current = false;
      setIrStats((st) => (st.sending || st.queued ? { ...st, sending: false, queued: 0 } : st));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, channelFor, logIr]);

  // Tela de ajuste: manda um único volume + no formato escolhido, sem passar pela fila normal.
  const testIrStyle = useCallback(async (style: IrStyle) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setIrStats((st) => ({ ...st, sending: true }));
    try {
      await fireIr('volup', style, `teste: ${style}`);
    } catch (e) {
      logIr({ key: 'volup', result: 'error', why: (e as Error).message });
    } finally {
      busyRef.current = false;
      setIrStats((st) => ({ ...st, sending: false }));
    }
  }, [fireIr, logIr]);

  const setIrStyle = useCallback((style: IrStyle) => updateSettings({ irStyle: style }), [updateSettings]);

  // Segurar o botão: de quanto em quanto tempo repete e quantas vezes no máximo. No infravermelho o
  // ritmo acompanha a duração do sinal (com folga), para a fila nunca acumular.
  const repeatPolicy = useCallback((key: KeyName) => {
    if (channelFor(key) !== 'ir') return { every: 160, max: 200 };
    const air = irAirtime(lgPattern('volup', settingsRef.current?.irStyle ?? 'double'));
    const level = key === 'volup' || key === 'voldown' || key === 'chup' || key === 'chdown';
    return { every: Math.max(300, Math.round(air) + 80), max: level ? HOLD_MAX_IR_LEVEL : HOLD_MAX_IR };
  }, [channelFor]);

  const typeText = useCallback(async (value: string) => {
    if (activeChannel === 'bluetooth' && bt) {
      for (const ch of value) {
        const hid = hidForChar(ch);
        if (!hid) throw new Error(`O teclado Bluetooth não sabe digitar "${ch}"`);
        await bt.sendKey('kb', hid[0], hid[1]);
      }
      return;
    }
    if (activeChannel === 'remote' && remoteRef.current) {
      await remoteRef.current.typeText(value).catch(handleRemoteError);
      return;
    }
    const tv = tvRef.current;
    if (!tv?.connected) throw new Error('Para digitar, conecte pela rede ou pelo Bluetooth');
    await tv.typeText(value);
  }, [activeChannel, handleRemoteError]);

  const launch = useCallback(async (app: AppItem) => {
    if (remoteRef.current && remote === 'on') await remoteRef.current.launch(app.pkg).catch(handleRemoteError);
    else if (tvRef.current?.connected) await tvRef.current.launch(app);
    else throw new Error('A Firestick não está conectada. Abra Dispositivos para conectar.');
    setTimeout(() => tvRef.current?.currentApp().then(setCurrentPkg).catch(() => {}), 1500);
  }, [remote, handleRemoteError]);

  const uninstall = useCallback(async (app: AppItem) => {
    const tv = tvRef.current;
    if (!tv) throw new Error('A TV não está conectada pela rede');
    await tv.uninstall(app);
    forgetArt(artRef.current, app.pkg);
    setApps((prev) => prev.filter((p) => p.pkg !== app.pkg));
  }, []);

  const inspectApk = useCallback(async (uri: string) => {
    const f = fileReader(uri);
    const zip = await Zip.open(f.read, f.size);
    const info = await readAppInfo(zip);
    if (!info.pkg) throw new Error('O arquivo não é um APK válido');
    if (info.pkg === Application.applicationId) {
      throw new Error('Esse é o próprio Controle da TV, que é feito para o celular. Na TV ele não roda.');
    }
    // Confere o processador antes de mandar: um APK só com bibliotecas de 64 bits nunca instala na
    // Fire TV (32 bits), e é melhor saber agora do que depois de esperar o envio inteiro.
    const apkAbis = [...new Set([...zip.entries.keys()].map((n) => n.match(/^lib\/([^/]+)\//)?.[1]).filter((a): a is string => !!a))];
    const read = await tvRef.current?.abis().catch(() => null);
    const tvAbis = read?.length ? read : ['armeabi-v7a', 'armeabi'];
    if (apkAbis.length && !apkAbis.some((a) => tvAbis.includes(a))) {
      throw new Error(
        `Esse APK só tem versão para ${apkAbis.join(', ')}, e a Fire TV precisa de ${tvAbis[0]} (32 bits). ` +
        `Baixe de novo escolhendo a variante "armeabi-v7a" ou "universal" (no APKMirror ela aparece na lista de variantes do app).`,
      );
    }
    return { ...info, size: f.size, abis: apkAbis };
  }, []);

  // Envio + instalação de APK. O estado fica aqui (e não na aba) para a barra de progresso ser global:
  // ela continua visível se a pessoa trocar de aba no meio do envio.
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const cancelRef = useRef(false);

  const install = useCallback(async (uri: string, label: string, pkg: string | null) => {
    const tv = tvRef.current;
    if (!tv?.connected) throw new Error('Para instalar, conecte a TV pela rede');
    const f = fileReader(uri);
    cancelRef.current = false;
    setTransfer({ label, pkg, sent: 0, total: f.size, phase: 'sending', message: null });
    let last = 0;
    try {
      await tv.install(
        f.read,
        f.size,
        (sent) => {
          // Atualiza a tela no máximo a cada ~1%, para não engasgar a interface com arquivos grandes.
          if (sent - last < f.size / 100 && sent < f.size) return;
          last = sent;
          setTransfer((t) => (t ? { ...t, sent } : t));
        },
        () => cancelRef.current,
        () => setTransfer((t) => (t ? { ...t, sent: t.total, phase: 'installing' } : t)),
      );
      setTransfer((t) => (t ? { ...t, phase: 'done' } : t));
      await loadApps();
    } catch (err) {
      const msg = (err as Error).message;
      setTransfer((t) => (t ? { ...t, phase: msg === 'Envio cancelado' ? 'cancelled' : 'error', message: msg } : t));
    }
  }, [loadApps]);

  const cancelInstall = useCallback(() => { cancelRef.current = true; }, []);
  const dismissTransfer = useCallback(() => setTransfer(null), []);

  // Depois de instalar: abre o app recém-instalado na TV.
  const openInstalled = useCallback(async () => {
    const pkg = transfer?.pkg;
    const tv = tvRef.current;
    if (!pkg || !tv?.connected) return;
    const app = (await tv.listApps()).find((a) => a.pkg === pkg);
    if (!app) throw new Error('O app foi instalado, mas não tem tela para abrir na TV');
    await tv.launch(app);
    setTransfer(null);
  }, [transfer?.pkg]);

  const deviceInfo = useCallback(async (): Promise<DeviceInfo | null> => {
    const tv = tvRef.current;
    if (tv?.connected) return tv.deviceInfo();
    const r = remoteRef.current;
    if (!r) return null;
    const { osVersion } = await r.status();
    return {
      model: '', modelName: settingsRef.current?.tvName || 'Fire TV', fireOs: osVersion?.match(/Fire OS [\d.]+/i)?.[0] ?? osVersion,
      android: '', storageTotal: null, storageFree: null, resolution: null, host: r.host,
    };
  }, []);

  const screenshot = useCallback(async () => {
    const tv = tvRef.current;
    if (!tv?.connected) throw new Error('Ver a tela precisa do modo avançado. Ligue em Dispositivos.');
    return saveScreenshot(await tv.screenshot());
  }, []);

  const refreshCurrent = useCallback(() => {
    tvRef.current?.currentApp().then(setCurrentPkg).catch(() => {});
  }, []);

  return {
    settings, preparing,
    net, netError, connectNetwork, reconnecting,
    remote, remoteError, connectRemote, submitPin, resendPin, setAdvanced,
    target: activeTarget, setTarget, channel: activeChannel, firestickChannel, latency,
    irAvailable,
    btAvailable, btEnabled, btReady, btHost, btDevices, btScanning, btError,
    startBluetooth, scanBluetooth, connectBluetooth, pairBluetoothViaTv, pairBluetooth, btPairing,
    found, discovering, discover,
    apps, currentPkg, loadApps: reloadApps, refreshCurrent,
    press, repeatPolicy, testIrStyle, setIrStyle, irLog, irStats, resetIr, typeText, launch, uninstall, inspectApk, screenshot,
    install, transfer, cancelInstall, dismissTransfer, openInstalled, deviceInfo,
    supports: (key: KeyName) => supports(channelFor(key), key),
  };
}

export type Tv = ReturnType<typeof useTv>;
