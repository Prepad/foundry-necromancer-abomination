import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const mainSource = await readFile(new URL('../boundary-flesh/main.js', import.meta.url), 'utf8');
const rulesSource = await readFile(new URL('../boundary-flesh/rules.js', import.meta.url), 'utf8');
const template = JSON.parse(await readFile(new URL('../boundary-flesh/aberration.json', import.meta.url), 'utf8'));

class Documents extends Map {
  [Symbol.iterator]() { return this.values(); }
  filter(fn) { return [...this].filter(fn); }
}

// A small dialog DOM fixture: exercise the actual render/input/button callbacks.
function dialogRoot(config, resolve) {
  const fields = new Map([...config.content.matchAll(/<input\b[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)]
    .map(([,name,value]) => [name,{value}]));
  for (const [,name,body] of config.content.matchAll(/<select name="([^"]+)">([\s\S]*?)<\/select>/g)) {
    const options = [...body.matchAll(/<option value="([^"]+)"([^>]*)>/g)];
    fields.set(name, {value:(options.find(([, ,attrs]) => /\bselected\b/.test(attrs)) ?? options[0])?.[1] ?? ''});
  }
  const listeners = {};
  const summary = {textContent:''};
  const form = {addEventListener() {}};
  const buttons = Object.fromEntries(config.buttons.map(button => [button.action, {
    disabled:false,
    click() { if (!this.disabled) Promise.resolve(button.callback({},this,{element:root})).then(resolve); }
  }]));
  const root = {
    querySelector(selector) {
      if (selector === 'form') return form;
      if (selector === '[data-summary]') return summary;
      const name = selector.match(/^\[name="([^"]+)"\]$/)?.[1];
      if (name) return fields.get(name);
      return buttons[selector.match(/^button\[data-action="([^"]+)"\]$/)?.[1]];
    },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    emit(type, event = {}) { for (const fn of listeners[type] ?? []) fn(event); },
    set(name, value) { assert.ok(fields.has(name), name); fields.get(name).value = String(value); this.emit('input'); },
    value(name) { return fields.get(name)?.value; },
    choose(key) { assert.equal(buttons[key].disabled, false, `${key} must be enabled`); buttons[key].click(); },
    close() { resolve(null); },
    buttons, summary
  };
  return root;
}

async function fixture(scripts, {freeUsed = false, spells, afterPlace, generation = 13, systemVersion = '5.2.4'} = {}) {
  const errors = [], scriptErrors = [], updates = [], dialogs = [], created = [], rollFormulas = [], modifierCalls = [];
  const flags = {freeUsed};
  const slots = structuredClone(spells ?? {spell1:{value:3,max:3}, spell2:{value:2,max:2}, spell3:{value:2,max:2}});
  const hooks = {};
  const actors = new Documents();
  const effects = new Documents();
  const tokens = new Documents();
  const caster = {
    id:'caster', uuid:'Actor.caster', name:'Necromancer', ownership:{default:0}, statuses:new Set(), effects,
    system:{spells:slots, details:{level:5}, abilities:{int:{mod:4}}, attributes:{spellcasting:'int',prof:3}, bonuses:{msak:{attack:'0'}}, traits:{languages:{value:['common']}}},
    _source:{system:{spells:structuredClone(slots)}},
    items:[{img:'custom.png', system:{identifier:'boundary-flesh-summon',activities:new Map([['boundarySummon01',{}]])}}],
    concentration:{effects:[]},
    getFlag(mod, key) { return flags[key]; },
    getRollData() { return structuredClone(this.system); },
    async unsetFlag(mod, key) { delete flags[key]; },
    async update(changes) {
      updates.push(changes);
      for (const [path,value] of Object.entries(changes)) {
        if (path.startsWith('flags.boundary-flesh.')) {
          const key = path.slice('flags.boundary-flesh.'.length);
          if (key.startsWith('-=')) delete flags[key.slice(2)];
          else flags[key] = value;
        }
        else {
          const parts = path.split('.');
          let target = caster;
          for (const part of parts.slice(0,-1)) target = target[part];
          target[parts.at(-1)] = value;
        }
      }
    },
    async beginConcentrating() {
      const effect = {id:'concentration', parent:caster, disabled:false, active:true, async delete() { effects.delete(this.id); caster.concentration.effects = []; }};
      effects.set(effect.id, effect);
      caster.concentration.effects.push(effect);
      return effect;
    },
    async endConcentration(effect) { await effect.delete(); }
  };
  actors.set(caster.id, caster);
  const scene = {
    id:'scene', tokens,
    async deleteEmbeddedDocuments(type, ids) {
      assert.equal(type, 'Token');
      for (const id of ids) tokens.delete(id);
    },
    async createEmbeddedDocuments(type, data) {
      assert.equal(type, 'Token');
      const token = {...data[0], id:'summon-token', getFlag:(mod,key) => data[0].flags[mod]?.[key],
        async delete() { tokens.delete(this.id); }};
      tokens.set(token.id, token);
      afterPlace?.(caster);
      return [token];
    }
  };
  const casterToken = {id:'caster-token', actor:caster, document:{x:0,y:0,width:1,elevation:20,...(generation === 14 ? {level:'upper-floor'} : {})}};
  const modern = Number(systemVersion.split('.')[0]) >= 6;
  const modifiers = {combineFields(system, paths, options) {
    modifierCalls.push({system,paths,options});
    return {bonus:paths.map(path => path.split('.').reduce((data,key) => data?.[key], system)?.bonus).filter(Boolean).join(' + ')};
  }};
  if (modern) {
    delete caster.system.bonuses;
    caster.system.rolls = {attack:{bonus:'0',msak:{bonus:'0'}}};
  }
  const DialogV2 = {wait(config) {
    return new Promise(resolve => {
      dialogs.push(config);
      try {
        assert.equal(config.rejectClose,false);
        assert.ok(config.window.title);
        assert.doesNotMatch(config.content,/<form\b/,'DialogV2 supplies the outer form');
        const root = dialogRoot(config,resolve);
        config.render({}, {element:root});
        assert.ok(scripts.length, 'Unexpected extra dialog');
        scripts.shift()(root, config, caster);
      } catch(error) { scriptErrors.push(error); resolve(null); }
    });
  }};
  const ActorClass = {async create(data) {
    created.push(data);
    const attackItem = {system:{identifier:'boundary-flesh-attack',activities:new Map([['boundaryAttack01',data.items[0].system.activities.boundaryAttack01]])},
      async update(changes) { this.system.activities.get('boundaryAttack01').attack.bonus = changes['system.activities.boundaryAttack01.attack.bonus']; }};
    const summon = {id:'summon',items:[attackItem],getFlag:(mod,key) => data.flags[mod]?.[key],
      async delete() { actors.delete(this.id); }, async getTokenDocument(options) { return {toObject:() => options}; }};
    actors.set(summon.id, summon);
    return summon;
  }};
  class Roll {
    constructor(formula, data) {
      rollFormulas.push(formula);
      this.formula = formula.replace(/@([\w.]+)/g, (_,path) => {
        const value = path.split('.').reduce((obj,key) => obj?.[key], data);
        assert.notEqual(value,undefined,`Missing roll data: ${path}`);
        return String(value);
      });
    }
    get isDeterministic() { return !/\d+d\d+/.test(this.formula); }
    evaluateSync() {
      assert.match(this.formula,/^[\d\s+*/().-]+$/);
      return {total:vm.runInNewContext(this.formula)};
    }
  }
  const context = vm.createContext({
    console:{error() {}},
    game:{release:{generation},system:{id:'dnd5e',version:systemVersion},dnd5e:{dataModels:{shared:modern ? {D20RollModificationField:modifiers} : {}}},
      user:{id:'gm',isGM:true},users:{activeGM:{id:'gm'}},items:[],macros:[],actors,scenes:new Documents([[scene.id,scene]])},
    canvas:{tokens:{controlled:[casterToken]},grid:{size:100},dimensions:{sceneX:0,sceneWidth:1000},scene},
    foundry:{utils:{escapeHTML:value => String(value),deepClone:structuredClone},dice:{Roll},applications:{api:{DialogV2}}},
    CONFIG:{Actor:{documentClass:ActorClass}},
    ui:{notifications:{warn:message => errors.push(message),error:message => errors.push(message),info() {}}},
    fetch:async () => ({ok:true,json:async () => structuredClone(template)}),
    Hooks:{once(name, fn) { hooks[name] = fn; }, on(name, fn) { hooks[name] = fn; }}
  });
  const main = new vm.SourceTextModule(mainSource, {context});
  const rules = new vm.SourceTextModule(rulesSource, {context});
  await main.link(() => rules);
  await main.evaluate();
  await hooks.ready();
  return {caster,flags,errors,updates,dialogs,created,actors,effects,tokens,rollFormulas,modifierCalls,
    hook:(name,...args) => hooks[name](...args),
    dismiss:() => context.BoundaryFlesh.dismiss(),
    async run() {
      await context.BoundaryFlesh.summon();
      if (scriptErrors.length) throw scriptErrors[0];
      assert.equal(scripts.length, 0);
    }
  };
}

test('two stages preview and distribute weighted points, then charge the actual slots', async () => {
  const h = await fixture([
    root => { root.set('spell2-count',1); root.set('spell3-count',1); assert.match(root.summary.textContent,/Очков усиления: 5/); root.choose('next'); },
    root => {
      assert.equal(h.updates.length,0);
      assert.equal(root.buttons.summon.disabled,true);
      root.set('damage',6);
      assert.equal(root.buttons.summon.disabled,true);
      root.set('damage',2); root.set('armor',1); root.set('health',2);
      assert.match(root.summary.textContent,/КД 15, ХП 60, урон 4d6/);
      root.choose('summon');
    }
  ]);
  await h.run();
  assert.deepEqual(h.errors,[]);
  assert.equal(h.dialogs.length,2);
  assert.equal(h.caster.system.spells.spell2.value,1);
  assert.equal(h.caster.system.spells.spell3.value,1);
  assert.equal(h.created[0].system.attributes.ac.flat,15);
  assert.equal(h.created[0].system.attributes.ac.override,15);
  assert.equal(h.created[0].system.attributes.hp.max,60);
  assert.equal(h.created[0].items[0].system.activities.boundaryAttack01.damage.parts[0].number,4);
  assert.equal(h.flags.freeUsed,true);
});

for (const step of [1,2]) test(`cancel on step ${step} spends nothing and creates nothing`, async () => {
  const scripts = step === 1 ? [root => root.choose('cancel')] : [root => {root.set('spell3-count',1); root.choose('next');}, root => root.choose('cancel')];
  const h = await fixture(scripts);
  await h.run();
  assert.deepEqual(h.errors,[]);
  assert.equal(h.updates.length,0);
  assert.equal(h.created.length,0);
  assert.equal(h.flags.freeUsed,false);
});

test('back preserves choices and revalidates allocations against the changed budget', async () => {
  const h = await fixture([
    root => {root.set('spell3-count',1); root.choose('next');},
    root => {root.set('armor',3); root.choose('back');},
    root => {assert.equal(root.value('spell3-count'),'1'); root.set('spell3-count',0); root.set('spell1-count',1); root.choose('next');},
    root => {assert.equal(root.value('armor'),'3'); assert.equal(root.buttons.summon.disabled,true); root.set('armor',1); root.choose('summon');}
  ]);
  await h.run();
  assert.deepEqual(h.errors,[]);
  assert.equal(h.created[0].system.attributes.ac.flat,15);
  assert.equal(h.caster.system.spells.spell3.value,2);
  assert.equal(h.caster.system.spells.spell1.value,2);
});

test('zero sacrificed slots still allows a base summon through both stages', async () => {
  const h = await fixture([root => root.choose('next'), root => root.choose('summon')]);
  await h.run();
  assert.deepEqual(h.errors,[]);
  assert.equal(h.created[0].system.attributes.hp.max,30);
  assert.equal(h.caster.system.spells.spell1.value,3);
});

test('repeat payment reserves a slot and does not add its level to the budget', async () => {
  const h = await fixture([
    root => {root.set('payment','spell3'); root.set('spell1-count',1); assert.match(root.summary.textContent,/Очков усиления: 1/); root.choose('next');},
    root => {root.set('damage',1); root.choose('summon');}
  ], {freeUsed:true});
  await h.run();
  assert.deepEqual(h.errors,[]);
  assert.equal(h.caster.system.spells.spell3.value,1);
  assert.equal(h.caster.system.spells.spell1.value,2);
  assert.equal(h.created[0].items[0].system.activities.boundaryAttack01.damage.parts[0].number,3);
});

test('repeat payment and sacrifices cannot consume the same last slot twice', async () => {
  const h = await fixture([root => {
    root.set('spell1-count',1);
    assert.equal(root.buttons.next.disabled,true);
    assert.match(root.summary.textContent,/Недостаточно ячеек/);
    root.choose('cancel');
  }], {freeUsed:true,spells:{spell1:{value:1,max:1}}});
  await h.run();
  assert.equal(h.updates.length,0);
});

test('resources depleted during step two abort before creating the summon', async () => {
  const h = await fixture([
    root => {root.set('spell2-count',1); root.choose('next');},
    (root,config,caster) => {root.set('damage',2); caster.system.spells.spell2.value = 0; root.choose('summon');}
  ]);
  await h.run();
  assert.equal(h.created.length,0);
  assert.equal(h.updates.length,0);
  assert.match(h.errors[0],/Недостаточно ячеек/);
});

test('resource updates use the latest balance after asynchronous creation', async () => {
  const h = await fixture([
    root => {root.set('spell1-count',1); root.choose('next');},
    root => {root.set('damage',1); root.choose('summon');}
  ], {afterPlace:caster => {caster.system.spells.spell1.value = 2;}});
  await h.run();
  assert.deepEqual(h.errors,[]);
  assert.equal(h.caster.system.spells.spell1.value,1);
});

test('a failed final resource check rolls back token, actor and concentration', async () => {
  const h = await fixture([
    root => {root.set('spell1-count',1); root.choose('next');},
    root => {root.set('damage',1); root.choose('summon');}
  ], {afterPlace:caster => {caster.system.spells.spell1.value = 0;}});
  await h.run();
  assert.match(h.errors[0],/Недостаточно ячеек/);
  assert.equal(h.updates.length,0);
  assert.equal(h.actors.size,1);
  assert.equal(h.tokens.size,0);
  assert.equal(h.effects.size,0);
  assert.equal(h.flags.freeUsed,false);
});

test('pact level changes during allocation require restarting without spending slots', async () => {
  const h = await fixture([
    root => {root.set('pact-count',1); root.choose('next');},
    (root,config,caster) => {root.set('damage',3); caster.system.spells.pact.level = 4; root.choose('summon');}
  ], {spells:{pact:{value:2,max:2,level:3}}});
  await h.run();
  assert.match(h.errors[0],/Уровень пожертвованных ячеек изменился/);
  assert.equal(h.created.length,0);
  assert.equal(h.updates.length,0);
});

test('pact level changes during creation also roll back the uncharged summon', async () => {
  const h = await fixture([
    root => {root.set('pact-count',1); root.choose('next');},
    root => {root.set('damage',3); root.choose('summon');}
  ], {spells:{pact:{value:2,max:2,level:3}},afterPlace:caster => {caster.system.spells.pact.level = 4;}});
  await h.run();
  assert.match(h.errors[0],/Уровень пожертвованных ячеек изменился/);
  assert.equal(h.updates.length,0);
  assert.equal(h.actors.size,1);
  assert.equal(h.tokens.size,0);
  assert.equal(h.effects.size,0);
  assert.equal(h.flags.freeUsed,false);
});

for (const [generation,systemVersion] of [[13,'5.2.4'],[13,'5.3.3'],[14,'5.3.3'],[14,'6.0.6']]) {
  test(`Foundry ${generation} / D&D 5e ${systemVersion}: summon statistics, payment and placement`, async () => {
    const h = await fixture([
      root => {root.set('spell3-count',1); root.choose('next');},
      root => {root.set('damage',1); root.set('armor',1); root.set('health',1); root.choose('summon');}
    ], {generation,systemVersion});
    if (h.caster.system.rolls) h.caster.system.rolls.attack.msak.bonus = '2';
    else h.caster.system.bonuses.msak.attack = '2';
    await h.run();
    assert.deepEqual(h.errors,[]);
    assert.equal(h.caster.system.spells.spell3.value,1);
    const data = h.created[0];
    assert.equal(data.system.attributes.ac.flat,15);
    assert.equal(data.system.attributes.ac.override,15);
    assert.equal(data.system.attributes.hp.max,45);
    const activity = data.items[0].system.activities.boundaryAttack01;
    assert.equal(activity.attack.bonus,'9');
    assert.equal(activity.damage.parts[0].number,3);
    const token = h.tokens.get('summon-token');
    assert.equal(token.elevation,20);
    if (generation === 14) assert.equal(token.level,'upper-floor');
    else assert.equal(Object.hasOwn(token,'level'),false);
  });
}

test('D&D 5e 6 combines ability, global and melee spell bonuses without counting the legacy shim', async () => {
  const h = await fixture([root => root.choose('next'),root => root.choose('summon')], {generation:14,systemVersion:'6.0.6'});
  h.caster.system.bonuses = {msak:{attack:'999'}};
  h.caster.system.abilities.int.attack = {roll:{bonus:'1'}};
  h.caster.system.rolls.attack.bonus = '2';
  h.caster.system.rolls.attack.msak.bonus = '3';
  await h.run();
  assert.deepEqual(h.errors,[]);
  const activity = h.created[0].items[0].system.activities.boundaryAttack01;
  assert.equal(activity.attack.bonus,'13');
  assert.ok(h.modifierCalls.length > 0);
  for (const {options} of h.modifierCalls) {
    assert.equal(options.rules.actor,h.caster);
    assert.equal(options.rules.category,'attack');
    assert.equal(options.rules.rollData.roll.type,'attack');
    assert.equal(options.rules.rollData.roll.ability,'int');
    assert.equal(options.rules.rollData.roll.attack.classification,'spell');
    assert.equal(options.rules.rollData.roll.attack.type,'melee');
  }
  h.caster.system.rolls.attack.msak.bonus = '4';
  await h.hook('updateActor',h.caster);
  assert.equal(activity.attack.bonus,'14');
});

test('D&D 5e 6 attack bonus formulas receive the spellcasting modifier', async () => {
  const h = await fixture([root => root.choose('next'),root => root.choose('summon')], {generation:14,systemVersion:'6.0.6'});
  h.caster.system.rolls.attack.msak.bonus = '@mod / 2';
  await h.run();
  assert.deepEqual(h.errors,[]);
  assert.equal(h.created[0].items[0].system.activities.boundaryAttack01.attack.bonus,'9');
});

test('D&D 5e 6 random attack bonuses are rejected before spending resources', async () => {
  const h = await fixture([], {generation:14,systemVersion:'6.0.6'});
  h.caster.system.rolls.attack.bonus = '1d4';
  await h.run();
  assert.match(h.errors[0],/содержит кости/);
  assert.equal(h.dialogs.length,0);
  assert.equal(h.updates.length,0);
  assert.equal(h.created.length,0);
});

for (const step of [1,2]) test(`closing DialogV2 on step ${step} cancels without expenditure`, async () => {
  const scripts = step === 1 ? [root => root.close()]
    : [root => {root.set('spell3-count',1); root.choose('next');},root => root.close()];
  const h = await fixture(scripts, {generation:14,systemVersion:'6.0.6'});
  await h.run();
  assert.deepEqual(h.errors,[]);
  assert.equal(h.updates.length,0);
  assert.equal(h.created.length,0);
  assert.equal(h.flags.freeUsed,false);
});

test('Enter cannot submit an incomplete allocation in DialogV2', async () => {
  const h = await fixture([
    root => {root.set('spell3-count',1); root.choose('next');},
    root => {
      let prevented = 0, stopped = 0;
      const enter = {key:'Enter',preventDefault() {prevented++;},stopPropagation() {stopped++;}};
      root.emit('keydown',enter);
      assert.equal(prevented,1);
      assert.equal(stopped,1);
      assert.equal(root.buttons.summon.disabled,true);
      assert.equal(h.updates.length,0);
      root.set('damage',3);
      root.emit('keydown',enter);
    }
  ], {generation:14,systemVersion:'6.0.6'});
  await h.run();
  assert.deepEqual(h.errors,[]);
  assert.equal(h.created[0].items[0].system.activities.boundaryAttack01.damage.parts[0].number,5);
});

for (const reason of ['dismiss','inactive concentration']) test(`Foundry 14 removes the summon after ${reason}`, async () => {
  const h = await fixture([root => root.choose('next'),root => root.choose('summon')], {generation:14,systemVersion:'6.0.6'});
  await h.run();
  assert.equal(h.tokens.size,1);
  if (reason === 'dismiss') await h.dismiss();
  else {
    const effect = h.effects.get('concentration');
    effect.active = false;
    await h.hook('updateActiveEffect',effect);
  }
  assert.deepEqual(h.errors,[]);
  assert.equal(h.actors.size,1);
  assert.equal(h.tokens.size,0);
  assert.equal(h.effects.size,0);
  assert.equal(h.flags.summon,undefined);
  assert.equal(h.flags.freeUsed,true);
});

test('inactive concentration during creation rolls back the uncharged summon', async () => {
  const h = await fixture([root => root.choose('next'),root => root.choose('summon')], {
    generation:14,systemVersion:'6.0.6',afterPlace:caster => {caster.effects.get('concentration').active = false;}
  });
  await h.run();
  assert.match(h.errors[0],/Состояние заклинателя изменилось/);
  assert.equal(h.updates.length,0);
  assert.equal(h.actors.size,1);
  assert.equal(h.tokens.size,0);
  assert.equal(h.effects.size,0);
});

test('D&D 5e 6 long rest restores the free summon and clears its legacy flag', async () => {
  const h = await fixture([], {generation:14,systemVersion:'6.0.6',freeUsed:true});
  h.flags.lastFree = 'legacy';
  await h.hook('dnd5e.restCompleted',h.caster,{}, {type:'short'});
  assert.equal(h.flags.freeUsed,true);
  assert.equal(h.flags.lastFree,'legacy');
  await h.hook('dnd5e.restCompleted',h.caster,{}, {type:'long'});
  assert.deepEqual(h.errors,[]);
  assert.equal(h.flags.freeUsed,false);
  assert.equal(h.flags.lastFree,undefined);
});
