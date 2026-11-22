// 图集生成脚本共用的紧凑代码输出。
//
// 生成的 src/generated/*.ts 会整段进入运行时脚本包。逐帧写成缩进 JSON 时，
// 同一个目录前缀、同一个页号、`page`/`frame` 字段名会重复上万次。这里把它们编码成：
// - 页表：按页号能推出来的字段（如 `characters-atlas:${i}`）只写一次模板，其余字段按列写成元组；
// - 路径表：连续同目录的条目合成一行字符串 `目录|条目|条目`，条目内字段用逗号分隔；
// - 页号序列：连续相同页号写成 `页号*次数`，段之间用点分隔。
// 生成文件在模块加载时用内联的几行解码器还原成原来的对象，消费方看到的导出名、类型和值都不变。

/** 路径表的分隔符；任何字段里出现它们都无法还原，生成时直接报错。 */
function assertField(value: string, what: string): string {
  if (/[|,\n]/.test(value)) throw new Error(`图集紧凑编码无法表示${what}：${JSON.stringify(value)}`);
  return value;
}

/** 页号序列 → `124*14.125*3`，单个页号省略次数。 */
export function encodeRuns(values: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < values.length;) {
    const value = values[i]!;
    if (!Number.isInteger(value) || value < 0) throw new Error(`图集页号必须是非负整数：${value}`);
    let end = i + 1;
    while (end < values.length && values[end] === value) end++;
    parts.push(end - i === 1 ? String(value) : `${value}*${end - i}`);
    i = end;
  }
  return parts.join('.');
}

/** 生成文件里还原页号序列的函数源码，函数名为 `runs`。 */
export const RUNS_DECODER = `const runs = (text: string): number[] => {
  const out: number[] = [];
  for (const part of text.split('.')) {
    const [value, count] = part.split('*');
    for (let left = count === undefined ? 1 : Number(count); left > 0; left--) out.push(Number(value));
  }
  return out;
};`;

/** 生成文件里遍历路径表的函数源码，函数名为 `eachRow`：回调拿到完整路径和条目内其余字段。 */
export const ROWS_DECODER = `const eachRow = (groups: readonly string[], visit: (file: string, fields: string[]) => void): void => {
  for (const group of groups) {
    const [dir, ...rows] = group.split('|');
    for (const row of rows) {
      const [name, ...fields] = row.split(',');
      visit(\`\${dir}/\${name}.png\`, fields);
    }
  }
};`;

/**
 * 把 `[完整路径, 其余字段]` 按原顺序编码成路径表。连续同目录的条目合成一行，
 * 保证解码后对象的键顺序和输入完全一致。路径必须是 `目录/名字.png`。
 */
export function encodeRows(rows: readonly (readonly [string, readonly string[]])[]): string[] {
  const groups: string[] = [];
  let dir: string | undefined;
  let current: string[] = [];
  for (const [file, fields] of rows) {
    const match = /^(.+)\/([^/]+)\.png$/.exec(file);
    if (!match) throw new Error(`图集紧凑编码只支持 目录/名字.png 形式的路径：${file}`);
    const [, rowDir, name] = match as unknown as [string, string, string];
    assertField(rowDir, '目录');
    const row = [assertField(name, '文件名'), ...fields.map(field => assertField(field, '字段'))].join(',');
    if (rowDir !== dir) {
      if (dir !== undefined) groups.push([dir, ...current].join('|'));
      dir = rowDir;
      current = [];
    }
    current.push(row);
  }
  if (dir !== undefined) groups.push([dir, ...current].join('|'));
  return groups;
}

/** 路径表的源码：每个目录一行，方便 diff。 */
export function rowsSource(groups: readonly string[]): string {
  return `[\n${groups.map(group => `  ${JSON.stringify(group)}`).join(',\n')}\n]`;
}

/**
 * 页表源码。`fields` 是页对象的全部字段（按输出顺序）；其中 `derived` 列出的字段如果每页都等于
 * 同一个含页号的模板（如 `effects-atlas:${i}`），就只写模板，其余字段按列写进元组。
 * 返回的是一个表达式，求值结果与原页表逐字段相同。
 */
export function pagesSource<T extends object>(pages: readonly T[], fields: readonly (keyof T & string)[],
  derived: readonly (keyof T & string)[]): string {
  const templates = new Map<string, string>();
  for (const field of derived) {
    const values = pages.map(page => page[field]);
    if (values.length === 0 || !values.every(value => typeof value === 'string')) continue;
    const first = values[0] as string;
    const at = first.lastIndexOf('0');
    if (at < 0) continue;
    const template = `${first.slice(0, at)}\${i}${first.slice(at + 1)}`;
    if (/[`\\]|\$\{(?!i\})/.test(template)) continue;
    if ((values as string[]).every((value, i) => value === template.replace('${i}', String(i)))) templates.set(field, template);
  }
  const columns = fields.filter(field => !templates.has(field));
  const rows = pages.map(page => `  ${JSON.stringify(columns.map(field => page[field]))}`).join(',\n');
  const props = fields.map(field => templates.has(field)
    ? `${field}: \`${templates.get(field)}\``
    : `${field}: row[${columns.indexOf(field)}]`).join(', ');
  const tuple = columns.map(field => typeof pages[0]?.[field] === 'number' ? 'number' : 'string').join(', ');
  return `(${columns.length === 0 ? '[]' : `[\n${rows}\n]`} as readonly (readonly [${tuple}])[]).map((row, i) => ({ ${props} }))`;
}
