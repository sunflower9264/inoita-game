import type { Campaign, CampaignQuest } from '../../src/domain/campaign.ts';
import type { ActorDefinition, EntityPlacement } from '../../src/domain/content.ts';
import { Session, type SessionState } from '../../src/domain/session.ts';
import { StoryDirector, type StoryUI } from '../../src/domain/story-director.ts';
import type { StoryEvent, StoryNode, StoryScript } from '../../src/domain/story-graph.ts';

/**
 * 任务触发与交付的合成场景，不读取 `public/content`，也不启动 Phaser。
 *
 * 三个触发点：
 * - `accept-event`：区域事件，播一段对白并接取 `hunt`；
 * - `boar-down`：击杀事件，第一只野猪倒下时播一次；
 * - `gate-event`：近身事件，代替普通交付入口结算 `gated`。
 */
export interface QuestScenario {
  campaign: Campaign;
  session: Session;
  director: StoryDirector;
  /** 剧情对白文本，按播放顺序记录。 */
  lines: string[];
  /** 任务弹窗，格式为 `start|complete:任务 id`。 */
  popups: string[];
  /** 把玩家放到起始地图。 */
  travel(): void;
  /** 进入指定区域事件并等剧情收尾。返回是否真的开演。 */
  region(id: string): Promise<boolean>;
  /** 击杀一只任务目标。每次使用新的生成点编号，模拟地图刷出的不同个体。 */
  kill(enemyId?: string): Promise<void>;
  /** 与默认 NPC（发布者兼交付人）交互并等剧情收尾。 */
  interact(characterId?: string): Promise<boolean>;
  /** 推进导演队列到空闲，与 story-native-triggers 的收尾写法一致。 */
  settle(): Promise<void>;
  dispose(): void;
}

const WARDEN = 'warden';
const WARDEN_CHARACTER = 'npc-warden';
const QUEST_HUNT = 'hunt';
const QUEST_GATED = 'gated';

function quest(id: string, patch: Partial<CampaignQuest>): CampaignQuest {
  return {
    id, title: id, description: '', guidance: { available: '去接任务', active: '继续任务' },
    goals: [], completion: 'talk', progressText: '任务还没完成', completeText: '谢谢', ...patch,
  };
}

function end(id: string): StoryNode {
  return { id, presentation: [], commands: [], exit: { type: 'end' } };
}

function createScripts(): Record<string, StoryScript> {
  return {
    opening: { entry: 'end', nodes: [end('end')] },
    offer: {
      entry: 'offer',
      nodes: [{
        id: 'offer',
        presentation: [
          { type: 'dialogue', actor: WARDEN, speaker: '守卫', text: '林子西边有两头野猪。' },
          { type: 'quest-popup', kind: 'start', quest: QUEST_HUNT },
        ],
        commands: [{ type: 'quest', command: { type: 'accept', quest: QUEST_HUNT } }],
        exit: { type: 'end' },
      }],
    },
    aftermath: {
      entry: 'aftermath',
      nodes: [{
        id: 'aftermath',
        presentation: [{ type: 'dialogue', actor: WARDEN, speaker: '守卫', text: '野猪少了一头。' }],
        commands: [],
        exit: { type: 'end' },
      }],
    },
    gate: {
      entry: 'settle',
      nodes: [
        {
          id: 'settle',
          presentation: [],
          commands: [{ type: 'quest', command: { type: 'script-complete', quest: QUEST_GATED } }],
          exit: { type: 'next', target: { script: 'gate', node: 'reward' } },
        },
        {
          id: 'reward',
          presentation: [{ type: 'quest-popup', kind: 'complete', quest: QUEST_GATED }],
          commands: [],
          exit: { type: 'end' },
        },
      ],
    },
  };
}

