import {MOD, FEATURE, ATTACK, CAST, freeAvailable, slotLevel, planCosts, allocatePoints, slotUpdates} from './rules.js';

const working = new Set();
const isLeader = () => game.user.isGM && game.users.activeGM?.id === game.user.id;
const state = actor => actor.getFlag(MOD, 'summon');
const dead = actor => actor.statuses.has('dead') || actor.system.attributes.death?.failure >= 3;
const fail = error => { console.error(MOD, error); ui.notifications.error(error.message); };

async function refreshSummonArtwork() {
  const oldImage = 'icons/magic/death/undead-zombie-grave-green.webp';
  const portrait = `modules/${MOD}/assets/aberration-portrait.png`;
  const tokenImage = `modules/${MOD}/assets/aberration-token.png`;
  const featureImage = `modules/${MOD}/assets/summon-feature.png`;
  const features = [...game.items, ...[...game.actors].flatMap(actor => [...actor.items])];
  for (const item of features) {
    if (item.system.identifier === FEATURE && item.img === oldImage) await item.update({img: featureImage});
  }
  for (const macro of game.macros) {
    if (macro.type === 'script' && /BoundaryFlesh\.(summon|dismiss)\(/.test(macro.command) && macro.img === oldImage) {
      await macro.update({img: featureImage});
    }
  }
  for (const actor of game.actors) {
    if (actor.getFlag(MOD, 'createdByModule') !== true) continue;
    const changes = {};
    if (actor.img === oldImage) changes.img = portrait;
    if (actor.prototypeToken.texture.src === oldImage) changes['prototypeToken.texture.src'] = tokenImage;
    if (Object.keys(changes).length) await actor.update(changes);
  }
  for (const scene of game.scenes) {
    const updates = scene.tokens.filter(token => token.getFlag(MOD, 'summon') && token.texture.src === oldImage)
      .map(token => ({_id: token.id, 'texture.src': tokenImage}));
    if (updates.length) await scene.updateEmbeddedDocuments('Token', updates);
  }
}

function attackBonus(actor) {
  const ability = actor.system.attributes.spellcasting || 'int';
  const data = actor.getRollData();
  let bonus;
  const modifiers = game.dnd5e?.dataModels?.shared?.D20RollModificationField;
  if (modifiers && actor.system.rolls?.attack) {
    // D&D 5e 6 stores actor attack bonuses and conditional rules in roll modifiers.
    data.mod = actor.system.abilities[ability]?.mod || 0;
    data.roll = {...data.roll, ability, type:'attack', attack:{classification:'spell', type:'melee'}};
    bonus = modifiers.combineFields(actor.system, [
      `abilities.${ability}.attack.roll`, 'rolls.attack', 'rolls.attack.msak'
    ], {rules:{category:'attack', actor, rollData:data}}).bonus || '0';
  } else bonus = actor.system.bonuses?.msak?.attack || '0';
  const formula = `${actor.system.abilities[ability]?.mod || 0} + ${actor.system.attributes.prof || 0} + (${bonus})`;
  const roll = new foundry.dice.Roll(formula, data);
  if (!roll.isDeterministic) throw Error('Бонус атаки заклинанием содержит кости. Уберите случайный бонус из общего модификатора; добавляйте его в диалоге атаки.');
  return roll.evaluateSync().total;
}

async function cleanup(caster) {
  if (!isLeader() || working.has(caster.uuid)) return;
  const saved = state(caster);
  if (!saved) return;
  working.add(caster.uuid);
  try {
    for (const scene of game.scenes) {
      const ids = scene.tokens.filter(t => t.getFlag(MOD, 'summon')?.caster === caster.uuid && t.getFlag(MOD, 'summon')?.actorId === saved.actorId).map(t => t.id);
      if (ids.length) await scene.deleteEmbeddedDocuments('Token', ids);
    }
    const summon = game.actors.get(saved.actorId);
    if (summon?.getFlag(MOD, 'createdByModule') === true) await summon.delete();
    await caster.unsetFlag(MOD, 'summon');
    const effect = caster.effects.get(saved.effectId);
    if (effect) await effect.delete();
  } finally { working.delete(caster.uuid); }
}

async function reconcile(caster) {
  const saved = state(caster);
  if (!saved) return;
  const effect = caster.effects.get(saved.effectId);
  if (dead(caster) || !effect || effect.disabled || effect.active === false || !game.actors.has(saved.actorId)) return cleanup(caster);
}

async function syncAttack(caster) {
  const saved = state(caster);
  const summonActor = saved && game.actors.get(saved.actorId);
  if (!summonActor) return;
  const attackItem = summonActor.items.find(i=>i.system.identifier === 'boundary-flesh-attack');
  const bonus = String(attackBonus(caster));
  if (attackItem && attackItem.system.activities.get(ATTACK).attack.bonus !== bonus) {
    await attackItem.update({[`system.activities.${ATTACK}.attack.bonus`]:bonus});
  }
}

function watchForm(root, action, describe) {
  const button = root.querySelector(`button[data-action="${action}"]`);
  const update = () => {
    try {
      const {text, valid} = describe(root);
      root.querySelector('[data-summary]').textContent = text;
      button.disabled = !valid;
    } catch (error) {
      root.querySelector('[data-summary]').textContent = error.message;
      button.disabled = true;
    }
  };
  root.addEventListener('input', update);
  root.addEventListener('change', update);
  root.querySelector('form').addEventListener('submit', event => event.preventDefault());
  // Keep Enter subject to the same validation as the visible button.
  root.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    update();
    button.click();
  }, true);
  update();
}

