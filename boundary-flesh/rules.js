export const MOD = 'boundary-flesh';
export const FEATURE = 'boundary-flesh-summon';
export const ATTACK = 'boundaryAttack01';
export const CAST = 'boundarySummon01';

export function freeAvailable(used, legacyLastFree) {
  // Preserve expenditure from versions with the former timestamp-based cooldown.
  return used !== true && (legacyLastFree === undefined || legacyLastFree === null);
}
function count(value, message) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw Error(message);
  return result;
}

export function slotLevel(actor, key) {
  if (!/^(spell[1-9]|pact)$/.test(key)) throw Error('Неверный тип ячейки.');
  const level = key === 'pact' ? actor.system.spells.pact?.level : Number(key.slice(5));
  if (!Number.isInteger(level) || level < 1 || level > 9) throw Error('Не удалось определить уровень ячейки.');
  return level;
}

export function planCosts(actor, rows, paidSlot, free) {
  const spent = {};
  let points = 0;
  const add = (key, value) => {
    slotLevel(actor, key);
    spent[key] = count((spent[key] || 0) + value, 'Слишком много ячеек.');
  };
  for (const row of rows) {
    const value = count(row.count, 'Количество ячеек должно быть целым неотрицательным числом.');
    const level = slotLevel(actor, row.key);
    points = count(points + value * level, 'Слишком много очков усиления.');
    if (value) add(row.key, value);
  }
  if (!free) add(paidSlot, 1);
  return {spent, points};
}

export function allocatePoints(points, allocation, {complete = true} = {}) {
  points = count(points, 'Неверное количество очков усиления.');
  const boosts = Object.fromEntries(['damage', 'armor', 'health'].map(stat => [stat,
    count(allocation[stat], 'Количество очков должно быть целым неотрицательным числом.')
  ]));
  const used = count(boosts.damage + boosts.armor + boosts.health, 'Слишком много очков усиления.');
  if (used > points) throw Error(`Недостаточно очков: доступно ${points}, распределено ${used}.`);
  if (complete && used !== points) throw Error(`Распределите оставшиеся очки: ${points - used}.`);
  return {boosts, remaining: points - used, ac: 13 + 2 * boosts.armor, hp: 30 + 15 * boosts.health, dice: 2 + boosts.damage};
}
export function slotUpdates(actor, spent) {
  const updates = {};
  for (const [key, count] of Object.entries(spent)) {
    const slot = actor.system.spells[key];
    if (!slot || slot.value < count) throw Error(`Недостаточно ячеек: ${key}. Нужно ${count}.`);
    const path = `system.spells.${key}`;
    // 5.2.4 uses value. Also support a source model with a spent counter.
    if (Object.hasOwn(actor._source.system.spells[key], 'spent')) updates[`${path}.spent`] = (slot.spent || 0) + count;
    else updates[`${path}.value`] = slot.value - count;
  }
  return updates;
}
