import { useMemo, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { colors } from './theme';
import type { AppItem, Tv } from '../useTv';

const PALETTE = ['#4b6584', '#3c8d7a', '#8a5a9e', '#b5654a', '#5a7d2e', '#2f6fa3'];
function colorFor(pkg: string) {
  let h = 0;
  for (const c of pkg) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

type Props = { tv: Tv; onError: (m: string) => void; onInfo: (m: string) => void; onNeedNetwork: () => void };

export function AppsTab({ tv, onError, onInfo, onNeedNetwork }: Props) {
  const [query, setQuery] = useState('');
  const [onlyTv, setOnlyTv] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tv.apps.filter((a) => (!onlyTv || a.tv) && (!q || a.label.toLowerCase().includes(q) || a.pkg.includes(q)));
  }, [tv.apps, query, onlyTv]);

  const online = tv.remote === 'on' || tv.net === 'on';
  const advanced = tv.net === 'on';

  if (!online && (tv.reconnecting || tv.net === 'connecting' || tv.remote === 'connecting')) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Reconectando à Firestick…</Text>
        <Text style={styles.emptyText}>Os apps aparecem assim que a conexão voltar.</Text>
      </View>
    );
  }

  if (!online) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Conecte a Firestick para ver os apps</Text>
        <Text style={styles.emptyText}>Bluetooth e infravermelho só mandam teclas. Para listar e abrir apps, conecte a Firestick pela rede.</Text>
        <Pressable style={styles.primary} onPress={onNeedNetwork}><Text style={styles.primaryText}>Conectar a Firestick</Text></Pressable>
      </View>
    );
  }

  // Instalar e desinstalar só existem no modo avançado (a API da Amazon não faz isso).
  const needAdvanced = (what: string) => Alert.alert(
    `${what} precisa do modo avançado`,
    'Ligue o modo avançado em Dispositivos. Ele usa a Depuração ADB da Firestick.',
    [{ text: 'Agora não', style: 'cancel' }, { text: 'Abrir Dispositivos', onPress: onNeedNetwork }],
  );

  const askUninstall = (app: AppItem) => {
    if (!advanced) { needAdvanced('Desinstalar'); return; }
    if (!app.removable) { onError(`${app.label} é um app do sistema e a Fire TV não deixa removê-lo.`); return; }
    Alert.alert(`Desinstalar ${app.label}?`, 'O app e os dados dele (logins, downloads) serão apagados da TV.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Desinstalar', style: 'destructive',
        onPress: async () => {
          setProgress(`Desinstalando ${app.label}…`);
          try { await tv.uninstall(app); onInfo(`${app.label} desinstalado`); } catch (e) { onError((e as Error).message); }
          setProgress(null);
        },
      },
    ]);
  };

  // Um envio por vez: o botão fica desativado enquanto há um APK indo para a TV.
  const busyTransfer = tv.transfer?.phase === 'sending' || tv.transfer?.phase === 'installing';

  const pickApk = async () => {
    if (!advanced) { needAdvanced('Instalar APK'); return; }
    const res = await DocumentPicker.getDocumentAsync({ type: ['application/vnd.android.package-archive', 'application/octet-stream'], copyToCacheDirectory: true });
    if (res.canceled) return;
    const asset = res.assets[0];
    if (!/\.apk$/i.test(asset.name)) { onError('Escolha um arquivo .apk'); return; }
    let label = asset.name;
    let pkg: string | null = null;
    try {
      const info = await tv.inspectApk(asset.uri);
      label = info.label || info.pkg || asset.name;
      pkg = info.pkg;
    } catch (e) { onError((e as Error).message); return; }
    const mb = ((asset.size ?? 0) / 1048576).toFixed(1);
    Alert.alert(`Instalar ${label}?`, `${asset.name} (${mb} MB) vai ser enviado e instalado na TV. Dá para acompanhar na barra de baixo e cancelar durante o envio.`, [
      { text: 'Cancelar', style: 'cancel' },
      // O progresso aparece na barra global (TransferBar); ela também mostra erros e o botão de abrir.
      { text: 'Instalar', onPress: () => { tv.install(asset.uri, label, pkg).catch((e: Error) => onError(e.message)); } },
    ]);
  };

  return (
    <View>
      <View style={styles.head}>
        <Text style={styles.h2}>Apps <Text style={styles.count}>{list.length}</Text></Text>
        <Pressable
          style={[styles.install, busyTransfer && { opacity: 0.4 }]}
          disabled={busyTransfer}
          onPress={pickApk}
        >
          <Text style={styles.installText}>Instalar APK</Text>
        </Pressable>
      </View>
      <View style={styles.filters}>
        <TextInput value={query} onChangeText={setQuery} placeholder="Buscar app" placeholderTextColor={colors.textDim} style={styles.search} />
        <View style={styles.seg}>
          {[['Da TV', true], ['Todos', false]].map(([label, value]) => (
            <Pressable key={String(label)} onPress={() => setOnlyTv(value as boolean)} style={[styles.segBtn, onlyTv === value && styles.segOn]}>
              <Text style={[styles.segText, onlyTv === value && styles.segTextOn]}>{label as string}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      {progress ? <View style={styles.progress}><Text style={styles.progressText}>{progress}</Text></View> : null}
      <Text style={styles.hint}>{advanced ? 'Toque para abrir. Segure para desinstalar.' : 'Toque para abrir na TV.'}</Text>
      <View style={styles.grid}>
        {list.map((app) => (
          <Pressable
            key={app.pkg}
            onPress={() => tv.launch(app).then(() => onInfo(`Abrindo ${app.label}`)).catch((e: Error) => onError(e.message))}
            onLongPress={() => askUninstall(app)}
            style={({ pressed }) => [styles.card, app.pkg === tv.currentPkg && styles.current, pressed && { opacity: 0.85 }]}
          >
            <View style={styles.art}>
              {app.art ? (
                <Image source={{ uri: app.art }} style={styles.artImg} resizeMode="contain" />
              ) : (
                <View style={[styles.mono, { backgroundColor: colorFor(app.pkg) }]}>
                  <Text style={styles.monoText}>{app.label.charAt(0).toUpperCase()}</Text>
                </View>
              )}
              {app.removable ? <Ionicons name="trash-outline" size={14} color={colors.textDim} style={styles.trash} /> : null}
            </View>
            <View style={styles.info}>
              <Text style={styles.name} numberOfLines={1}>{app.label}</Text>
              <Text style={styles.pkg} numberOfLines={1}>{app.pkg}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { padding: 24, alignItems: 'flex-start', gap: 12 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: colors.text },
  emptyText: { fontSize: 15, color: colors.textDim, lineHeight: 22 },
  primary: { backgroundColor: colors.shell, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 },
  primaryText: { color: colors.ink, fontWeight: '600' },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginBottom: 12 },
  h2: { fontSize: 24, fontWeight: '700', color: colors.text },
  count: { fontSize: 18, fontWeight: '400', color: colors.textDim },
  install: { backgroundColor: colors.shell, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  installText: { color: colors.ink, fontWeight: '600' },
  filters: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, marginBottom: 12 },
  search: { flex: 1, backgroundColor: colors.paper, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 15, color: colors.text, borderWidth: 1, borderColor: colors.fogDeep },
  seg: { flexDirection: 'row', backgroundColor: colors.fogDeep, borderRadius: 10, padding: 3 },
  segBtn: { paddingHorizontal: 12, justifyContent: 'center', borderRadius: 8 },
  segOn: { backgroundColor: colors.paper },
  segText: { color: colors.textDim, fontSize: 14 },
  segTextOn: { color: colors.text, fontWeight: '600' },
  progress: { backgroundColor: colors.paper, marginHorizontal: 16, padding: 12, borderRadius: 12, marginBottom: 10, borderLeftWidth: 4, borderLeftColor: colors.amber },
  progressText: { color: colors.text },
  hint: { color: colors.textDim, fontSize: 13, paddingHorizontal: 16, marginBottom: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 11 },
  card: { width: '47%', margin: '1.5%', backgroundColor: colors.paper, borderRadius: 12, overflow: 'hidden' },
  current: { borderWidth: 3, borderColor: colors.amber },
  art: { aspectRatio: 16 / 9, backgroundColor: '#e9edf2', alignItems: 'center', justifyContent: 'center' },
  artImg: { width: '100%', height: '100%' },
  mono: { width: 48, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  monoText: { color: '#fff', fontSize: 22, fontWeight: '700' },
  trash: { position: 'absolute', top: 6, right: 6 },
  info: { padding: 10 },
  name: { fontWeight: '600', color: colors.text, fontSize: 15 },
  pkg: { color: colors.textDim, fontSize: 11, marginTop: 2 },
});