function chooseSlots(actor, free, previous) {
  const slots = Object.entries(actor.system.spells).filter(([key,s]) => /^(spell[1-9]|pact)$/.test(key) && s.max > 0);
  const label = key => key === 'pact' ? `Договор, ${slotLevel(actor, key)} ур.` : `${slotLevel(actor, key)} ур.`;
  const options = slots.filter(([,s]) => s.value > 0).map(([key,s]) => `<option value="${key}" ${previous.paidSlot === key ? 'selected' : ''}>${label(key)}: ${s.value}/${s.max}</option>`).join('');
  const rows = slots.map(([key,s]) => {
    const value = previous.rows.find(row => row.key === key)?.count ?? 0;
    return `<tr><td>${label(key)}</td><td>${s.value}/${s.max}</td><td>${slotLevel(actor, key)}</td><td><input aria-label="Пожертвовать ячейки: ${label(key)}" name="${key}-count" type="number" min="0" max="${s.value}" step="1" value="${foundry.utils.escapeHTML(String(value))}" style="width:75px"></td></tr>`;
  }).join('');
  const read = root => ({rows: slots.map(([key]) => ({key, count:root.querySelector(`[name="${key}-count"]`).value})), paidSlot:root.querySelector('[name="payment"]')?.value});
  const budget = answer => {
    if (!free && !answer.paidSlot) throw Error('Нет доступных ячеек для оплаты призыва.');
    const plan = planCosts(actor, answer.rows, answer.paidSlot, free);
    slotUpdates(actor, plan.spent);
    return plan;
  };
  return foundry.applications.api.DialogV2.wait({
    window:{title:'Аберрация — шаг 1 из 2: жертва ячеек'},
    position:{width:600},
    content: `<div><p>${free ? 'Бесплатный призыв доступен.' : 'Бесплатный призыв израсходован: оплата одной ячейкой.'} Бесплатный призыв восстанавливается после долгого отдыха.</p>${free ? '' : `<label>Ячейка для оплаты призыва <select name="payment">${options}</select></label>`}<p>Каждая пожертвованная ячейка даёт очки по своему уровню: 1-й — 1 очко, 2-й — 2, 3-й — 3 и так далее. Ячейка для оплаты повторного призыва очков не даёт.</p><table><tr><th>Ячейки</th><th>Доступно</th><th>Очков за ячейку</th><th>Пожертвовать</th></tr>${rows}</table><p data-summary aria-live="polite"></p><p>Ячейки будут списаны только после подтверждения призыва на втором шаге.</p></div>`,
    render:(event,dialog) => watchForm(dialog.element, 'next', root => {
      const plan = budget(read(root));
      return {text:`Очков усиления: ${plan.points}. Всего будет списано ячеек: ${Object.values(plan.spent).reduce((sum,value) => sum + value, 0)}.`, valid:true};
    }),
    buttons:[{action:'next', default:true, label:'Далее: распределить очки', callback:async (event,button,dialog) => {
      try {
        const answer = read(dialog.element);
        budget(answer);
        return answer;
      } catch(error) { ui.notifications.warn(error.message); return false; }
    }}, {action:'cancel', label:'Отмена', callback:async () => false}],
    rejectClose:false
  });
}

