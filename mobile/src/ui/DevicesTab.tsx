import { useEffect, useState } from 'react';
import * as Application from 'expo-application';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from './theme';
import type { Tv } from '../useTv';
import type { DeviceInfo } from '../tv/network';
import { IR_STYLES } from '../ir/lg';
import { KEY_LABELS } from './IrMeter';

function Card({ icon, title, status, ok, children }: {
  icon: React.ComponentProps<typeof Ionicons>['name']; title: string; status: string; ok: boolean | null; children?: React.ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Ionicons name={icon} size={22} color={colors.text} />
        <View style={{ flex: 1 }}>
          <Text style={styles.h3}>{title}</Text>
          <View style={styles.status}>
            <View style={[styles.dot, ok === true && { backgroundColor: colors.ok }, ok === false && { backgroundColor: colors.bad }]} />
            <Text style={styles.statusText}>{status}</Text>
          </View>
        </View>
      </View>
      {children}
    </View>
  );
}

export function DevicesTab({ tv }: { tv: Tv }) {
  const [manual, setManual] = useState(false);
  const [host, setHost] = useState(tv.settings?.host ?? '');
  const tvName = tv.settings?.tvName || 'Firestick';
  const connected = tv.remote === 'on';
  const busy = tv.remote === 'connecting';
  const searched = !tv.discovering && tv.found.length === 0;

  return (
    <View style={{ paddingHorizontal: 16, gap: 14 }}>
      <Card
        icon="tv-outline"
        title={connected || tv.remote === 'pin' ? tvName : 'Sua Firestick'}
        status={connected ? `Conectada pela rede (${tv.settings?.host})` : tv.remote === 'pin' ? 'Esperando o PIN' : busy ? 'Conectando…' : 'Não conectada'}
        ok={connected ? true : tv.remote === 'error' ? false : null}
      >
        {tv.remote === 'pin' ? (
          <PinEntry tv={tv} />
        ) : !connected ? (
          <>
            <Pressable style={[styles.primary, (tv.discovering || busy) && styles.disabled]} disabled={tv.discovering || busy} onPress={() => tv.discover()}>
              {tv.discovering ? <ActivityIndicator color={colors.ink} /> : <Ionicons name="search" size={18} color={colors.ink} />}
              <Text style={styles.primaryText}>{tv.discovering ? 'Procurando na rede…' : 'Procurar Firestick'}</Text>
            </Pressable>

            {tv.found.map((f) => (
              <Pressable key={f.host} style={styles.row} disabled={busy} onPress={() => tv.connectRemote(f.host, f.name)}>
                <Ionicons name="wifi" size={20} color={colors.text} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>{f.name}</Text>
                  <Text style={styles.rowSub}>{f.host}</Text>
                </View>
                <Text style={styles.rowAction}>Conectar</Text>
              </Pressable>
            ))}

            {searched && tv.found.length === 0 && !busy ? (
              <Text style={styles.p}>Nenhuma Firestick apareceu. Confira se ela está ligada e no mesmo Wi-Fi do celular.</Text>
            ) : null}
          </>
        ) : (
          <>
            <DeviceDetails tv={tv} />
            <Pressable style={styles.secondary} onPress={() => tv.discover()}>
              <Text style={styles.secondaryText}>Procurar outra Firestick</Text>
            </Pressable>
          </>
        )}

        {tv.remoteError && tv.remote !== 'pin' ? <Text style={styles.error}>{tv.remoteError}</Text> : null}

        {tv.remote !== 'pin' ? (
          <Pressable onPress={() => setManual((m) => !m)}>
            <Text style={styles.link}>{manual ? 'Esconder IP manual' : 'Digitar IP manualmente'}</Text>
          </Pressable>
        ) : null}
        {manual && tv.remote !== 'pin' ? (
          <View style={styles.manual}>
            <TextInput value={host} onChangeText={setHost} placeholder="192.168.0.101" keyboardType="numbers-and-punctuation" style={styles.input} placeholderTextColor={colors.textDim} />
            <Pressable style={[styles.primarySmall, busy && styles.disabled]} disabled={busy} onPress={() => tv.connectRemote(host)}>
              <Text style={styles.primaryText}>Conectar</Text>
            </Pressable>
          </View>
        ) : null}
      </Card>

      {tv.btAvailable ? <BluetoothCard tv={tv} /> : null}

      <Card
        icon="radio-outline"
        title="TV LG (infravermelho)"
        status={tv.irAvailable ? 'Pronta: este celular tem emissor de infravermelho' : 'Este celular não tem emissor de infravermelho'}
        ok={tv.irAvailable ? true : null}
      >
        {tv.irAvailable ? <IrTuning tv={tv} /> : null}
      </Card>

      <AdvancedCard tv={tv} />

      <View style={styles.about}>
        <Text style={styles.aboutTitle}>Controle da TV</Text>
        <Text style={styles.aboutText}>
          Versão {Application.nativeApplicationVersion ?? '?'} (build {Application.nativeBuildVersion ?? '?'})
        </Text>
        <Text style={styles.aboutText}>Controla a Firestick pela rede ou Bluetooth e a TV LG pelo infravermelho.</Text>
      </View>
    </View>
  );
}

