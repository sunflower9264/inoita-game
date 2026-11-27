import { parseCampaign, parseWorld, validateStoryItems } from '../../src/application/content-validation.ts';
import type { WorldMap } from '../../src/domain/content.ts';
import { loadOfficialQuestContent, type QuestHarnessContent } from './quest-e2e-harness.ts';

/**
 * 构造独立于正式剧情与地图的二图合成任务集（所有剧情、任务、地图均在内存中构造并通过正式 parseWorld / parseCampaign / validateStoryItems 校验；
 * 底层物品、属性与敌人数值表复用已校验目录，避免手写冗余词条概率表）。
 */
export function createMiniQuestWorld(): QuestHarnessContent {
  const base = loadOfficialQuestContent();

  const npcTemplate = base.world.actors.darius!;
  const makeActor = (id: string, name: string, description: string, service?: 'fusion-machine') => ({
    ...npcTemplate,
    id,
    name,
    description,
    portrait: null,
    ...(service ? { service } : {}),
  });

  const world = parseWorld({
    version: base.world.version,
    actors: {
      kiyan: base.world.actors.kiyan!,
      captain: makeActor('captain', '营地队长', '守护营地。'),
      quartermaster: makeActor('quartermaster', '军需商人', '买卖物资。'),
      forger: makeActor('forger', '古融合器', '融合机器。', 'fusion-machine'),
      sealstone: makeActor('sealstone', '圣所结界石', '刻着古老铭文。'),
      wolf_captive: makeActor('wolf_captive', '受伤灰狼', '奄奄一息。'),
      horn: makeActor('horn', '警戒号角', '吹响示警。'),
      barricade: makeActor('barricade', '矿道路障', '挡住去路。'),
    },
    portraits: base.world.portraits,
    props: [],
    maps: [
      { id: 'camp', name: '营地', file: 'content/maps/camp.json' },
      { id: 'wilds', name: '猎场', file: 'content/maps/wilds.json' },
    ],
  });

  const makeMap = (id: string, name: string): WorldMap => ({
    id,
    name,
    width: 160,
    height: 160,
    tileSize: 16,
    columns: 10,
    rows: 10,
    blocked: Array.from({ length: 100 }, () => false),
    ground: 'assets/maps/shadow-camp/ground.png',
    canopy: 'assets/maps/shadow-camp/canopy.png',
    features: [],
    entities:
      id === 'camp'
        ? [
            { id: 'ent-captain', actor: 'captain', characterId: 'npc-captain', x: 64, y: 64, flip: false },
            { id: 'ent-qm', actor: 'quartermaster', characterId: 'npc-qm', x: 96, y: 64, flip: false },
            { id: 'ent-forger', actor: 'forger', characterId: 'npc-forger', x: 112, y: 64, flip: false },
            { id: 'ent-seal', actor: 'sealstone', characterId: 'npc-seal', x: 128, y: 64, flip: false },
            { id: 'ent-barricade', actor: 'barricade', characterId: 'npc-barricade', x: 48, y: 96, flip: false },
          ]
        : [
            { id: 'ent-horn-1', actor: 'horn', characterId: 'npc-horn', objective: 'horn', x: 48, y: 48, flip: false },
            { id: 'ent-horn-2', actor: 'horn', characterId: 'npc-horn', objective: 'horn', x: 80, y: 48, flip: false },
          ],
    exits:
      id === 'camp'
        ? [{ id: 'camp-to-wilds', x: 144, y: 64, width: 16, height: 32, destination: 'wilds', spawn: { x: 24, y: 80 }, exitFacing: 'east', facing: 'east' }]
        : [{ id: 'wilds-to-camp', x: 0, y: 64, width: 16, height: 32, destination: 'camp', spawn: { x: 120, y: 80 }, exitFacing: 'west', facing: 'west' }],
    enemySpawns:
      id === 'wilds'
        ? [
            { id: 'wilds-reagent-1', enemyId: 'enemy-reagents-1', x: 96, y: 80 },
            { id: 'wilds-reagent-2', enemyId: 'enemy-reagents-1', x: 112, y: 96 },
            { id: 'wilds-wolf-1', enemyId: 'enemy-wolf-1', x: 80, y: 112 },
          ]
        : [],
    lootLevel: 1,
    townPose: id === 'camp',
  });

  const maps = new Map<string, WorldMap>([
    ['camp', makeMap('camp', '营地')],
    ['wilds', makeMap('wilds', '猎场')],
  ]);

  const campaign = parseCampaign({
    version: 2,
    contentVersion: 1,
    start: { map: 'camp', x: 64, y: 80, facing: 'south', actor: 'kiyan', script: 'start-intro' },
    questGroups: [
      { id: 'grp-main', title: '主线', kind: 'main', questIds: ['q-main-hunt', 'q-gate-confirm', 'q-hidden-gate', 'q-equip-shortcut'] },
      { id: 'grp-side', title: '支线', kind: 'side', questIds: ['q-side-tusk-a', 'q-side-tusk-b', 'q-optional-offer', 'q-repeat-forger', 'q-wolf-capture'] },
    ],
    quests: [
      {
        id: 'q-main-hunt',
        title: '清剿荒原魔物',
        description: '击败试验用精灵并带回灵魂物质交给军需商人。',
        guidance: { available: '找队长', active: '收集灵魂物质' },
        delivery: 'quartermaster',
        deliveryCharacterId: 'npc-qm',
        completion: 'all',
        repeat: false,
        goals: [
          { id: 'kill', kind: 'defeat', target: 'enemy-reagents-1', quantity: 2, label: '试验用精灵' },
          { id: 'mat', kind: 'item', target: 'ectoplasm', quantity: 2, label: '灵魂物质' },
        ],
        onAcceptItems: [{ item: 'west-mine-key', quantity: 1 }],
        itemCompletion: 'all',
        availableWhen: { type: 'all', conditions: [] },
        handoverItems: [{ item: 'ectoplasm', quantity: 2 }],
        rewards: {
          experience: 250,
          money: 120,
          items: [
            { item: 'berkel-plate-armor', quantity: 1, classIds: ['dark-knight', 'warrior'] },
            { item: 'berkel-leather-armor', quantity: 1, classIds: ['assassin', 'ranger'] },
          ],
        },
        offerScript: null,
        completeScript: null,
        progressText: '灵魂物质还没凑齐。',
        completeText: '干得漂亮，这是你的护甲。',
        places: {
          available: { type: 'fixed', map: 'camp', x: 64, y: 64, source: 'quest-available-event' },
          active: { type: 'fixed', map: 'wilds', x: 64, y: 64, source: 'enemy-spawn' },
          ready: { type: 'fixed', map: 'camp', x: 96, y: 64, source: 'quest-delivery' },
        },
      },
      {
        id: 'q-side-tusk-a',
        title: '物质收集甲',
        description: '上交 1 份灵魂物质。',
        guidance: { available: '找队长', active: '收集灵魂物质' },
        giver: 'captain',
        giverCharacterId: 'npc-captain',
        delivery: 'captain',
        deliveryCharacterId: 'npc-captain',
        completion: 'all',
        repeat: false,
        goals: [{ id: 'mat', kind: 'item', target: 'ectoplasm', quantity: 1, label: '灵魂物质' }],
        onAcceptItems: [],
        itemCompletion: 'all',
        availableWhen: { type: 'quest', quest: 'q-main-hunt', status: 'completed' },
        handoverItems: [{ item: 'ectoplasm', quantity: 1 }],
        rewards: { experience: 50, money: 30, items: [] },
        offerScript: null,
        completeScript: null,
        progressText: '还需要灵魂物质。',
        completeText: '收下了。',
      },
      {
        id: 'q-side-tusk-b',
        title: '物质收集乙',
        description: '同样需要上交 1 份灵魂物质。',
        guidance: { available: '找军需商人', active: '收集灵魂物质' },
        giver: 'quartermaster',
        giverCharacterId: 'npc-qm',
        delivery: 'quartermaster',
        deliveryCharacterId: 'npc-qm',
        completion: 'all',
        repeat: false,
        goals: [{ id: 'mat', kind: 'item', target: 'ectoplasm', quantity: 1, label: '灵魂物质' }],
        onAcceptItems: [],
        itemCompletion: 'all',
        availableWhen: { type: 'quest', quest: 'q-main-hunt', status: 'completed' },
        handoverItems: [{ item: 'ectoplasm', quantity: 1 }],
        rewards: { experience: 50, money: 30, items: [] },
        offerScript: null,
        completeScript: null,
        progressText: '还需要灵魂物质。',
        completeText: '收下了。',
      },
      {
        id: 'q-optional-offer',
        title: '可选侦察委托',
        description: '吹响两处警戒号角。',
        guidance: { available: '询问队长', active: '吹响号角' },
        acceptance: 'optional',
        giver: 'captain',
        giverCharacterId: 'npc-captain',
        delivery: 'captain',
        deliveryCharacterId: 'npc-captain',
        completion: 'all',
        repeat: false,
        goals: [{ id: 'horn', kind: 'interact', target: 'horn', characterId: 'npc-horn', quantity: 2, label: '警戒号角' }],
        onAcceptItems: [],
        itemCompletion: 'all',
        availableWhen: { type: 'flag', flag: 'unlock-optional', value: true },
        handoverItems: [],
        rewards: { experience: 80, money: 40, items: [] },
        offerScript: 'offer-optional',
        completeScript: 'complete-optional',
        progressText: '去把两处号角都吹响。',
        completeText: '多谢。',
      },
      {
        id: 'q-repeat-forger',
        title: '古融合器的燃料',
        description: '可重复向融合器投入灵魂物质。',
        guidance: { available: '查看融合器', active: '投入灵魂物质' },
        giver: 'forger',
        giverCharacterId: 'npc-forger',
        delivery: 'forger',
        deliveryCharacterId: 'npc-forger',
        completion: 'all',
        repeat: true,
        goals: [{ id: 'mat', kind: 'item', target: 'ectoplasm', quantity: 1, label: '灵魂物质' }],
        onAcceptItems: [],
        itemCompletion: 'all',
        availableWhen: { type: 'all', conditions: [] },
        handoverItems: [{ item: 'ectoplasm', quantity: 1 }],
        rewards: { experience: 40, money: 25, items: [] },
        offerScript: null,
        completeScript: null,
        progressText: '需要 1 份灵魂物质。',
        completeText: '融合完成！',
      },
      {
        id: 'q-wolf-capture',
        title: '活捉受伤灰狼',
        description: '打残灰狼并捕获。',
        guidance: { available: '找队长', active: '活捉灰狼' },
        giver: 'captain',
        giverCharacterId: 'npc-captain',
        delivery: 'captain',
        deliveryCharacterId: 'npc-captain',
        completion: 'all',
        repeat: false,
        targetChanges: [
          {
            goal: 'wolf',
            enemyId: 'enemy-wolf-1',
            actor: 'wolf_captive',
            removeAfterInteraction: true,
            changedText: '呜咽……',
            interactText: '成功捕获灰狼！',
          },
        ],
        goals: [{ id: 'wolf', kind: 'interact', target: 'wolf_captive', quantity: 1, label: '灰狼' }],
        onAcceptItems: [],
        itemCompletion: 'all',
        availableWhen: { type: 'flag', flag: 'unlock-wolf', value: true },
        handoverItems: [],
        rewards: { experience: 60, money: 35, items: [] },
        offerScript: null,
        completeScript: null,
        progressText: '去打残灰狼再交互捕捉。',
        completeText: '抓回来了！',
      },
      {
        id: 'q-hidden-gate',
        title: '矿道路障_内部',
        description: '日志外路障任务。',
        journal: false,
        guidance: { available: '', active: '' },
        delivery: 'barricade',
        deliveryCharacterId: 'npc-barricade',
        completion: 'all',
        repeat: false,
        goals: [{ id: 'key', kind: 'item', target: 'west-mine-key', quantity: 1 }],
        onAcceptItems: [],
        itemCompletion: 'all',
        availableWhen: { type: 'all', conditions: [] },
        handoverItems: [{ item: 'west-mine-key', quantity: 1 }],
        rewards: { experience: 0, money: 0, items: [] },
        offerScript: null,
        completeScript: null,
        progressText: '锁住了。',
        completeText: '路障打开了。',
      },
      {
        id: 'q-equip-shortcut',
        title: '整备铠甲',
        description: '收集材料或已穿戴板甲。',
        guidance: { available: '整备', active: '整备' },
        giver: 'captain',
        giverCharacterId: 'npc-captain',
        delivery: 'captain',
        deliveryCharacterId: 'npc-captain',
        completion: 'all',
        repeat: false,
        goals: [
          { id: 'step1', kind: 'item', target: 'berkel-plate-armor', quantity: 1, label: '板甲' },
          { id: 'step2', kind: 'item', target: 'ectoplasm', quantity: 3, label: '灵魂物质' },
        ],
        onAcceptItems: [],
        itemCompletion: 'equipped-item-shortcut',
        availableWhen: { type: 'quest', quest: 'q-wolf-capture', status: 'completed' },
        handoverItems: [],
        rewards: { experience: 30, money: 10, items: [] },
        offerScript: null,
        completeScript: null,
        progressText: '还没准备好。',
        completeText: '你已经穿上板甲了！',
      },
      {
        id: 'q-gate-confirm',
        title: '跨越圣所封印',
        description: '确认跨越章节结界。',
        journal: false,
        guidance: { available: '', active: '' },
        delivery: 'sealstone',
        deliveryCharacterId: 'npc-seal',
        interactionEvent: 'ev-seal-prompt',
        completion: 'talk',
        repeat: false,
        goals: [],
        onAcceptItems: [],
        itemCompletion: 'all',
        availableWhen: { type: 'all', conditions: [] },
        handoverItems: [],
        rewards: { experience: 0, money: 0, items: [] },
        offerScript: null,
        completeScript: null,
        progressText: '',
        completeText: '',
      },
    ],
    placements: [],
    enemyPlacements: [],
    exitRules: [],
    mapEntryPlacements: [],
    scripts: {
      'start-intro': {
        entry: 'done',
        nodes: [
          {
            id: 'done',
            presentation: [],
            commands: [{ type: 'flag', flag: 'unlock-optional', value: false }],
            exit: { type: 'end' },
          },
        ],
      },
      'ev-accept-main': {
        entry: 'guard',
        nodes: [
          {
            id: 'guard',
            presentation: [],
            commands: [],
            exit: {
              type: 'branch',
              condition: { type: 'quest', quest: 'q-main-hunt', status: 'accepted' },
              then: { script: 'ev-accept-main', node: 'done' },
              otherwise: { script: 'ev-accept-main', node: 'talk' },
            },
          },
          {
            id: 'talk',
            presentation: [
              { type: 'stage', map: 'camp', x: 64, y: 80, facing: 'north', playerVisible: true, cast: [] },
              { type: 'dialogue', speaker: '营地队长', actor: 'captain', text: '去荒原清剿两只魔物，把灵魂物质交给军需商人。' },
            ],
            commands: [
              { type: 'quest', command: { type: 'accept', quest: 'q-main-hunt' } },
              { type: 'quest', command: { type: 'accept', quest: 'q-hidden-gate' } },
              { type: 'world', command: { kind: 'remove-character', map: 'camp', characterId: 'npc-qm', all: false } },
            ],
            exit: { type: 'next', target: { script: 'ev-accept-main', node: 'popup' } },
          },
          {
            id: 'popup',
            presentation: [{ type: 'quest-popup', kind: 'start', quest: 'q-main-hunt' }],
            commands: [],
            exit: { type: 'next', target: { script: 'ev-accept-main', node: 'done' } },
          },
          { id: 'done', presentation: [], commands: [], exit: { type: 'end' } },
        ],
      },
      'ev-after-main': {
        entry: 'scene',
        nodes: [
          {
            id: 'scene',
            presentation: [
              { type: 'stage', map: 'camp', x: 64, y: 80, facing: 'north', playerVisible: true, cast: [] },
              { type: 'dialogue', speaker: '营地队长', actor: 'captain', text: '主线清剿已完成，圣所结界现已开放！' },
            ],
            commands: [
              { type: 'flag', flag: 'after-main-fired', value: true },
              { type: 'quest', command: { type: 'accept', quest: 'q-gate-confirm' } },
            ],
            exit: { type: 'end' },
          },
        ],
      },
      'offer-optional': {
        entry: 'ask',
        nodes: [
          {
            id: 'ask',
            presentation: [
              { type: 'dialogue', speaker: '营地队长', actor: 'captain', text: '愿意去吹响两座警戒号角吗？' },
              {
                type: 'choice',
                prompt: '是否接受可选侦察委托？',
                options: [
                  { label: '接受', value: 'yes' },
                  { label: '稍后再说', value: 'no' },
                ],
              },
            ],
            commands: [],
            exit: {
              type: 'choice',
              choice: 'ch-optional',
              cases: {
                yes: { script: 'offer-optional', node: 'accept' },
                no: { script: 'offer-optional', node: 'decline' },
              },
            },
          },
          {
            id: 'accept',
            presentation: [],
            commands: [{ type: 'quest', command: { type: 'accept', quest: 'q-optional-offer' } }],
            exit: { type: 'next', target: { script: 'offer-optional', node: 'popup' } },
          },
          {
            id: 'popup',
            presentation: [{ type: 'quest-popup', kind: 'start', quest: 'q-optional-offer' }],
            commands: [],
            exit: { type: 'end' },
          },
          { id: 'decline', presentation: [{ type: 'dialogue', speaker: '营地队长', actor: 'captain', text: '好，随时再来。' }], commands: [], exit: { type: 'end' } },
        ],
      },
      'complete-optional': {
        entry: 'commit',
        nodes: [
          {
            id: 'commit',
            presentation: [{ type: 'dialogue', speaker: '营地队长', actor: 'captain', text: '号角声很响亮！' }],
            commands: [
              { type: 'quest', command: { type: 'script-complete', quest: 'q-optional-offer' } },
              { type: 'flag', flag: 'unlock-wolf', value: true },
              { type: 'flag', flag: 'unlock-shortcut', value: true },
            ],
            exit: { type: 'next', target: { script: 'complete-optional', node: 'popup' } },
          },
          {
            id: 'popup',
            presentation: [{ type: 'quest-popup', kind: 'complete', quest: 'q-optional-offer' }],
            commands: [],
            exit: { type: 'end' },
          },
        ],
      },
      'ev-seal-prompt': {
        entry: 'ask',
        nodes: [
          {
            id: 'ask',
            presentation: [
              {
                type: 'choice',
                prompt: '跨越圣所将清空当前进行中的支线任务，是否继续？',
                options: [
                  { label: '是，立即跨越', value: 'option-0' },
                  { label: '否，再准备一下', value: 'option-1' },
                ],
              },
            ],
            commands: [],
            exit: {
              type: 'choice',
              choice: 'ch-seal',
              cases: {
                'option-0': { script: 'ev-seal-prompt', node: 'done' },
                'option-1': { script: 'ev-seal-prompt', node: 'done' },
              },
            },
          },
          { id: 'done', presentation: [], commands: [], exit: { type: 'end' } },
        ],
      },
      'ev-seal-confirm': {
        entry: 'battle',
        nodes: [
          {
            id: 'battle',
            presentation: [{ type: 'stage', map: 'camp', x: 64, y: 80, facing: 'north', playerVisible: true, cast: [] }],
            commands: [
              { type: 'quest', command: { type: 'reset-side-quests' } },
              { type: 'quest', command: { type: 'script-complete', quest: 'q-gate-confirm' } },
            ],
            exit: {
              type: 'waitEncounter',
              encounter: {
                id: 'seal-boss',
                map: 'camp',
                status: 'prepared',
                spawns: [{ id: 'golem-1', enemyId: 'enemy-guardian-golem-1', x: 96, y: 96 }],
              },
              outcomes: { won: { script: 'ev-seal-confirm', node: 'victory' } },
            },
          },
          {
            id: 'victory',
            presentation: [{ type: 'dialogue', speaker: '凯恩', actor: 'kiyan', text: '石魔倒下了！' }],
            commands: [{ type: 'flag', flag: 'seal-cleared', value: true }],
            exit: { type: 'end' },
          },
        ],
      },
      'ev-seal-cancel': {
        entry: 'stay',
        nodes: [
          { id: 'stay', presentation: [{ type: 'dialogue', speaker: '凯恩', actor: 'kiyan', text: '先把手头的事办完。' }], commands: [], exit: { type: 'end' } },
        ],
      },
    },
    events: [
      { id: 'ev-accept-main', source: 'region', map: 'camp', region: { x: 48, y: 64, width: 32, height: 32 }, script: 'ev-accept-main', place: { type: 'fixed', map: 'camp', x: 64, y: 80, source: 'event-region' } },
      { id: 'ev-after-main', source: 'quest', key: 'q-main-hunt', script: 'ev-after-main', condition: { type: 'quest', quest: 'q-main-hunt', status: 'completed' }, place: { type: 'current' } },
      { id: 'ev-seal-prompt', source: 'near', near: 'sealstone', nearCharacterId: 'npc-seal', repeat: true, script: 'ev-seal-prompt', condition: { type: 'quest', quest: 'q-gate-confirm', status: 'ready' }, place: { type: 'fixed', map: 'camp', x: 128, y: 64, source: 'authored-placement' } },
      { id: 'ev-seal-confirm', source: 'choice', key: 'ch-seal', script: 'ev-seal-confirm', condition: { type: 'choice', choice: 'ch-seal', value: 'option-0' }, place: { type: 'current' } },
      { id: 'ev-seal-cancel', source: 'choice', key: 'ch-seal', repeat: true, script: 'ev-seal-cancel', condition: { type: 'choice', choice: 'ch-seal', value: 'option-1' }, place: { type: 'current' } },
    ],
  });

  validateStoryItems(campaign, base.items);

  return {
    campaign,
    world,
    maps,
    items: base.items,
    stats: base.stats,
    battle: base.battle,
    storyClasses: base.storyClasses,
    companions: base.companions,
    drops: base.drops,
    springs: base.springs,
    shopActors: new Set(['quartermaster']),
  };
}
