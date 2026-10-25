import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reportAssets } from '../tools/asset-report.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('asset report groups identical files and estimates decoded bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-report-'));
  try {
    await fs.mkdir(path.join(root, 'assets', 'a'), { recursive: true });
    await fs.mkdir(path.join(root, 'assets', 'b'), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(root, 'assets', 'a', 'one.png'), png),
      fs.writeFile(path.join(root, 'assets', 'b', 'two.png'), png),
      fs.writeFile(path.join(root, 'assets', 'b', 'other.png'), Buffer.concat([png, Buffer.from('x')]))
    ]);
    const report = reportAssets(root);
    assert.equal(report.files, 3);
    assert.equal(report.uniqueFiles, 2);
    assert.equal(report.duplicateGroups, 1);
    assert.equal(report.duplicateFiles, 1);
    assert.equal(report.duplicateDecodedBytes, 4);
    assert.equal(report.topDuplicateGroups[0]!.count, 2);
    assert.deepEqual(report.topDuplicateGroups[0]!.files.sort(),
      ['a/one.png', 'b/two.png']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