const gb = (bytes: number) => (bytes / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

// Informações da Firestick. Pela API vêm só o sistema e o endereço; com o modo avançado (ADB)
// aparecem também modelo, resolução e espaço livre.
function DeviceDetails({ tv }: { tv: Tv }) {
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const { deviceInfo, remote, net } = tv;
  useEffect(() => {
    if (remote !== 'on' && net !== 'on') return;
    let alive = true;
    deviceInfo().then((i) => { if (alive) setInfo(i); }).catch(() => {});
    return () => { alive = false; };
  }, [deviceInfo, remote, net]);

  if (!info) return <ActivityIndicator color={colors.textDim} style={{ alignSelf: 'flex-start' }} />;

  const used = info.storageTotal && info.storageFree != null ? 1 - info.storageFree / info.storageTotal : null;
  const lowSpace = info.storageFree != null && info.storageFree < 500e6;
  const system = [info.fireOs, info.android ? `Android ${info.android}` : null].filter(Boolean).join(', ');
  const rows: [string, string][] = [
    ...(info.model ? [['Modelo', `${info.modelName} (${info.model})`] as [string, string]] : []),
    ...(system ? [['Sistema', system] as [string, string]] : []),
    ...(info.resolution ? [['Resolução', info.resolution.replace('x', ' × ')] as [string, string]] : []),
    ['Endereço na rede', info.host],
  ];

  return (
    <View style={styles.details}>
      {rows.map(([k, v]) => (
        <View key={k} style={styles.detailRow}>
          <Text style={styles.detailKey}>{k}</Text>
          <Text style={styles.detailValue}>{v}</Text>
        </View>
      ))}
      {used != null && info.storageTotal ? (
        <View style={{ gap: 6 }}>
          <View style={styles.detailRow}>
            <Text style={styles.detailKey}>Armazenamento</Text>
            <Text style={[styles.detailValue, lowSpace && { color: colors.bad }]}>
              {gb(info.storageFree ?? 0)} GB livres de {gb(info.storageTotal)} GB
            </Text>
          </View>
          <View style={styles.storageTrack}>
            <View style={[styles.storageFill, { width: `${Math.round(used * 100)}%` }, lowSpace && { backgroundColor: colors.bad }]} />
          </View>
          {lowSpace ? <Text style={styles.small}>Pouco espaço: apps grandes podem falhar ao instalar.</Text> : null}
        </View>
      ) : (
        <Text style={styles.small}>Modelo e espaço livre aparecem com o modo avançado ligado.</Text>
      )}
    </View>
  );
}

// Primeira conexão: a TV mostra um PIN de 4 dígitos (como no app oficial da Amazon).
function PinEntry({ tv }: { tv: Tv }) {
  const [pin, setPin] = useState('');
  const [sending, setSending] = useState(false);
  const submit = async (value: string) => {
    if (value.length !== 4 || sending) return;
    setSending(true);
    await tv.submitPin(value);
    setSending(false);
    setPin('');
  };
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.p}>Olhe a TV: apareceu um código de 4 números. Digite aqui. Isso só é pedido na primeira vez.</Text>
      <TextInput
        value={pin}
        onChangeText={(v) => {
          const digits = v.replace(/\D/g, '').slice(0, 4);
          setPin(digits);
          if (digits.length === 4) submit(digits);
        }}
        keyboardType="number-pad"
        maxLength={4}
        autoFocus
        placeholder="0000"
        placeholderTextColor={colors.fogDeep}
        style={styles.pin}
        accessibilityLabel="PIN que aparece na TV"
      />
      <Pressable style={[styles.primary, (pin.length !== 4 || sending) && styles.disabled]} disabled={pin.length !== 4 || sending} onPress={() => submit(pin)}>
        {sending ? <ActivityIndicator color={colors.ink} /> : null}
        <Text style={styles.primaryText}>Confirmar</Text>
      </Pressable>
      {tv.remoteError ? <Text style={styles.error}>{tv.remoteError}</Text> : null}
      <Pressable onPress={tv.resendPin}>
        <Text style={styles.link}>O código sumiu da TV? Mostrar de novo</Text>
      </Pressable>
    </View>
  );
}

