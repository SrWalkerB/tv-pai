import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { useTv, type Target } from './src/useTv';
import { Remote } from './src/ui/Remote';
import { AppsTab } from './src/ui/AppsTab';
import { ScreenTab } from './src/ui/ScreenTab';
import { DevicesTab } from './src/ui/DevicesTab';
import { TransferBar } from './src/ui/TransferBar';
import { IrMeter } from './src/ui/IrMeter';
import { colors } from './src/ui/theme';
import { FireTvMark, LgMark } from './src/ui/BrandMark';
import type { Channel } from './src/tv/keys';

type Tab = 'remote' | 'apps' | 'screen' | 'devices';
type IconName = ComponentProps<typeof Ionicons>['name'];

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'remote', label: 'Controle', icon: 'game-controller-outline' },
  { id: 'apps', label: 'Apps', icon: 'apps-outline' },
  { id: 'screen', label: 'Tela', icon: 'tv-outline' },
  { id: 'devices', label: 'Dispositivos', icon: 'link-outline' },
];

const CHANNEL: Record<Channel, { label: string; icon: IconName }> = {
  remote: { label: 'via Wi-Fi', icon: 'wifi' },
  network: { label: 'via Wi-Fi (modo avançado)', icon: 'wifi' },
  bluetooth: { label: 'via Bluetooth', icon: 'bluetooth' },
  ir: { label: 'via infravermelho', icon: 'radio-outline' },
};

function useToast() {
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [opacity] = useState(() => new Animated.Value(0));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = (text: string, bad = false) => {
    setMsg({ text, bad });
    Animated.timing(opacity, { toValue: 1, duration: 120, useNativeDriver: true }).start();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(), 2600);
  };
  const node = msg ? (
    <Animated.View pointerEvents="none" style={[styles.toast, msg.bad && { backgroundColor: colors.bad }, { opacity }]}>
      <Text style={styles.toastText}>{msg.text}</Text>
    </Animated.View>
  ) : null;
  return { show, node };
}

