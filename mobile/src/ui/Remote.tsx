import { useRef, useState, type ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors } from './theme';
import type { KeyName } from '../tv/keys';

type IconName = ComponentProps<typeof Ionicons>['name'];

type Props = {
  accent: string;
  press: (key: KeyName, repeat?: boolean) => Promise<void>;
  repeatPolicy: (key: KeyName) => { every: number; max: number };
  supports: (key: KeyName) => boolean;
  typeText: (value: string) => Promise<void>;
  canType: boolean;
  onError: (msg: string) => void;
};

// Manda a tecla ao encostar e, com `repeat`, segue mandando enquanto o dedo fica em cima (como um
// controle de verdade), até um limite de repetições por toque: um dedo esquecido no botão não dispara sem fim.
function usePressKey(k: KeyName, props: Props, repeat?: boolean) {
  const timers = useRef<{ delay?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> }>({});
  const send = (again: boolean) => props.press(k, again).catch((e: Error) => props.onError(e.message));
  const stop = () => { clearTimeout(timers.current.delay); clearInterval(timers.current.every); };
  return {
    onPressIn: () => {
      stop();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      send(false);
      if (repeat) {
        const { every, max } = props.repeatPolicy(k);
        let count = 0;
        timers.current.delay = setTimeout(() => {
          timers.current.every = setInterval(() => {
            if (++count > max) { stop(); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); return; }
            send(true);
          }, every);
        }, 450);
      }
    },
    onPressOut: stop,
  };
}

// Botão de borracha.
function Key({ k, icon, label, size = 58, repeat, props, children, style }: {
  k: KeyName; icon?: IconName; label?: string; size?: number; repeat?: boolean; props: Props;
  children?: React.ReactNode; style?: object;
}) {
  const handlers = usePressKey(k, props, repeat);
  if (!props.supports(k)) return <View style={{ width: size, height: size }} />;
  return (
    <View style={styles.cell}>
      <Pressable
        accessibilityLabel={label}
        {...handlers}
        style={({ pressed }) => [styles.key, { width: size, height: size, borderRadius: size / 2 }, pressed && styles.pressed, style]}
      >
        {children ?? (icon ? <Ionicons name={icon} size={24} color={colors.ink} /> : null)}
      </Pressable>
      {label ? <Text style={styles.cap}>{label}</Text> : null}
    </View>
  );
}

// Balancim vertical (uma peça só, como no controle físico): + em cima, nome no meio, − embaixo.
function RockerHalf({ k, icon, label, props, top }: { k: KeyName; icon: IconName; label: string; props: Props; top: boolean }) {
  const handlers = usePressKey(k, props, true);
  return (
    <Pressable
      accessibilityLabel={label}
      {...handlers}
      style={({ pressed }) => [styles.rockerHalf, top ? styles.rockerTop : styles.rockerBottom, pressed && { backgroundColor: colors.rubberHi }]}
    >
      <Ionicons name={icon} size={26} color={colors.ink} />
    </Pressable>
  );
}

function Rocker({ up, down, name, props }: { up: KeyName; down: KeyName; name: string; props: Props }) {
  if (!props.supports(up)) return <View style={styles.rockerSpace} />;
  return (
    <View style={styles.rocker}>
      <RockerHalf k={up} icon={name === 'CH' ? 'chevron-up' : 'add'} label={`${name} mais`} props={props} top />
      <Text style={styles.rockerName}>{name}</Text>
      <RockerHalf k={down} icon={name === 'CH' ? 'chevron-down' : 'remove'} label={`${name} menos`} props={props} top={false} />
    </View>
  );
}