function distributePoints(points, bonus, previous) {
  const stats = [['damage', 'Урон: +1d6'], ['armor', 'КД: +2'], ['health', 'ХП: +15']];
  const rows = stats.map(([stat,label]) => `<tr><td>${label}</td><td><input aria-label="${label}" name="${stat}" type="number" min="0" max="${points}" step="1" value="${foundry.utils.escapeHTML(String(previous[stat]))}" style="width:75px"></td></tr>`).join('');
  const read = root => Object.fromEntries(stats.map(([stat]) => [stat,root.querySelector(`[name="${stat}"]`).value]));
  return foundry.applications.api.DialogV2.wait({
    window:{title:'Аберрация — шаг 2 из 2: распределение очков'},
    position:{width:600},
    content:`<div><p>Доступно очков усиления: <strong>${points}</strong>. Распределите все очки. Одно очко даёт одну из прибавок; усиления суммируются.</p><table><tr><th>Прибавка за очко</th><th>Потратить очков</th></tr>${rows}</table><p data-summary aria-live="polite"></p><p>Атака заклинателя: ${bonus >= 0 ? '+' : ''}${bonus}.</p><p>Токен появится справа от заклинателя; переместите его в согласованное с мастером место. Дальность призыва правилами не указана.</p><p>Призыв занимает действие. Аберрация может действовать сразу.</p></div>`,
    render:(event,dialog) => watchForm(dialog.element, 'summon', root => {
      const plan = allocatePoints(points, read(root), {complete:false});
      return {text:`Осталось очков: ${plan.remaining}. Итог: КД ${plan.ac}, ХП ${plan.hp}, урон ${plan.dice}d6.`, valid:plan.remaining === 0};
    }),
    buttons:[{action:'summon', default:true, label:'Призвать', callback:async (event,button,dialog) => {
      try { return {boosts:allocatePoints(points, read(dialog.element)).boosts}; }
      catch(error) { ui.notifications.warn(error.message); return false; }
    }}, {action:'back', label:'Назад: выбрать ячейки', callback:async (event,button,dialog) => ({back:true, boosts:read(dialog.element)})},
    {action:'cancel', label:'Отмена', callback:async () => false}],
    rejectClose:false
  });
}

async function form(actor, free, bonus) {
  let selection = {rows:[], paidSlot:undefined};
  let boosts = {damage:0, armor:0, health:0};
  for (;;) {
    const chosen = await chooseSlots(actor, free, selection);
    if (!chosen) return null;
    selection = chosen;
    const {points} = planCosts(actor, selection.rows, selection.paidSlot, free);
    const allocation = await distributePoints(points, bonus, boosts);
    if (!allocation) return null;
    boosts = allocation.boosts;
    if (!allocation.back) return {...selection, boosts, points};
  }
}

