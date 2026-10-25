import type { SkillDetail, SkillDisplayRow, SkillRank } from './battle.ts';
import type { DescriptionTextPart } from './description-text.ts';

const VALUE_COLOR = '#00b4ff';
const VALUE_PATTERN = /^([^0-9+\-]*)([+-]?)(\d+(?:\.\d+)?)([\s\S]*)$/;

export interface CompiledSkillDisplay {
  display: SkillDisplayRow[];
  displayValues: number[][];
}

/** 把作者态 details 编译成技能级模板 + 每级数值；任何无法逐字还原的行直接失败。 */
export function compileSkillDisplay(ranks: readonly SkillRank[]): CompiledSkillDisplay {
  if (!ranks.length) throw new Error('技能缺少等级数据');
  const first = ranks[0]!.details;
  if (!first?.length) throw new Error('技能缺少 details，无法编译展示文本');
  const display = first.map(detail => compileDetail(detail));
  const displayValues: number[][] = [];
  for (const rank of ranks) {
    const details = rank.details;
    if (!details || details.length !== display.length)
      throw new Error(`技能 ${rank.level} 级详情行数与首级不一致`);
    const values: number[] = [];
    for (let index = 0; index < details.length; index++) {
      const detail = details[index]!;
      const row = compileDetail(detail);
      if (JSON.stringify(row) !== JSON.stringify(display[index]))
        throw new Error(`技能 ${rank.level} 级详情行 ${index} 的展示格式与首级不一致`);
      const match = VALUE_PATTERN.exec(detail.value);
      if (!match) throw new Error(`技能详情无法解析数值：${detail.value}`);
      const value = Math.abs(Number(match[2] + match[3]));
      if (detail.zeroValue !== undefined && formatSkillDetail(display[index]!, 0).text !== detail.zeroValue)
        throw new Error(`技能详情零值无法还原：${detail.value} / ${detail.zeroValue}`);
      values.push(value);
    }
    displayValues.push(values);
  }
  return { display, displayValues };
}

function compileDetail(detail: SkillDetail): SkillDisplayRow {
  const match = VALUE_PATTERN.exec(detail.value);
  if (!match) throw new Error(`技能详情无法解析数值：${detail.value}`);
  const template = `${match[1]}${match[2]}{v}${match[4]}`;
  if (template.split('{v}').length !== 2) throw new Error(`技能详情模板必须恰好包含一个 {v}：${detail.value}`);
  const parts = detail.valueParts;
  if (parts && parts.length > 1) throw new Error(`技能详情 valueParts 只支持单段：${detail.value}`);
  if (parts?.length && parts[0]!.text !== detail.value)
    throw new Error(`技能详情 valueParts 与 value 不一致：${detail.value}`);
  if (parts?.length && parts[0]!.color !== VALUE_COLOR)
    throw new Error(`技能详情 valueParts 颜色不是 ${VALUE_COLOR}：${detail.value}`);
  return {
    label: detail.label,
    ...(detail.kind ? { kind: detail.kind } : {}),
    ...(detail.effectIndex !== undefined ? { effectIndex: detail.effectIndex } : {}),
    ...(detail.valueSpacing !== undefined ? { valueSpacing: detail.valueSpacing } : {}),
    template,
    decimals: (match[3]!.split('.')[1] ?? '').length,
    highlight: !!parts?.length,
    zeroText: detail.zeroValue ?? '0'
  };
}

/** 运行时按模板还原展示文本；highlight 时整段值使用原版蓝色。 */
export function formatSkillDetail(row: SkillDisplayRow, value: number): { text: string; parts: DescriptionTextPart[] } {
  const text = row.template.replace('{v}', value.toFixed(row.decimals));
  return { text, parts: row.highlight ? [{ text, color: VALUE_COLOR }] : [{ text }] };
}

export interface SkillDetailEntry {
  label: string;
  kind?: 'mana' | 'cooldown' | 'effect';
  effectIndex?: number;
  valueSpacing?: boolean;
  text: string;
  parts: DescriptionTextPart[];
  zeroText: string;
}

/** 统一读取编译后 display 或作者态 details，UI 不需要知道内容来自哪条路径。 */
export function skillDetailEntries(skill: { display?: SkillDisplayRow[] }, rank: Pick<SkillRank, 'details' | 'displayValues'>): SkillDetailEntry[] {
  if (skill.display && rank.displayValues && skill.display.length === rank.displayValues.length) {
    return skill.display.map((row, index) => {
      const value = rank.displayValues![index]!;
      const formatted = formatSkillDetail(row, value);
      return {
        label: row.label,
        kind: row.kind,
        effectIndex: row.effectIndex,
        valueSpacing: row.valueSpacing,
        text: formatted.text,
        parts: formatted.parts,
        zeroText: row.zeroText
      };
    });
  }
  return (rank.details ?? []).map(detail => ({
    label: detail.label,
    kind: detail.kind,
    effectIndex: detail.effectIndex,
    valueSpacing: detail.valueSpacing,
    text: detail.value,
    parts: detail.valueParts ?? [{ text: detail.value }],
    zeroText: detail.zeroValue ?? '0'
  }));
}
