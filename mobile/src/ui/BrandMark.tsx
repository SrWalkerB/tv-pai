import { StyleSheet, Text, View } from 'react-native';
import { colors } from './theme';

// Selos simples com a cor e o nome de cada marca (não são os logotipos oficiais),
// para identificar de relance o que está sendo controlado.
export function FireTvMark({ size = 30 }: { size?: number }) {
  return (
    <View style={[styles.fire, { height: size, paddingHorizontal: size * 0.25, borderRadius: size * 0.22 }]}>
      <Text style={[styles.fireText, { fontSize: size * 0.4 }]}>fire tv</Text>
    </View>
  );
}

export function LgMark({ size = 30 }: { size?: number }) {
  return (
    <View style={[styles.lg, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.lgText, { fontSize: size * 0.42 }]}>LG</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fire: { backgroundColor: colors.amazon, alignItems: 'center', justifyContent: 'center' },
  fireText: { color: '#1a1a1a', fontWeight: '800', letterSpacing: -0.3 },
  lg: { backgroundColor: colors.lg, alignItems: 'center', justifyContent: 'center' },
  lgText: { color: '#fff', fontWeight: '800' },
});