async function summon() {
  if (!game.user.isGM) return ui.notifications.warn('Этот макрос запускает мастер, выбрав токен некроманта.');
  if (!isLeader()) return ui.notifications.warn('Призыв запускает основной активный мастер.');
  const token = canvas.tokens.controlled[0];
  const caster = token?.actor;
  if (!caster || canvas.tokens.controlled.length !== 1) return ui.notifications.warn('Выберите ровно один токен некроманта.');
  if (working.has(caster.uuid)) return;
  working.add(caster.uuid);
  let created, effect, placed, charged = false;
  try {
    if (dead(caster)) throw Error('Мёртвый персонаж не может призывать.');
    const feature = caster.items.find(i => i.system.identifier === FEATURE);
    if (!feature) throw Error('Сначала добавьте особенность из JSON на лист некроманта.');
    if ((caster.system.details.level || 0) < 5) throw Error('Особенность доступна с 5-го уровня персонажа.');
    if (state(caster)) throw Error('Уже есть аберрация. Отмените её отдельным макросом перед новым призывом.');
    const free = freeAvailable(caster.getFlag(MOD,'freeUsed'),caster.getFlag(MOD,'lastFree'));
    const bonus = attackBonus(caster);
    const answer = await form(caster,free,bonus);
    if (!answer) return;
    // Revalidate after the dialog: resources/time/actor may have changed.
    if (dead(caster) || state(caster)) throw Error('Состояние заклинателя изменилось. Повторите призыв.');
    const stillFree = freeAvailable(caster.getFlag(MOD,'freeUsed'),caster.getFlag(MOD,'lastFree'));
    if (stillFree !== free) throw Error('Доступность бесплатного призыва изменилась. Повторите призыв.');
    const budget = planCosts(caster,answer.rows,answer.paidSlot,free);
    if (budget.points !== answer.points) throw Error('Уровень пожертвованных ячеек изменился. Повторите призыв.');
    const plan = {...budget,...allocatePoints(budget.points,answer.boosts)};
    slotUpdates(caster,plan.spent);
    const response = await fetch(`modules/${MOD}/aberration.json`);
    if (!response.ok) throw Error('Не удалось загрузить шаблон аберрации из модуля.');
    const data = await response.json();
    data.name = `Аберрация — ${caster.name}`;
    data.ownership = foundry.utils.deepClone(caster.ownership);
    data.flags = {[MOD]:{createdByModule:true,caster:caster.uuid,boosts:plan.boosts}};
    data.system.attributes.ac.flat = plan.ac;
    data.system.attributes.ac.override = plan.ac;
    data.system.attributes.hp.value = data.system.attributes.hp.max = plan.hp;
    data.system.traits.languages = foundry.utils.deepClone(caster.system.traits.languages);
    data.system.details.biography.value += '<p>Понимает языки заклинателя, но не говорит.</p>';
    const attack = data.items[0].system.activities[ATTACK];
    attack.attack.bonus = String(attackBonus(caster));
    attack.damage.parts[0].number = plan.dice;
    created = await CONFIG.Actor.documentClass.create(data);
    const activity = feature.system.activities.get(CAST);
    if (!activity) throw Error('Нет активности призыва. Повторно импортируйте особенность.');
    effect = await caster.beginConcentrating(activity,{duration:{},flags:{[MOD]:{summonActor:created.id}}});
    if (!effect) throw Error('Создание концентрации отменено.');
    const tokenData = await created.getTokenDocument({
      x:Math.min(token.document.x + token.document.width * canvas.grid.size,canvas.dimensions.sceneX + canvas.dimensions.sceneWidth - canvas.grid.size),
      y:token.document.y, elevation:token.document.elevation ?? 0, actorLink:true,
      ...(token.document.level !== undefined ? {level:token.document.level} : {}),
      flags:{[MOD]:{summon:{caster:caster.uuid,actorId:created.id}}}
    });
    [placed] = await canvas.scene.createEmbeddedDocuments('Token',[tokenData.toObject()]);
    if (!placed) throw Error('Не удалось создать токен.');
    if (dead(caster) || state(caster) || !caster.effects.has(effect.id) || effect.disabled || effect.active === false) throw Error('Состояние заклинателя изменилось. Повторите призыв.');
    if (freeAvailable(caster.getFlag(MOD,'freeUsed'),caster.getFlag(MOD,'lastFree')) !== free) throw Error('Доступность бесплатного призыва изменилась. Повторите призыв.');
    if (planCosts(caster,answer.rows,answer.paidSlot,free).points !== plan.points) throw Error('Уровень пожертвованных ячеек изменился. Повторите призыв.');
    const updates = slotUpdates(caster,plan.spent);
    await caster.update({...updates,[`flags.${MOD}.summon`]:{actorId:created.id,effectId:effect.id},...(free ? {[`flags.${MOD}.freeUsed`]:true} : {})});
    charged = true;
    // Replace prior concentration only after the new summon has been committed.
    for (const old of [...caster.concentration.effects]) if (old.id !== effect.id) await caster.endConcentration(old);
    if (game.combat?.scene?.id === canvas.scene.id) {
      const summonerCombatant = game.combat.combatants.find(c=>c.tokenId === token.id);
      await game.combat.createEmbeddedDocuments('Combatant',[{tokenId:placed.id,actorId:created.id,sceneId:canvas.scene.id,initiative:summonerCombatant?.initiative ?? null}]);
    }
    ui.notifications.info(`Призвана аберрация: КД ${plan.ac}, ХП ${plan.hp}, урон ${plan.dice}d6, атака ${bonus >= 0 ? '+' : ''}${bonus}. Может действовать в этот ход.`);
  } catch(error) {
    if (!charged) {
      if (placed) await placed.delete().catch(console.error);
      if (effect) await effect.delete().catch(console.error);
      if (created) await created.delete().catch(console.error);
    }
    // After commit, do not refund or delete a successfully created summon because combat setup failed.
    fail(error);
  } finally {
    working.delete(caster.uuid);
    if (charged) await reconcile(caster).catch(fail);
  }
}

