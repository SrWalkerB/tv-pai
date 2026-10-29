import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from './theme';
import type { Tv } from '../useTv';

const mb = (bytes: number) => (bytes / 1048576).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// Barra presa acima das abas: acompanha o envio de um APK de qualquer tela.
export function TransferBar({ tv, onError }: { tv: Tv; onError: (m: string) => void }) {
  const t = tv.transfer;
  const [slide] = useState(() => new Animated.Value(0));

  // Na fase de instalação o pm não informa progresso: a faixa corre de um lado ao outro.
  useEffect(() => {
    if (t?.phase !== 'installing') return;
    const loop = Animated.loop(Animated.timing(slide, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: false }));
    loop.start();
    return () => { loop.stop(); slide.setValue(0); };
  }, [t?.phase, slide]);

  if (!t) return null;

  const pct = t.total ? Math.min(100, Math.round((t.sent / t.total) * 100)) : 0;
  const title = {
    sending: `Enviando ${t.label}`,
    installing: `Instalando ${t.label} na TV…`,
    done: `${t.label} instalado`,
    cancelled: 'Envio cancelado',
    error: 'Não deu para instalar',
  }[t.phase];
  const detail = {
    sending: `${pct}% (${mb(t.sent)} de ${mb(t.total)} MB)`,
    installing: 'Pode levar um minuto. Não dá para cancelar nesta etapa.',
    done: 'Pronto para usar.',
    cancelled: 'Nada foi instalado.',
    error: t.message ?? '',
  }[t.phase];
  const barColor = t.phase === 'error' ? colors.bad : t.phase === 'done' ? colors.ok : colors.amber;

  return (
    <View style={styles.wrap} accessibilityLiveRegion="polite">
      <View style={styles.row}>
        {t.phase === 'done' ? <Ionicons name="checkmark-circle" size={20} color={colors.ok} />
          : t.phase === 'error' ? <Ionicons name="alert-circle" size={20} color={colors.bad} />
            : t.phase === 'cancelled' ? <Ionicons name="close-circle" size={20} color={colors.inkDim} />
              : <ActivityIndicator size="small" color={colors.amber} />}
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <Text style={styles.detail} numberOfLines={2}>{detail}</Text>
        </View>
        {t.phase === 'sending' ? (
          <Pressable style={styles.btn} onPress={tv.cancelInstall} accessibilityLabel="Cancelar o envio">
            <Text style={styles.btnText}>Cancelar</Text>
          </Pressable>
        ) : t.phase === 'done' && t.pkg ? (
          <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => tv.openInstalled().catch((e: Error) => onError(e.message))}>
            <Text style={[styles.btnText, { color: colors.shellEdge }]}>Abrir na TV</Text>
          </Pressable>
        ) : null}
        {t.phase !== 'sending' && t.phase !== 'installing' ? (
          <Pressable onPress={tv.dismissTransfer} hitSlop={10} accessibilityLabel="Fechar aviso">
            <Ionicons name="close" size={20} color={colors.inkDim} />
          </Pressable>
        ) : null}
      </View>
      {t.phase === 'sending' || t.phase === 'installing' || t.phase === 'done' ? (
        <View style={styles.track}>
          {t.phase === 'installing' ? (
            <Animated.View
              style={[styles.fill, { width: '35%', backgroundColor: barColor, marginLeft: slide.interpolate({ inputRange: [0, 1], outputRange: ['-35%', '100%'] }) }]}
            />
          ) : (
            <View style={[styles.fill, { width: `${t.phase === 'done' ? 100 : pct}%`, backgroundColor: barColor }]} />
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: colors.shellEdge, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { color: colors.ink, fontWeight: '600', fontSize: 15 },
  detail: { color: colors.inkDim, fontSize: 13, marginTop: 1 },
  btn: { borderWidth: 1, borderColor: colors.rubberHi, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 },
  btnPrimary: { backgroundColor: colors.amber, borderColor: colors.amber },
  btnText: { color: colors.ink, fontWeight: '600', fontSize: 14 },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.rubber, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
});
