/** 金额以铜币计；1 金 = 100 银 = 10000 铜。原版货币控件最多显示 9999 金 99 银 99 铜。 */
/** 1 银 = 100 铜。 */
const COPPER_PER_SILVER = 100;
/** 1 金 = 100 银 = 10000 铜。 */
const COPPER_PER_GOLD = COPPER_PER_SILVER * 100;
/** 原版货币控件上限：9999 金 99 银 99 铜，再多的金额显示时按上限截断。 */
const MAX_DISPLAYED_COPPER = COPPER_PER_GOLD * 9999 + COPPER_PER_SILVER * 99 + 99;

export function splitMoney(amount: number): { gold: number; silver: number; copper: number } {
  const value = Math.min(MAX_DISPLAYED_COPPER, Math.max(0, Math.floor(amount)));
  return { gold: Math.floor(value / COPPER_PER_GOLD), silver: Math.floor(value / COPPER_PER_SILVER) % COPPER_PER_SILVER, copper: value % COPPER_PER_SILVER };
}

/** 只列非零单位，避免“0金0银5铜”这种长串；全为零时显示 0 铜。 */
export function moneyText(amount: number): string {
  const { gold, silver, copper } = splitMoney(amount), parts: string[] = [];
  if (gold) parts.push(`${gold}金`);
  if (silver) parts.push(`${silver}银`);
  if (copper || !parts.length) parts.push(`${copper}铜`);
  return parts.join('');
}
