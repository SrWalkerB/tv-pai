import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from './theme';
import type { KeyName } from '../tv/keys';
import type { IrEvent, IrStats } from '../useTv';

export const KEY_LABELS: Record<KeyName, string> = {
  up: 'Cima', down: 'Baixo', left: 'Esquerda', right: 'Direita', ok: 'OK', back: 'Voltar', home: 'Início', menu: 'Menu',
  playpause: 'Play/Pausa', rewind: 'Retroceder', forward: 'Avançar', volup: 'Volume +', voldown: 'Volume −', mute: 'Mudo',
  power: 'Liga/desliga', del: 'Apagar', input: 'Entrada', chup: 'Canal +', chdown: 'Canal −',
};

// Contador ao vivo do infravermelho: o que saiu, o que está esperando e o que foi descartado.
// Assim dá para ver na hora se um toque virou um sinal só (ou se a TV é que contou dois).
export function IrMeter({ stats, last, onOpen }: { stats: IrStats; last: IrEvent | null; onOpen: () => void }) {
  const lastText = !last ? 'Nenhum sinal enviado ainda'
    : last.result === 'sent' ? `Último: ${KEY_LABELS[last.key]}`
    : last.result === 'dropped' ? `Ignorado: ${KEY_LABELS[last.key]}`
    : `Falhou: ${KEY_LABELS[last.key]}`;
  return (
    <Pressable onPress={onOpen} style={styles.box} accessibilityLabel="Histórico do infravermelho">
      <View style={styles.head}>
        <View style={[styles.dot, stats.sending && styles.dotOn]} />
        <Text style={styles.title}>Infravermelho</Text>
        <Text style={styles.last} numberOfLines={1}>{lastText}</Text>
      </View>
      <View style={styles.stats}>
        <Stat n={stats.sent} label="enviados" />
        <Stat n={stats.queued} label="na fila" strong={stats.queued > 0} />
        <Stat n={stats.dropped} label="ignorados" />
        {stats.errors ? <Stat n={stats.errors} label="falharam" bad /> : null}
      </View>
    </Pressable>
  );
}

function Stat({ n, label, strong, bad }: { n: number; label: string; strong?: boolean; bad?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.n, strong && { color: colors.amber }, bad && { color: colors.bad }]}>{n}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginHorizontal: 16, marginTop: 12, backgroundColor: colors.paper, borderRadius: 12, padding: 12, gap: 8, borderWidth: 1, borderColor: colors.fogDeep },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.fogDeep },
  dotOn: { backgroundColor: colors.bad },
  title: { fontWeight: '700', color: colors.text, fontSize: 14 },
  last: { flex: 1, textAlign: 'right', color: colors.textDim, fontSize: 13 },
  stats: { flexDirection: 'row', gap: 18 },
  stat: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  n: { fontSize: 20, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  label: { color: colors.textDim, fontSize: 13 },
});
