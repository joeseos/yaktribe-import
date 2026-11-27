import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMapping, threadCategory } from '../src/mapping.ts';

const mapping = parseMapping(`source,key,category,tags,category_name
forum,1,musings,
forum,2,other-games,Mordheim
move,battle report;batrep;bat rep,battle-reports,musings`);

test('move: whole words or their plural in the title, any case', () => {
  assert.equal(threadCategory(mapping, 'musings', 'Goliaths vs Escher - Battle Report', []), 'battle-reports');
  assert.equal(threadCategory(mapping, 'musings', 'BatRep: first game', []), 'battle-reports');
  assert.equal(threadCategory(mapping, 'musings', 'Battle Reports thread', []), 'battle-reports');
  assert.equal(threadCategory(mapping, 'musings', 'Combat reports for skills', []), 'musings');
  assert.equal(threadCategory(mapping, 'musings', 'Bat replacement wings', []), 'musings');
});

test('move: XenForo tags the same way', () => {
  assert.equal(threadCategory(mapping, 'musings', 'Week 3', ['Batrep']), 'battle-reports');
  assert.equal(threadCategory(mapping, 'musings', 'Week 3', ['necromunda battle reports']), 'battle-reports');
  assert.equal(threadCategory(mapping, 'musings', 'Week 3', ['battlefield']), 'musings');
});

test('move: only from the listed categories', () => {
  assert.equal(threadCategory(mapping, 'other-games', 'Mordheim battle report', ['batrep']), 'other-games');
});

test('move rows need words, a category and the categories it takes from', () => {
  assert.throws(() => parseMapping('forum,1,musings,\nmove,batrep,battle-reports,'), /slugs it takes threads from/);
  assert.throws(() => parseMapping('forum,1,musings,\nmove,,battle-reports,musings'), /needs words/);
});

test('a move from a category no forum goes into is a mistake', () => {
  assert.throws(() => parseMapping('forum,1,musings,\nmove,batrep,battle-reports,musing'), /no forum goes into: musing/);
});
