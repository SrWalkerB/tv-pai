import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { colors } from './theme';
import type { Tv } from '../useTv';

export function ScreenTab({ tv }: { tv: Tv }) {
  const [uri, setUri] = useState<string | null>(null);
  const [note, setNote] = useState('Toque em "Ver tela" para mostrar o que está passando na TV');
  const [auto, setAuto] = useState(false);
  const busy = useRef(false);

  const refresh = async () => {
    if (busy.current) return;
    busy.current = true;
    setNote('Capturando…');
    try {
      setUri(await tv.screenshot());
      setNote(`Atualizada às ${new Date().toLocaleTimeString('pt-BR')}`);
    } catch (e) {
      setUri(null);
      setNote((e as Error).message);
    } finally {
      busy.current = false;
    }
  };

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, tv.net]);

  return (
    <View style={{ paddingHorizontal: 16 }}>
      <View style={styles.screen}>
        {uri ? <Image source={{ uri }} style={styles.img} resizeMode="contain" /> : <Text style={styles.empty}>{note}</Text>}
      </View>
      <View style={styles.bar}>
        <Text style={styles.note} numberOfLines={1}>{uri ? note : ' '}</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Sozinho</Text>
          <Switch value={auto} onValueChange={setAuto} trackColor={{ true: colors.amber, false: colors.fogDeep }} thumbColor={colors.paper} />
          <Pressable style={styles.btn} onPress={refresh}><Text style={styles.btnText}>Ver tela</Text></Pressable>
        </View>
      </View>
      {tv.net !== 'on' ? <Text style={styles.warn}>Ver a tela precisa do modo avançado (em Dispositivos).</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { aspectRatio: 16 / 9, backgroundColor: '#222932', borderRadius: 12, borderWidth: 6, borderColor: '#222932', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  img: { width: '100%', height: '100%' },
  empty: { color: colors.inkDim, textAlign: 'center', padding: 20 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 8 },
  note: { flex: 1, color: colors.textDim, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: colors.textDim, fontSize: 14 },
  btn: { backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.fogDeep, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  btnText: { fontWeight: '600', color: colors.text },
  warn: { color: colors.textDim, marginTop: 12 },
});