function createEvents(): StoryEvent[] {
  return [
    {
      id: 'accept-event', source: 'region', script: 'offer', map: 'camp',
      region: { x: 0, y: 0, width: 32, height: 32 },
    },
    { id: 'boar-down', source: 'battle', script: 'aftermath', key: 'defeat:enemy-boar' },
    {
      id: 'gate-event', source: 'near', script: 'gate', map: 'camp',
      near: WARDEN, nearCharacterId: WARDEN_CHARACTER,
    },
  ];
}

export function createQuestCampaign(): Campaign {
  return {
    version: 2,
    contentVersion: 1,
    start: { map: 'camp', actor: 'player', x: 16, y: 16, facing: 'south', script: 'opening' },
    quests: [
      quest(QUEST_HUNT, {
        completion: 'all',
        giver: WARDEN, giverCharacterId: WARDEN_CHARACTER,
        delivery: WARDEN, deliveryCharacterId: WARDEN_CHARACTER,
        goals: [{ id: 'objective', kind: 'defeat', target: 'enemy-boar', quantity: 2, label: '野猪' }],
        rewards: { experience: 120, money: 30, items: [] },
      }),
      quest(QUEST_GATED, {
        completion: 'story',
        interactionEvent: 'gate-event',
        // 默认锁定，由用例先打开开关再接取；否则普通的“再交互一次”会顺手接走它，
        // 掩盖“重复交付不结算”的断言。
        availableWhen: { type: 'flag', flag: 'gate-open' },
        giver: WARDEN, giverCharacterId: WARDEN_CHARACTER,
        delivery: WARDEN, deliveryCharacterId: WARDEN_CHARACTER,
        rewards: { experience: 0, money: 5, items: [] },
      }),
    ],
    questGroups: [],
    placements: [],
    events: createEvents(),
    scripts: createScripts(),
  };
}

const actors: Record<string, ActorDefinition> = {
  [WARDEN]: { id: WARDEN, name: '守卫', description: '' } as ActorDefinition,
};

/**
 * 创建一个完整的合成场景。传入 `saved` 时从该快照恢复任务与世界状态，
 * 用于验证读档后触发不重播、交付不重复结算。
 */
export function questScenario(saved?: SessionState): QuestScenario {
  const campaign = createQuestCampaign();
  const session = new Session(campaign);
  if (saved) session.restoreState(saved);
  else session.applyStoryCommands([{ type: 'travel', destination: { map: 'camp', x: 16, y: 16, facing: 'south' } }]);

  const lines: string[] = [];
  const popups: string[] = [];
  const ui: StoryUI = {
    async dialogue(line) { lines.push(line.text); },
    async choice(_prompt, options) { return options[0]!; },
    async questPopup(kind, quest) { popups.push(kind + ':' + quest.id); },
    closeDialogue() {}, skipDialogue() {}, toast() {},
  };
  const presentation = { begin() {}, async execute() {}, async finish() {}, async release() {} };
  const director = new StoryDirector(campaign, session, ui, () => {}, presentation);
  let nextBoar = 0;

  const settle = async () => {
    for (let count = 0; count < 20; count++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (!director.busy) {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (!director.busy) return;
      }
    }
    throw new Error('剧情没有在有限调度次数内收尾');
  };

  return {
    campaign, session, director, lines, popups, settle,
    travel() {
      session.applyStoryCommands([{ type: 'travel', destination: { map: 'camp', x: 16, y: 16, facing: 'south' } }]);
    },
    async region(id) {
      const played = await director.enterRegion(id, 'camp');
      await settle();
      return played;
    },
    async kill(enemyId = 'enemy-boar') {
      // 不同生成点编号模拟地图刷出的不同个体；同一只的重复死亡回调不会再次计数。
      session.enemyDefeated({ id: `${enemyId}-${++nextBoar}`, enemyId, x: 8, y: 8 });
      await settle();
    },
    async interact(characterId = WARDEN_CHARACTER) {
      const entity: EntityPlacement = { id: 'npc-' + characterId, actor: WARDEN, characterId, x: 32, y: 16 };
      const handled = await director.interact(entity, actors[WARDEN]!);
      await settle();
      return handled;
    },
    dispose() { director.dispose(); },
  };
}
