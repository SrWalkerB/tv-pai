// Códigos infravermelhos de TVs LG (protocolo NEC, endereço 0x04) e a montagem do pulso
// no formato que o ConsumerIrManager do Android espera: durações em µs, começando ligado.

export const IR_FREQUENCY = 38000;

const LG_ADDRESS = 0x04;

export const LG_CODES = {
  power: 0x08,
  input: 0x0b,
  volup: 0x02,
  voldown: 0x03,
  mute: 0x09,
  chup: 0x00,
  chdown: 0x01,
  up: 0x40,
  down: 0x41,
  left: 0x07,
  right: 0x06,
  ok: 0x44,
  back: 0x28,
  home: 0x7c,
  menu: 0x43,
  playpause: 0xb0,
  rewind: 0x8f,
  forward: 0x8e,
} as const;

export type IrKey = keyof typeof LG_CODES;

const HEADER_MARK = 9000;
const HEADER_SPACE = 4500;
const BIT_MARK = 560;
const ONE_SPACE = 1690;
const ZERO_SPACE = 560;

// NEC: cabeçalho, endereço, endereço invertido, comando, comando invertido (bits do menos para o mais significativo).
export function necPattern(address: number, command: number): number[] {
  const bytes = [address & 0xff, ~address & 0xff, command & 0xff, ~command & 0xff];
  const pattern = [HEADER_MARK, HEADER_SPACE];
  for (const byte of bytes) {
    for (let bit = 0; bit < 8; bit++) {
      pattern.push(BIT_MARK, (byte >> bit) & 1 ? ONE_SPACE : ZERO_SPACE);
    }
  }
  pattern.push(BIT_MARK);
  return pattern;
}

// Ritmo do NEC: um quadro a cada 108 ms. Usado para não começar um comando por cima do outro.
export const NEC_PERIOD_MS = 108;

// Cada TV reage de um jeito ao formato do envio, e o celular não tem como saber qual funciona.
// A pessoa testa as variações na tela de ajuste (como o Mi Remote faz) e escolhe a que dá 1 passo.
export type IrStyle = 'single' | 'repeat' | 'double';

export const IR_STYLES: { id: IrStyle; label: string; hint: string }[] = [
  { id: 'single', label: 'Sinal único', hint: 'Um quadro só, o mais curto' },
  { id: 'repeat', label: 'Sinal + repetição', hint: 'Um quadro e o código de repetição do NEC' },
  { id: 'double', label: 'Sinal duplo', hint: 'O mesmo quadro duas vezes' },
];

const NEC_REPEAT = [HEADER_MARK, 2250, BIT_MARK];

export function lgPattern(key: IrKey, style: IrStyle = 'single'): number[] {
  const frame = necPattern(LG_ADDRESS, LG_CODES[key]);
  if (style === 'single') return frame;
  const gap = NEC_PERIOD_MS * 1000 - frame.reduce((a, b) => a + b, 0);
  // "repeat" usa o código de repetição do NEC, que significa "repita o ÚLTIMO comando": se a TV
  // perder o quadro novo, ela repete o anterior. "double" manda o quadro completo de novo.
  return style === 'repeat' ? [...frame, gap, ...NEC_REPEAT] : [...frame, gap, ...frame];
}
