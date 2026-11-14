import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../tools/diagnostics-report.mjs', import.meta.url));

test('records without a web session remain visible to diag:list and diag:session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inotia-report-'));
  try {
    const lines = [
      { id: 'gm:1', kind: 'gm-state', time: '2026-01-01T00:00:00.000Z', details: { flags: ['a'] } },
      { id: 'web:1', session: 'web-session', kind: 'heartbeat', time: '2026-01-01T00:00:01.000Z', details: {} },
    ];
    await writeFile(path.join(root, 'client-session.jsonl'),
      lines.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const listed = (await run(process.execPath, [script, '--dir', root])).stdout;
    assert.match(listed, /\(无会话\)/);
    const timeline = (await run(process.execPath, [script, '--dir', root, '--session', '(无会话)'])).stdout;
    assert.match(timeline, /gm-state/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