function Main() {
  const tv = useTv();
  const [tab, setTab] = useState<Tab>('remote');
  const toast = useToast();

  useEffect(() => { if (tab === 'apps') tv.refreshCurrent(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  if (tv.preparing) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.shell} />
        <Text style={styles.preparing}>{tv.preparing}</Text>
      </View>
    );
  }

  // A escolha é O QUE controlar. O caminho (rede, Bluetooth, IR) aparece só como informação.
  const fireReady = tv.firestickChannel != null;
  // A TV aparece sempre, mas fica bloqueada quando o celular não tem emissor de infravermelho.
  const targets: { id: Target; label: string; mark: React.ReactNode; accent: string; ready: boolean; locked: boolean }[] = [
    { id: 'firestick', label: 'Firestick', mark: <FireTvMark size={26} />, accent: colors.amazon, ready: fireReady, locked: false },
    { id: 'tv', label: 'TV', mark: <LgMark size={26} />, accent: colors.lg, ready: tv.irAvailable, locked: !tv.irAvailable },
  ];
  const accent = tv.target === 'tv' ? colors.lg : colors.amazon;
  const ready = tv.target === 'tv' || fireReady;
  const waiting = !ready && (tv.reconnecting || tv.net === 'connecting' || tv.remote === 'connecting');
  const ch = CHANNEL[tv.channel];
  const chipText = ready
    ? [ch.label, tv.latency != null ? `${tv.latency} ms` : null].filter(Boolean).join(', ')
    : tv.remote === 'pin' ? 'Digite o PIN que apareceu na TV'
      : waiting ? 'Conectando à Firestick…' : 'Firestick desconectada. Toque para conectar';

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <View style={styles.seg}>
          {targets.map((t) => (
            <Pressable
              key={t.id}
              onPress={() => (t.locked
                ? toast.show('Este celular não tem infravermelho, então não controla a TV LG. Use um celular com emissor de IR (como Xiaomi, Redmi ou Poco).', true)
                : tv.setTarget(t.id))}
              style={[styles.segBtn, tv.target === t.id && [styles.segOn, { borderColor: t.accent }], t.locked && styles.segLocked]}
              accessibilityRole="tab"
              accessibilityLabel={t.id === 'tv' ? (t.locked ? 'TV LG indisponível: este celular não tem infravermelho' : 'Controlar a TV LG') : 'Controlar a Firestick'}
              accessibilityState={{ selected: tv.target === t.id, disabled: t.locked }}
            >
              {t.mark}
              <Text style={[styles.segText, tv.target === t.id && styles.segTextOn]} numberOfLines={1}>{t.label}</Text>
              {t.locked
                ? <Ionicons name="lock-closed" size={14} color={colors.textDim} />
                : <View style={[styles.segDot, t.ready && { backgroundColor: colors.ok, opacity: 1 }]} />}
            </Pressable>
          ))}
        </View>
        {!tv.irAvailable ? (
          <Text style={styles.lockNote}>TV LG bloqueada: este celular não tem infravermelho. O volume vai pela Firestick.</Text>
        ) : null}
        <Pressable onPress={() => setTab('devices')} style={[styles.chip, !ready && !waiting && styles.chipOff]}>
          {waiting ? <ActivityIndicator size="small" color={colors.textDim} /> : (
            <Ionicons name={ready ? ch.icon : 'alert-circle-outline'} size={14} color={ready ? colors.text : colors.bad} />
          )}
          <Text style={styles.chipText} numberOfLines={1}>{chipText}</Text>
        </Pressable>
        {tv.remote === 'pin' && tab !== 'devices' ? (
          <Pressable onPress={() => setTab('devices')}>
            <Text style={styles.authNote}>A TV está mostrando um PIN de 4 dígitos. Toque aqui para digitar.</Text>
          </Pressable>
        ) : tv.net === 'auth' ? (
          <Text style={styles.authNote}>Modo avançado: aceite o pedido na TV, marque “Sempre permitir” e aperte OK.</Text>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        {tab === 'remote' ? (
          <>
            <Remote
              press={tv.press}
              accent={accent}
              repeatPolicy={tv.repeatPolicy}
              supports={tv.supports}
              typeText={tv.typeText}
              canType={tv.channel !== 'ir'}
              onError={(m) => toast.show(m, true)}
            />
            {tv.irAvailable ? (
              <IrMeter stats={tv.irStats} last={tv.irLog[0] ?? null} onOpen={() => setTab('devices')} />
            ) : null}
            {tv.target === 'tv' ? (
              <Text style={styles.irNote}>Os botões controlam a TV LG pelo infravermelho: aponte a parte de cima do celular para a TV. Se o volume pular ou voltar, ajuste o sinal em Dispositivos.</Text>
            ) : tv.irAvailable ? (
              <Text style={styles.irNote}>O volume é o da TV LG: aponte a parte de cima do celular para a TV, de frente.</Text>
            ) : null}
          </>
        ) : null}
        {tab === 'apps' ? (
          <AppsTab tv={tv} onError={(m) => toast.show(m, true)} onInfo={(m) => toast.show(m)} onNeedNetwork={() => setTab('devices')} />
        ) : null}
        {tab === 'screen' ? <ScreenTab tv={tv} /> : null}
        {tab === 'devices' ? <DevicesTab tv={tv} /> : null}
      </ScrollView>

      <TransferBar tv={tv} onError={(m) => toast.show(m, true)} />
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable key={t.id} onPress={() => setTab(t.id)} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected: tab === t.id }}>
            <Ionicons name={t.icon} size={22} color={tab === t.id ? colors.ink : colors.inkDim} />
            <Text style={[styles.tabText, tab === t.id && { color: colors.ink }]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {toast.node}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <StatusBar style="dark" />
        <Main />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.fog },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  preparing: { color: colors.textDim, textAlign: 'center' },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14, gap: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: colors.paper, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: colors.fogDeep, maxWidth: '100%' },
  chipOff: { borderColor: colors.bad },
  chipText: { color: colors.textDim, fontSize: 13, flexShrink: 1 },
  authNote: { color: colors.text, backgroundColor: '#fdf3dc', padding: 10, borderRadius: 10, overflow: 'hidden' },
  seg: { flexDirection: 'row', backgroundColor: colors.fogDeep, borderRadius: 14, padding: 4 },
  segBtn: { flex: 1, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 8, borderRadius: 11, borderWidth: 2, borderColor: 'transparent' },
  segOn: { backgroundColor: colors.paper, borderWidth: 2 },
  segLocked: { opacity: 0.5 },
  lockNote: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  segDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.textDim, opacity: 0.4 },
  segText: { color: colors.textDim, fontSize: 15, flexShrink: 1 },
  segTextOn: { color: colors.text, fontWeight: '600' },
  irNote: { color: colors.textDim, fontSize: 13, lineHeight: 19, paddingHorizontal: 24, marginTop: 14 },
  tabs: { flexDirection: 'row', backgroundColor: colors.shell, paddingVertical: 8 },
  tab: { flex: 1, alignItems: 'center', gap: 2 },
  tabText: { color: colors.inkDim, fontSize: 11 },
  toast: { position: 'absolute', left: 16, right: 16, bottom: 90, backgroundColor: colors.shell, borderRadius: 12, padding: 14 },
  toastText: { color: colors.ink, textAlign: 'center' },
});
