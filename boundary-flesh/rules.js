export const MOD = 'boundary-flesh';
export const FEATURE = 'boundary-flesh-summon';
export const ATTACK = 'boundaryAttack01';
export const CAST = 'boundarySummon01';

export function freeAvailable(used, legacyLastFree) {
  // Preserve expenditure from versions with the former timestamp-based cooldown.
  return used !== true && (legacyLastFree === undefined || legacyLastFree === null);
}
export function planCosts(rows, paidSlot, free) {
  const spent = {};
  const boosts = {damage: 0, armor: 0, health: 0};
  const add = (key, value) => {
    if (!/^(spell[1-9]|pact)$/.test(key)) throw Error('Неверный тип ячейки.');
    spent[key] = (spent[key] || 0) + value;
  };
  for (const row of rows) {
    for (const stat of Object.keys(boosts)) {
      const value = Number(row[stat]);
      if (!Number.isSafeInteger(value) || value < 0) throw Error('Количество ячеек должно быть целым неотрицательным числом.');
      boosts[stat] += value;
      if (value) add(row.key, value);
    }
  }
  if (!free) add(paidSlot, 1);
  return {spent, boosts, ac: 13 + 2 * boosts.armor, hp: 30 + 15 * boosts.health, dice: 2 + boosts.damage};
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