// Modo avançado: o ADB só entra para o que a API da Amazon não faz.
function AdvancedCard({ tv }: { tv: Tv }) {
  const on = !!tv.settings?.adb;
  const status = !on ? 'Desligado' : tv.net === 'on' ? 'Ligado' : tv.net === 'auth' ? 'Esperando você aceitar na TV' : tv.net === 'connecting' ? 'Conectando…' : 'Ligado, sem conexão';
  return (
    <Card icon="construct-outline" title="Modo avançado" status={status} ok={on && tv.net === 'on' ? true : on && tv.net === 'error' ? false : null}>
      <Text style={styles.p}>
        Para instalar e desinstalar APK, ver a tela da TV e o espaço livre. Precisa ligar a Depuração ADB na Firestick (Configurações, Minha Fire TV, Opções do desenvolvedor) e aceitar um pedido na TV uma vez.
      </Text>
      {on && tv.net === 'auth' ? (
        <View style={styles.callout}>
          <Text style={styles.calloutText}>Olhe a TV: apareceu “Permitir depuração USB?”. Marque “Sempre permitir deste computador” e aperte OK.</Text>
        </View>
      ) : null}
      {on && tv.netError && tv.net !== 'on' ? <Text style={styles.error}>{tv.netError}</Text> : null}
      <Pressable style={on ? styles.secondary : styles.primary} onPress={() => tv.setAdvanced(!on)}>
        <Text style={on ? styles.secondaryText : styles.primaryText}>{on ? 'Desligar modo avançado' : 'Ligar modo avançado'}</Text>
      </Pressable>
      {on && tv.net !== 'on' && tv.net !== 'connecting' && tv.net !== 'auth' ? (
        <Pressable onPress={() => tv.connectNetwork()}>
          <Text style={styles.link}>Tentar conectar de novo</Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

// Cada TV reage de um jeito ao formato do sinal. Como o Mi Remote, a pessoa testa e escolhe.
function IrTuning({ tv }: { tv: Tv }) {
  const current = tv.settings?.irStyle ?? 'double';
  return (
    <View style={{ gap: 10 }}>
      <Text style={styles.p}>
        Ajuste o sinal para a sua TV: aponte a parte de cima do celular para ela, toque em “Testar” e veja quanto o volume sobe. Escolha o que subir exatamente 1 passo.
      </Text>
      {IR_STYLES.map((s) => (
        <View key={s.id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>{s.label}{current === s.id ? '  ✓' : ''}</Text>
            <Text style={styles.rowSub}>{s.hint}</Text>
          </View>
          <Pressable style={styles.testBtn} onPress={() => tv.testIrStyle(s.id)}>
            <Text style={styles.secondaryText}>Testar</Text>
          </Pressable>
          <Pressable style={[styles.useBtn, current === s.id && styles.useBtnOn]} onPress={() => tv.setIrStyle(s.id)} disabled={current === s.id}>
            <Text style={[styles.useText, current === s.id && { color: colors.ink }]}>{current === s.id ? 'Em uso' : 'Usar este'}</Text>
          </Pressable>
        </View>
      ))}
      <IrHistory tv={tv} />
    </View>
  );
}

// Os últimos sinais, do mais novo para o mais antigo. "No ar" é a duração do sinal; "emissor" é quanto
// o celular levou para aceitá-lo (bem menor que o tempo no ar = o Android enfileirou por baixo).
function IrHistory({ tv }: { tv: Tv }) {
  const time = (at: number) => {
    const d = new Date(at);
    return `${d.toLocaleTimeString('pt-BR')}.${String(d.getMilliseconds()).padStart(3, '0').slice(0, 1)}`;
  };
  const describe = (e: Tv['irLog'][number]) => {
    if (e.result === 'sent') return `Enviado, ${e.airMs} ms no ar, emissor ${e.emitMs} ms${e.why ? ` (${e.why})` : ''}`;
    if (e.result === 'dropped') return `Ignorado: ${e.why}`;
    return `Falhou: ${e.why}`;
  };
  return (
    <View style={styles.irHistory}>
      <View style={styles.irHistoryHead}>
        <Text style={styles.rowTitle}>Últimos sinais</Text>
        <Pressable onPress={tv.resetIr} disabled={!tv.irLog.length} style={!tv.irLog.length && styles.disabled}>
          <Text style={styles.link}>Zerar contagem</Text>
        </Pressable>
      </View>
      <Text style={styles.small}>
        {tv.irStats.sent} enviados, {tv.irStats.dropped} ignorados{tv.irStats.errors ? `, ${tv.irStats.errors} falharam` : ''}.
        {' '}Cada toque deve virar um sinal só. Se aqui aparecer 1 e o volume subir 2, troque o formato do sinal acima.
      </Text>
      {tv.irLog.length ? tv.irLog.slice(0, 15).map((e) => (
        <View key={e.id} style={styles.irEvent}>
          <Text style={styles.irTime}>{time(e.at)}</Text>
          <View style={{ flex: 1 }}>
            <Text style={[styles.irKey, e.result !== 'sent' && { color: e.result === 'error' ? colors.bad : colors.textDim }]}>{KEY_LABELS[e.key]}</Text>
            <Text style={styles.rowSub}>{describe(e)}</Text>
          </View>
        </View>
      )) : <Text style={styles.small}>Nenhum sinal ainda. Aperte um botão no Controle e volte aqui.</Text>}
    </View>
  );
}

function BluetoothCard({ tv }: { tv: Tv }) {
  const connected = !!tv.btHost;
  const paired = tv.btDevices.some((d) => d.bonded);
  // Parear com um toque precisa da rede (é por ela que o app descobre o endereço Bluetooth da Firestick)
  // ou de uma Firestick visível na busca Bluetooth.
  const canPair = tv.net === 'on' || tv.btDevices.length > 0;
  const working = tv.btPairing === 'working' || tv.btPairing === 'bonding';

  const status = connected ? `Conectado a ${tv.btHost?.name || 'Firestick'}`
    : working ? (tv.btPairing === 'bonding' ? 'Pareando… confirme no celular e na TV se aparecer' : 'Preparando o pareamento…')
      : paired ? 'Pareado, aguardando a Firestick' : !tv.btEnabled ? 'Bluetooth desligado' : 'Ainda não pareado';

  return (
    <Card icon="bluetooth" title="Bluetooth (reserva)" status={status} ok={connected ? true : tv.btPairing === 'failed' ? false : null}>
      <Text style={styles.p}>Controla a Firestick mesmo sem rede: setas, OK, voltar, início, mídia e digitação.</Text>

      {!tv.btEnabled || !tv.btReady ? (
        <Pressable style={styles.primary} onPress={tv.startBluetooth}>
          <Ionicons name="bluetooth" size={18} color={colors.ink} />
          <Text style={styles.primaryText}>Ligar Bluetooth</Text>
        </Pressable>
      ) : !connected ? (
        <>
          <Pressable style={[styles.primary, (!canPair || working) && styles.disabled]} disabled={!canPair || working} onPress={tv.pairBluetooth}>
            {working ? <ActivityIndicator color={colors.ink} /> : <Ionicons name="link" size={18} color={colors.ink} />}
            <Text style={styles.primaryText}>{paired ? 'Reconectar' : 'Parear com a Firestick'}</Text>
          </Pressable>
          {!canPair ? (
            <>
              <Text style={styles.small}>Com o modo avançado ligado, o pareamento é com um toque. Sem ele, pareie pelos menus da TV:</Text>
              <Pressable style={styles.secondary} onPress={tv.pairBluetoothViaTv}>
                <Text style={styles.secondaryText}>Parear pelos menus da TV</Text>
              </Pressable>
              <Text style={styles.small}>O celular fica visível por 2 minutos. Na TV: Configurações, Controles e dispositivos Bluetooth, Outros dispositivos Bluetooth, Adicionar, e escolha este celular.</Text>
            </>
          ) : null}
        </>
      ) : null}

      {tv.btDevices.filter((d) => d.address !== tv.btHost?.address).map((d) => (
        <Pressable key={d.address} style={styles.row} onPress={() => tv.connectBluetooth(d)}>
          <Ionicons name="tv-outline" size={20} color={colors.text} />
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>{d.name || d.address}</Text>
            <Text style={styles.rowSub}>{d.bonded ? 'Pareada' : 'Encontrada'}</Text>
          </View>
          <Text style={styles.rowAction}>Conectar</Text>
        </Pressable>
      ))}

      {tv.btError ? <Text style={styles.error}>{tv.btError}</Text> : null}
      {tv.btPairing === 'failed' || tv.btError ? (
        <Pressable onPress={tv.pairBluetoothViaTv}>
          <Text style={styles.link}>Parear pelos menus da TV</Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.paper, borderRadius: 14, padding: 16, gap: 12 },
  cardHead: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  h3: { fontSize: 18, fontWeight: '700', color: colors.text },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.fogDeep },
  statusText: { color: colors.textDim, fontSize: 13, flexShrink: 1 },
  p: { color: colors.textDim, fontSize: 14, lineHeight: 20 },
  small: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  primary: { flexDirection: 'row', gap: 8, backgroundColor: colors.shell, borderRadius: 12, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  primarySmall: { backgroundColor: colors.shell, borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' },
  primaryText: { color: colors.ink, fontWeight: '600', fontSize: 16 },
  disabled: { opacity: 0.4 },
  secondary: { borderWidth: 1, borderColor: colors.fogDeep, borderRadius: 12, paddingVertical: 11, alignItems: 'center' },
  secondaryText: { color: colors.text, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.fog },
  rowTitle: { fontWeight: '600', color: colors.text, fontSize: 15 },
  rowSub: { color: colors.textDim, fontSize: 12 },
  rowAction: { color: colors.text, fontWeight: '600' },
  callout: { backgroundColor: '#fdf3dc', borderRadius: 10, padding: 12, borderLeftWidth: 4, borderLeftColor: colors.amber },
  calloutText: { color: colors.text, lineHeight: 20 },
  error: { color: colors.bad, fontSize: 14, lineHeight: 20 },
  link: { color: colors.textDim, textDecorationLine: 'underline', fontSize: 14 },
  manual: { flexDirection: 'row', gap: 8 },
  pin: { fontSize: 40, fontWeight: '700', letterSpacing: 16, textAlign: 'center', color: colors.text, borderWidth: 1, borderColor: colors.fogDeep, borderRadius: 12, paddingVertical: 10, backgroundColor: '#fff' },
  details: { gap: 8, backgroundColor: colors.fog, borderRadius: 12, padding: 12 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  detailKey: { color: colors.textDim, fontSize: 14 },
  detailValue: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  storageTrack: { height: 8, borderRadius: 4, backgroundColor: colors.fogDeep, overflow: 'hidden' },
  storageFill: { height: '100%', borderRadius: 4, backgroundColor: colors.shell },
  about: { alignItems: 'center', paddingVertical: 18, gap: 4 },
  aboutTitle: { color: colors.text, fontWeight: '700', fontSize: 15 },
  aboutText: { color: colors.textDim, fontSize: 13, textAlign: 'center' },
  testBtn: { borderWidth: 1, borderColor: colors.fogDeep, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  useBtn: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.fog },
  useBtnOn: { backgroundColor: colors.shell },
  useText: { color: colors.text, fontWeight: '600', fontSize: 13 },
  irHistory: { gap: 8, borderTopWidth: 1, borderTopColor: colors.fog, paddingTop: 12 },
  irHistoryHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  irEvent: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  irTime: { color: colors.textDim, fontSize: 12, width: 72, fontVariant: ['tabular-nums'], paddingTop: 2 },
  irKey: { color: colors.text, fontWeight: '600', fontSize: 14 },
  input: { flex: 1, borderWidth: 1, borderColor: colors.fogDeep, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 16, color: colors.text, backgroundColor: '#fff' },
});
