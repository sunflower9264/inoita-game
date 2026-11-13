import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStoryMap } from '../src/domain/story-preparation.ts';
import type { StoryGraph, StoryNode } from '../src/domain/story-graph.ts';

const ref = (node: string) => ({ script: 'story', node });
function graph(nodes: StoryNode[]): StoryGraph { return { version: 2, scripts: { story: { entry: 'start', nodes } }, events: [] }; }
const travel: StoryNode = { id: 'travel', presentation: [], commands: [{ type: 'travel', destination: { map: 'B', x: 1, y: 1, facing: 'south' } }], exit: { type: 'end' } };

test('prepares ordinary travel before earlier dialogue nodes finish, including call returns', () => {
  const content = graph([
    { id: 'start', presentation: [], commands: [], exit: { type: 'call', target: ref('sub'), then: ref('travel') } },
    { id: 'sub', presentation: [], commands: [], exit: { type: 'end' } }, travel,
  ]);
  assert.equal(nextStoryMap(content, { node: ref('start'), stack: [] }, 'A'), 'B');
  assert.equal(nextStoryMap(content, { node: ref('sub'), stack: [ref('travel')] }, 'A'), 'B');
});

test('choice, deferral and cycles stop speculative loading', () => {
  for (const exit of [
    { type: 'choice', choice: 'route', cases: { yes: ref('travel') } },
    { type: 'defer' }, { type: 'next', target: ref('start') },
  ] as StoryNode['exit'][]) {
    assert.equal(nextStoryMap(graph([{ id: 'start', presentation: [], commands: [], exit }, travel]), { node: ref('start'), stack: [] }, 'A'), undefined);
  }
});