async function dismiss() {
  if (!isLeader()) return ui.notifications.warn('Отмену призыва выполняет основной мастер.');
  const caster = canvas.tokens.controlled[0]?.actor;
  if (!caster || !state(caster)) return ui.notifications.warn('Выберите токен некроманта с активной аберрацией.');
  await cleanup(caster);
}

Hooks.once('ready', async()=>{
  globalThis.BoundaryFlesh = {summon,dismiss};
  if (isLeader()) {
    await refreshSummonArtwork().catch(fail);
    const actors = [...game.actors,...[...game.scenes].flatMap(s=>s.tokens.filter(t=>!t.actorLink).map(t=>t.actor).filter(Boolean))];
    for (const caster of actors) await reconcile(caster).catch(fail);
  }
});
Hooks.on('dnd5e.preUseActivity',activity=>{
  if (activity.item.system.identifier !== FEATURE) return;
  ui.notifications.warn('Для призыва используйте макрос «Призвать аберрацию»: он учитывает ячейки и усиления.');
  return false;
});
Hooks.on('deleteActiveEffect',effect=>{
  if (!isLeader() || !state(effect.parent)) return;
  if (state(effect.parent).effectId === effect.id) cleanup(effect.parent).catch(fail);
  else syncAttack(effect.parent).catch(fail);
});
Hooks.on('updateActiveEffect',async effect=>{
  if (!isLeader() || !state(effect.parent)) return;
  await reconcile(effect.parent).catch(fail);
  await syncAttack(effect.parent).catch(fail);
});
Hooks.on('createActiveEffect',async effect=>{
  if (!isLeader() || !state(effect.parent)) return;
  await reconcile(effect.parent).catch(fail);
  await syncAttack(effect.parent).catch(fail);
});
Hooks.on('updateActor',async actor=>{
  if (!isLeader()) return;
  await reconcile(actor).catch(fail);
  await syncAttack(actor).catch(fail);
});
Hooks.on('deleteActor',actor=>{
  if (!isLeader()) return;
  if (state(actor)) cleanup(actor).catch(fail);
  for (const caster of game.actors) if (state(caster)?.actorId === actor.id) cleanup(caster).catch(fail);
});

Hooks.on('dnd5e.restCompleted', async (actor, result, config) => {
  if (!isLeader() || config?.type !== 'long') return;
  try {
    await actor.update({[`flags.${MOD}.freeUsed`]:false, [`flags.${MOD}.-=lastFree`]:null});
  } catch(error) { fail(error); }
});
