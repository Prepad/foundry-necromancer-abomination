import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../boundary-flesh/rules.js', import.meta.url), 'utf8');
const {freeAvailable, slotLevel, planCosts, allocatePoints, slotUpdates} = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);
const actor = (spells = {}) => ({system:{spells}, _source:{system:{spells:structuredClone(spells)}}});
const zero = {damage:0, armor:0, health:0};

test('normal slots give their level in points; pact slots use their current level', () => {
  const caster = actor({pact:{level:4}});
  for (let level = 1; level <= 9; level++) {
    assert.equal(slotLevel(caster, `spell${level}`), level);
    assert.deepEqual(planCosts(caster, [{key:`spell${level}`, count:1}], undefined, true), {
      spent:{[`spell${level}`]:1}, points:level
    });
  }
  assert.deepEqual(planCosts(caster, [{key:'pact', count:2}], undefined, true), {spent:{pact:2}, points:8});
  for (const key of ['spell0', 'spell10', 'other', undefined]) assert.throws(() => slotLevel(caster, key));
  for (const level of [undefined, 0, -1, 1.5, 10]) assert.throws(() => slotLevel(actor({pact:{level}}), 'pact'));
});

test('sacrifices form one shared budget, while expenditure still counts slots', () => {
  assert.deepEqual(planCosts(actor(), [
    {key:'spell1', count:'2'}, {key:'spell2', count:'1'}, {key:'spell3', count:'1'}
  ], undefined, true), {spent:{spell1:2, spell2:1, spell3:1}, points:7});
  assert.deepEqual(planCosts(actor(), [{key:'spell2', count:1}, {key:'spell2', count:2}], undefined, true), {
    spent:{spell2:3}, points:6
  });
});

test('repeat summon payment is charged separately and gives no upgrade points', () => {
  assert.deepEqual(planCosts(actor(), [{key:'spell2', count:1}], 'spell2', false), {spent:{spell2:2}, points:2});
  assert.deepEqual(planCosts(actor(), [{key:'spell1', count:1}], 'spell9', false), {spent:{spell1:1, spell9:1}, points:1});
  assert.deepEqual(planCosts(actor(), [], 'spell3', false), {spent:{spell3:1}, points:0});
  assert.throws(() => planCosts(actor(), [], undefined, false));
});

test('free summon can keep the base statistics without sacrificing slots', () => {
  assert.deepEqual(planCosts(actor(), [], undefined, true), {spent:{}, points:0});
  assert.deepEqual(allocatePoints(0, zero), {boosts:zero, remaining:0, ac:13, hp:30, dice:2});
});

test('invalid sacrifice counts and unsafe point totals are rejected', () => {
  for (const count of [-1, 0.5, 'bad', undefined, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => planCosts(actor(), [{key:'spell1', count}], undefined, true));
  }
  assert.throws(() => planCosts(actor(), [{key:'spell9', count:Number.MAX_SAFE_INTEGER}], undefined, true));
  assert.throws(() => planCosts(actor(), [{key:'invalid', count:0}], undefined, true));
});

test('each distributed point keeps the existing damage, AC and HP increments', () => {
  assert.deepEqual(allocatePoints(6, {damage:'3', armor:'2', health:'1'}), {
    boosts:{damage:3, armor:2, health:1}, remaining:0, ac:17, hp:45, dice:5
  });
});

test('allocation must use exactly the budget; previews allow a remaining balance', () => {
  assert.throws(() => allocatePoints(3, {damage:4, armor:0, health:0}));
  assert.throws(() => allocatePoints(3, {damage:2, armor:0, health:0}));
  for (const damage of [-1, 0.5, 'bad', undefined, Infinity]) {
    assert.throws(() => allocatePoints(3, {damage, armor:0, health:0}));
  }
  assert.deepEqual(allocatePoints(3, {damage:1, armor:0, health:0}, {complete:false}), {
    boosts:{damage:1, armor:0, health:0}, remaining:2, ac:13, hp:30, dice:3
  });
});

test('slot updates charge slot counts, not the point budget, without mutating the actor', () => {
  const caster = actor({spell3:{value:3}});
  const plan = planCosts(caster, [{key:'spell3', count:1}], 'spell3', false);
  assert.equal(plan.points, 3);
  assert.deepEqual(slotUpdates(caster, plan.spent), {'system.spells.spell3.value':1});
  assert.equal(caster.system.spells.spell3.value, 3);
  assert.throws(() => slotUpdates(caster, {spell3:4}));
  assert.throws(() => slotUpdates(caster, {spell2:1}));
});

test('spent-based models increment the source counter', () => {
  const caster = actor({pact:{level:3, value:2, spent:1}});
  const plan = planCosts(caster, [{key:'pact', count:1}], 'pact', false);
  assert.deepEqual(slotUpdates(caster, plan.spent), {'system.spells.pact.spent':3});
});

test('free summon and legacy expenditure still recover through the existing flags', () => {
  assert.equal(freeAvailable(undefined, undefined), true);
  assert.equal(freeAvailable(false, null), true);
  assert.equal(freeAvailable(true, undefined), false);
  assert.equal(freeAvailable(false, 0), false);
});
