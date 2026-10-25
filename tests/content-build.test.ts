import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildContent } from '../tools/content-build.ts';

test('buildContent minifies JSON without changing parsed content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'content-build-'));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  try {
    await fs.mkdir(path.join(source, 'maps'), { recursive: true });
    const campaign = { version: 2, title: '中文', nested: { list: [1, 2, 3], empty: {} } };
    await fs.writeFile(path.join(source, 'campaign.json'), JSON.stringify(campaign, null, 2) + '\n');
    await fs.writeFile(path.join(source, 'maps', 'shadow.json'), '{\n  "id": "shadow",\n  "cells": [1, 2]\n}\n');
    const stats = await buildContent(source, output);
    assert.equal(stats.files, 2);
    assert.ok(stats.outputBytes < stats.sourceBytes);
    const minified = await fs.readFile(path.join(output, 'campaign.json'), 'utf8');
    assert.equal(minified.includes('\n'), false);
    assert.deepEqual(JSON.parse(minified), campaign);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'maps', 'shadow.json'), 'utf8')),
      { id: 'shadow', cells: [1, 2] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('buildContent rejects malformed JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'content-build-bad-'));
  try {
    const source = path.join(root, 'source');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'broken.json'), '{ nope');
    await assert.rejects(buildContent(source, path.join(root, 'output')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
