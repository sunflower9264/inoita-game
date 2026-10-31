/** 金额以铜币计；1 金 = 100 银 = 10000 铜。原版货币控件最多显示 9999 金 99 银 99 铜。 */
export function splitMoney(amount: number): { gold: number; silver: number; copper: number } {
  const value = Math.min(99_999_999, Math.max(0, Math.floor(amount)));
  return { gold: Math.floor(value / 10_000), silver: Math.floor(value / 100) % 100, copper: value % 100 };
}

/** 只列非零单位，避免“0金0银5铜”这种长串；全为零时显示 0 铜。 */
export function moneyText(amount: number): string {
  const { gold, silver, copper } = splitMoney(amount), parts: string[] = [];
  if (gold) parts.push(`${gold}金`);
  if (silver) parts.push(`${silver}银`);
  if (copper || !parts.length) parts.push(`${copper}铜`);
  return parts.join('');
}
