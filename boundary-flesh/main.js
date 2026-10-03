import {MOD, FEATURE, ATTACK, CAST, freeAvailable, planCosts, slotUpdates} from './rules.js';

const working = new Set();
const isLeader = () => game.user.isGM && game.users.activeGM?.id === game.user.id;
const state = actor => actor.getFlag(MOD, 'summon');
const dead = actor => actor.statuses.has('dead') || actor.system.attributes.death?.failure >= 3;
const fail = error => { console.error(MOD, error); ui.notifications.error(error.message); };

function attackBonus(actor) {
  const ability = actor.system.attributes.spellcasting || 'int';
  const data = actor.getRollData();
  const formula = `${actor.system.abilities[ability]?.mod || 0} + ${actor.system.attributes.prof || 0} + (${actor.system.bonuses.msak?.attack || '0'})`;
  const roll = new Roll(formula, data);
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
  if (dead(caster) || !effect || effect.disabled || !game.actors.has(saved.actorId)) return cleanup(caster);
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

function form(actor, free, bonus) {
  const slots = Object.entries(actor.system.spells).filter(([key,s]) => /^(spell[1-9]|pact)$/.test(key) && s.max > 0);
  const escape = foundry.utils.escapeHTML;
  const options = slots.map(([key,s]) => `<option value="${key}">${escape(key)}: ${s.value}/${s.max}</option>`).join('');
  const rows = slots.map(([key,s]) => `<tr><td>${escape(key)} (${s.value})</td>${['damage','armor','health'].map(stat=>`<td><input name="${key}-${stat}" type="number" min="0" step="1" value="0" style="width:65px"></td>`).join('')}</tr>`).join('');
  return new Promise(resolve => new Dialog({
    title: 'Аберрация Пограничной Плоти — призыв',
    content: `<form><p>${free ? 'Бесплатный призыв доступен.' : 'Бесплатный призыв израсходован: оплата одной ячейкой.'}</p><p>Бесплатный призыв восстанавливается после долгого отдыха.</p>${free ? '' : `<label>Ячейка для оплаты призыва <select name="payment">${options}</select></label>`}<p>Каждая ячейка независимо от уровня даёт одно усиление. Оплата повторного призыва сама усиления не даёт.</p><table><tr><th>Ячейки</th><th>+1d6</th><th>+2 КД</th><th>+15 ХП</th></tr>${rows}</table><p>Атака заклинателя: ${bonus >= 0 ? '+' : ''}${bonus}.</p><p>Токен появится справа от заклинателя; переместите его в согласованное с мастером место. Дальность призыва правилами не указана.</p><p>Призыв занимает действие. Аберрация может действовать сразу.</p></form>`,
    buttons: {summon:{label:'Призвать',callback:html=>{
      const root = html[0];
      resolve({rows:slots.map(([key])=>({key,...Object.fromEntries(['damage','armor','health'].map(stat=>[stat,root.querySelector(`[name="${key}-${stat}"]`).value]))})),paidSlot:root.querySelector('[name="payment"]')?.value});
    }},cancel:{label:'Отмена',callback:()=>resolve(null)}},
    default:'summon',close:()=>resolve(null)
  },{width:560}).render(true));
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
    const plan = planCosts(answer.rows,answer.paidSlot,free);
    const updates = slotUpdates(caster,plan.spent);
    const response = await fetch(`modules/${MOD}/aberration.json`);
    if (!response.ok) throw Error('Не удалось загрузить шаблон аберрации из модуля.');
    const data = await response.json();
    data.name = `Аберрация — ${caster.name}`;
    data.ownership = foundry.utils.deepClone(caster.ownership);
    data.flags = {[MOD]:{createdByModule:true,caster:caster.uuid,boosts:plan.boosts}};
    data.system.attributes.ac.flat = plan.ac;
    data.system.attributes.hp.value = data.system.attributes.hp.max = plan.hp;
    data.system.traits.languages = foundry.utils.deepClone(caster.system.traits.languages);
    data.system.details.biography.value += '<p>Понимает языки заклинателя, но не говорит.</p>';
    const attack = data.items[0].system.activities[ATTACK];
    attack.attack.bonus = String(attackBonus(caster));
    attack.damage.parts[0].number = plan.dice;
    created = await Actor.create(data);
    const activity = feature.system.activities.get(CAST);
    if (!activity) throw Error('Нет активности призыва. Повторно импортируйте особенность.');
    effect = await caster.beginConcentrating(activity,{duration:{},flags:{[MOD]:{summonActor:created.id}}});
    if (!effect) throw Error('Создание концентрации отменено.');
    const tokenData = await created.getTokenDocument({
      x:Math.min(token.document.x + token.document.width * canvas.grid.size,canvas.dimensions.sceneX + canvas.dimensions.sceneWidth - canvas.grid.size),
      y:token.document.y,actorLink:true,
      flags:{[MOD]:{summon:{caster:caster.uuid,actorId:created.id}}}
    });
    [placed] = await canvas.scene.createEmbeddedDocuments('Token',[tokenData.toObject()]);
    if (!placed) throw Error('Не удалось создать токен.');
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
