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
function dialogRoot(config) {
  const fields = new Map([...config.content.matchAll(/<input\b[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)]
    .map(([,name,value]) => [name,{value}]));
  for (const [,name,body] of config.content.matchAll(/<select name="([^"]+)">([\s\S]*?)<\/select>/g)) {
    const options = [...body.matchAll(/<option value="([^"]+)"([^>]*)>/g)];
    fields.set(name, {value:(options.find(([, ,attrs]) => /\bselected\b/.test(attrs)) ?? options[0])?.[1] ?? ''});
  }
  const listeners = {};
  const summary = {textContent:''};
  const form = {addEventListener() {}};
  const buttons = Object.fromEntries(Object.entries(config.buttons).map(([key,button]) => [key, {
    disabled:false,
    click() { if (!this.disabled) { button.callback([root]); config.close(); } }
  }]));
  const root = {
    querySelector(selector) {
      if (selector === 'form') return form;
      if (selector === '[data-summary]') return summary;
      const name = selector.match(/^\[name="([^"]+)"\]$/)?.[1];
      if (name) return fields.get(name);
      return buttons[selector.match(/^\[data-button="([^"]+)"\]$/)?.[1]];
    },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    emit(type, event = {}) { for (const fn of listeners[type] ?? []) fn(event); },
    set(name, value) { assert.ok(fields.has(name), name); fields.get(name).value = String(value); this.emit('input'); },
    value(name) { return fields.get(name)?.value; },
    choose(key) { assert.equal(buttons[key].disabled, false, `${key} must be enabled`); buttons[key].click(); },
    buttons, summary
  };
  return root;
}

async function fixture(scripts, {freeUsed = false, spells, afterPlace} = {}) {
  const errors = [], scriptErrors = [], updates = [], dialogs = [], created = [];
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
    getRollData() { return {}; },
    async unsetFlag(mod, key) { delete flags[key]; },
    async update(changes) {
      updates.push(changes);
      for (const [path,value] of Object.entries(changes)) {
        if (path.startsWith('flags.boundary-flesh.')) flags[path.slice('flags.boundary-flesh.'.length)] = value;
        else {
          const parts = path.split('.');
          let target = caster;
          for (const part of parts.slice(0,-1)) target = target[part];
          target[parts.at(-1)] = value;
        }
      }
    },
    async beginConcentrating() {
      const effect = {id:'concentration', disabled:false, async delete() { effects.delete(this.id); caster.concentration.effects = []; }};
      effects.set(effect.id, effect);
      caster.concentration.effects.push(effect);
      return effect;
    },
    async endConcentration(effect) { await effect.delete(); }
  };
  actors.set(caster.id, caster);
  const scene = {
    id:'scene', tokens,
    async createEmbeddedDocuments(type, data) {
      assert.equal(type, 'Token');
      const token = {...data[0], id:'summon-token', async delete() { tokens.delete(this.id); }};
      tokens.set(token.id, token);
      afterPlace?.(caster);
      return [token];
    }
  };
  const casterToken = {id:'caster-token', actor:caster, document:{x:0,y:0,width:1}};
  const context = vm.createContext({
    console:{error() {}},
    game:{user:{id:'gm',isGM:true},users:{activeGM:{id:'gm'}},items:[],macros:[],actors,scenes:new Documents([[scene.id,scene]])},
    canvas:{tokens:{controlled:[casterToken]},grid:{size:100},dimensions:{sceneX:0,sceneWidth:1000},scene},
    foundry:{utils:{escapeHTML:value => String(value),deepClone:structuredClone}},
    ui:{notifications:{warn:message => errors.push(message),error:message => errors.push(message),info() {}}},
    Roll:class { isDeterministic = true; evaluateSync() { return {total:7}; } },
    fetch:async () => ({ok:true,json:async () => structuredClone(template)}),
    Actor:{async create(data) {
      created.push(data);
      const summon = {id:'summon', async delete() { actors.delete(this.id); }, async getTokenDocument(options) { return {toObject:() => options}; }};
      actors.set(summon.id, summon);
      return summon;
    }},
    Hooks:{once(name, fn) { hooks[name] = fn; }, on() {}},
    Dialog:class {
      constructor(config) { this.config = config; }
      render() {
        const config = this.config;
        dialogs.push(config);
        try {
          const root = dialogRoot(config);
          config.render([root]);
          assert.ok(scripts.length, 'Unexpected extra dialog');
          scripts.shift()(root, config, caster);
        } catch(error) { scriptErrors.push(error); config.close(); }
        return this;
      }
    }
  });
  const main = new vm.SourceTextModule(mainSource, {context});
  const rules = new vm.SourceTextModule(rulesSource, {context});
  await main.link(() => rules);
  await main.evaluate();
  await hooks.ready();
  return {caster,flags,errors,updates,dialogs,created,actors,effects,tokens,
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
