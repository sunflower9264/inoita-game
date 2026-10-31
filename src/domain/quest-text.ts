export type QuestTextTone = 'base' | 'title' | 'target' | 'person' | 'muted';
type QuestTextPart = { text: string; tone: QuestTextTone } | { break: true };
const COLOR_TONES: Record<string, QuestTextTone> = { $A: 'title', $R: 'target', $S: 'person', $B: 'base', $G: 'muted' };

/** Original quest strings use two-character color and line-break controls. */
export function questTextParts(value: string): QuestTextPart[] {
  const parts: QuestTextPart[] = [];
  let tone: QuestTextTone = 'base';
  let locked = false, lockNextColor = false;
  for (const token of value.split(/(\$[ABRSG]|&[NPC]|\n)/g)) {
    if (!token) continue;
    if (token === '&C') {
      if (locked) { locked = false; tone = 'base'; }
      else lockNextColor = true;
    } else if (COLOR_TONES[token]) {
      if (!locked) tone = COLOR_TONES[token];
      if (lockNextColor) { locked = true; lockNextColor = false; }
    } else if (token === '&N' || token === '&P' || token === '\n') parts.push({ break: true });
    else parts.push({ text: token, tone });
  }
  return parts;
}