export function Remote(props: Props) {
  const [draft, setDraft] = useState('');
  const send = async () => {
    if (!draft) return;
    try { await props.typeText(draft); setDraft(''); } catch (e) { props.onError((e as Error).message); }
  };

  return (
    <View style={[styles.remote, { borderTopColor: props.accent }]}>
      <View style={styles.topRow}>
        <Key k="power" icon="power" props={props} size={50} />
        <Key k="input" icon="swap-horizontal" props={props} size={50} />
        <Key k="menu" icon="menu" props={props} size={50} />
      </View>

      <View style={styles.ring}>
        <Key k="up" icon="chevron-up" props={props} size={70} repeat style={styles.dirKey} />
        <View style={styles.ringMiddle}>
          <Key k="left" icon="chevron-back" props={props} size={70} repeat style={styles.dirKey} />
          <Key k="ok" props={props} size={96} style={[styles.ok, { borderColor: props.accent, borderBottomColor: props.accent }]}>
            <Text style={styles.okText}>OK</Text>
          </Key>
          <Key k="right" icon="chevron-forward" props={props} size={70} repeat style={styles.dirKey} />
        </View>
        <Key k="down" icon="chevron-down" props={props} size={70} repeat style={styles.dirKey} />
      </View>

      <View style={styles.grid}>
        <Key k="back" icon="arrow-undo" label="Voltar" props={props} />
        <Key k="home" icon="home-outline" label="Início" props={props} />
        <Key k="del" icon="backspace-outline" label="Apagar" props={props} repeat />
      </View>
      <View style={styles.grid}>
        <Key k="rewind" icon="play-back" label="Retroceder" props={props} repeat />
        <Key k="playpause" icon="play" label="Play/Pausa" props={props} />
        <Key k="forward" icon="play-forward" label="Avançar" props={props} repeat />
      </View>
      <View style={styles.rockers}>
        <Rocker up="volup" down="voldown" name="VOL" props={props} />
        <Key k="mute" icon="volume-mute-outline" label="Mudo" props={props} />
        <Rocker up="chup" down="chdown" name="CH" props={props} />
      </View>

      {props.canType ? (
        <View style={styles.type}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Digitar na TV"
            placeholderTextColor={colors.inkDim}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={send}
            returnKeyType="send"
          />
          <Pressable onPress={send} style={styles.sendBtn}><Text style={styles.sendText}>Enviar</Text></Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  remote: {
    backgroundColor: colors.shell,
    borderRadius: 48,
    paddingVertical: 28,
    paddingHorizontal: 22,
    marginHorizontal: 16,
    shadowColor: colors.shellEdge,
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 16 },
    elevation: 12,
    borderTopWidth: 6,
  },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  cell: { alignItems: 'center' },
  key: {
    backgroundColor: colors.rubber,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 3,
    borderBottomColor: colors.shellEdge,
  },
  pressed: { transform: [{ translateY: 2 }], borderBottomWidth: 1, backgroundColor: colors.rubberHi },
  cap: { color: colors.inkDim, fontSize: 12, marginTop: 6 },
  ring: {
    alignSelf: 'center',
    width: 250,
    height: 250,
    borderRadius: 125,
    backgroundColor: colors.rubber,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    marginBottom: 24,
    borderBottomWidth: 4,
    borderBottomColor: colors.shellEdge,
  },
  ringMiddle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingHorizontal: 6 },
  dirKey: { backgroundColor: 'transparent', borderBottomWidth: 0 },
  ok: { backgroundColor: colors.shell, borderWidth: 3, borderColor: colors.amber, borderBottomWidth: 3, borderBottomColor: colors.amber },
  okText: { color: colors.ink, fontSize: 20, fontWeight: '700' },
  grid: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 18 },
  rockers: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', marginBottom: 22 },
  rocker: {
    width: 64,
    borderRadius: 32,
    backgroundColor: colors.rubber,
    alignItems: 'center',
    overflow: 'hidden',
    borderBottomWidth: 3,
    borderBottomColor: colors.shellEdge,
  },
  rockerSpace: { width: 64 },
  rockerHalf: { width: '100%', height: 62, alignItems: 'center', justifyContent: 'center' },
  rockerTop: { paddingTop: 4 },
  rockerBottom: { paddingBottom: 4 },
  rockerName: { color: colors.inkDim, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  type: { flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.22)', borderRadius: 18, padding: 6, marginTop: 6 },
  input: { flex: 1, color: colors.ink, fontSize: 16, paddingHorizontal: 10 },
  sendBtn: { backgroundColor: colors.amber, borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center' },
  sendText: { color: colors.shellEdge, fontWeight: '600', fontSize: 15 },
});
