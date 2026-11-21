import type { ScriptAction } from './content.ts';
import type { StoryStage } from './story-performance.ts';
import type { StoryCondition } from './story-condition.ts';
import type { QuestCommand } from './quest-book.ts';
import type { StoryWorldCommand, StoryEncounter } from './story-world.ts';

/** 剧情调用最多可嵌套的层数，播放、地图预取与内容检查共用。 */
export const MAX_STORY_CALL_DEPTH=32;

export interface StoryNodeRef { script: string; node: string }
type StoryPresentationAction = Exclude<ScriptAction, { type: 'party-join' | 'party-leave' }>
  | { type: 'quest-popup'; kind: 'start' | 'complete'; quest: string };
export type StoryCommand =
  | { type:'interaction';target:string;instance:string }
  | { type:'talk'; target:string }
  | { type: 'quest'; command: QuestCommand }
  | { type: 'item-give' | 'item-take'; item: string; quantity: number; allowPartial?: boolean }
  /** 金币的给与取。原版把金币当 ITEMDATABASE 的 0 号记录，事件里用 0x11/0x44 收发。 */
  | { type: 'money-give' | 'money-take'; amount: number; allowPartial?: boolean }
  | { type: 'item-drop'; item:string; quantity:1; map?:string; x:number; y:number }
  | { type: 'flag'; flag: string; value?: boolean }
  | { type: 'choice'; choice: string; value: string }
  | { type: 'party-join' | 'party-leave'; companion: string }
  | { type: 'health' | 'mana'; member: string; value: number | 'full' }
  | { type: 'party-control'; member: string }
  | { type: 'equip'; member: string; item: string; slot: import('./items.ts').EquipmentSlot; create?:boolean; ifPresent?:boolean }
  | {type:'unequip-destroy';member:string;item:string;ifPresent?:boolean}
  | { type: 'world'; command: StoryWorldCommand }
  | { type: 'travel'; destination: { map: string; x: number; y: number; facing: import('./content.ts').Facing } }
  | { type: 'encounter'; encounter: StoryEncounter };
type StoryNodeExit =
  | { type: 'next'; target: StoryNodeRef }
  | { type: 'call'; target: StoryNodeRef; then: StoryNodeRef }
  | { type: 'branch'; condition: StoryCondition; then: StoryNodeRef; otherwise: StoryNodeRef }
  | { type: 'choice'; choice: string; cases: Record<string, StoryNodeRef>; otherwise?: StoryNodeRef }
  | { type: 'waitEncounter'; encounter: StoryEncounter; outcomes: Record<string, StoryNodeRef> }
  | { type: 'defer' | 'end' };
export interface StoryNode {
  id: string;
  presentation: StoryPresentationAction[];
  commands: StoryCommand[];
  /** 从稳定节点恢复时重建的语义舞台。 */
  stage?: StoryStage;
  exit: StoryNodeExit;
}
export interface StoryScript { entry: string; nodes: StoryNode[] }
/** 演出可以由哪些来源触发；内容校验与运行时的快照校验共用这一份。 */
export const STORY_TRIGGER_SOURCES = ['start', 'map-entry', 'region', 'interaction', 'quest', 'inventory', 'choice', 'battle', 'near', 'event'] as const;
export type StoryTriggerSource = typeof STORY_TRIGGER_SOURCES[number];
/** 一个具体落点：哪张图、哪个像素点、依据是什么。 */
export interface StorySpot {
  map: string;
  x: number;
  y: number;
  /** 用了哪一档证据（原版静态摆位、事件触发地图、目标刷点……），排查时看得见。 */
  source: string;
}
/**
 * 一段剧情／一个任务阶段发生在哪。由导出层按原版证据填（`work/tools/game_content/story_places.py`），
 * 运行时只读：`fixed` 是唯一确定的落点，`alternatives` 是多处有依据的入口，`current` 继承现场，
 * `unavailable` 是原版没有入口或证据未闭合。
 */
export type StoryPlace =
  | ({ type: 'fixed' } & StorySpot)
  | { type: 'alternatives'; spots: StorySpot[] }
  | { type: 'current' }
  | { type: 'unavailable'; reason: string };
/** 任务三个阶段各自的地点；缺哪个阶段就说明那一阶段没有证据，不猜。 */
export interface QuestPlaces {
  available?: StoryPlace;
  active?: StoryPlace;
  ready?: StoryPlace;
}
export interface StoryEvent {
  id: string;
  source: StoryTriggerSource;
  script: string;
  key?: string;
  map?: string;
  /** 事件在哪张图哪个点触发；由导出层按原版证据填。 */
  place?: StoryPlace;
  /** 近身触发（原版 near_npc_field）：玩家走到这个角色旁边时起演。 */
  near?: string;
  nearCharacterId?: string;
  region?: { x: number; y: number; width: number; height: number };
  entity?: string;
  condition?: StoryCondition;
  priority?: number;
  repeat?: boolean;
}
export interface StoryGraph { version: 2; scripts: Record<string, StoryScript>; events: StoryEvent[] }

export function storyExitTargets(exit: StoryNodeExit): StoryNodeRef[] {
  switch (exit.type) {
    case 'next': return [exit.target];
    case 'call': return [exit.target, exit.then];
    case 'branch': return [exit.then, exit.otherwise];
    case 'choice': return [...Object.values(exit.cases), ...(exit.otherwise ? [exit.otherwise] : [])];
    case 'waitEncounter': return Object.values(exit.outcomes);
    default: return [];
  }
}

/** 内容加载与构建共享的控制流校验；不执行剧情动作。 */
export function validateStoryGraph(graph: StoryGraph): void {
  if (graph.version !== 2) throw new Error('剧情图版本必须为 2');
  const nodes = new Map<string, StoryNode>();
  const key = (ref: StoryNodeRef): string => JSON.stringify([ref.script, ref.node]);
  for (const [script, definition] of Object.entries(graph.scripts)) {
    if (!definition.nodes.length) throw new Error(`剧情 ${script} 没有节点`);
    for (const node of definition.nodes) {
      const id = key({ script, node: node.id });
      if (!node.id || nodes.has(id)) throw new Error(`剧情 ${script} 节点重复或为空：${node.id}`);
      nodes.set(id, node);
      for (const action of node.presentation) {
        if (action.type === 'choice') {
          if (!action.options.length) throw new Error(`剧情 ${script}/${node.id} 选项为空`);
          if (new Set(action.options.map(option => option.value)).size !== action.options.length)
            throw new Error(`剧情 ${script}/${node.id} 选项值重复`);
        }
      }
      const choices=node.presentation.filter(action=>action.type==='choice');
      if(choices.length>1||choices.length&&node.exit.type!=='choice')throw new Error(`剧情 ${script}/${node.id} 选择需要独立节点与分支出口`);
      if(node.exit.type==='choice'){
        const exit=node.exit;
        if(choices.length!==1)throw new Error(`剧情 ${script}/${node.id} 分支缺少选择表现`);
        const options=choices[0].options.map(option=>option.value);
        if(Object.keys(exit.cases).some(value=>!options.includes(value))||!exit.otherwise&&options.some(value=>!(value in exit.cases)))
          throw new Error(`剧情 ${script}/${node.id} 选项与分支出口不匹配`);
      }
      if (node.exit.type === 'choice' && !Object.keys(node.exit.cases).length) throw new Error(`剧情 ${script}/${node.id} 分支为空`);
      if (node.exit.type === 'waitEncounter' && !Object.keys(node.exit.outcomes).length) throw new Error(`剧情 ${script}/${node.id} 战斗结果为空`);
    }
    if (!definition.nodes.some(node => node.id === definition.entry)) throw new Error(`剧情 ${script} 入口不存在`);
  }
  for (const [id, node] of nodes) for (const target of storyExitTargets(node.exit)) {
    if (!nodes.has(key(target))) throw new Error(`剧情节点 ${id} 引用了不存在的节点 ${target.script}/${target.node}`);
  }
  const events = new Set<string>();
  for (const event of graph.events) {
    if (!event.id || events.has(event.id)) throw new Error(`剧情事件标识重复或为空：${event.id}`);
    events.add(event.id);
    if (!graph.scripts[event.script]) throw new Error(`剧情事件 ${event.id} 引用了未知脚本 ${event.script}`);
    if (event.priority !== undefined && !Number.isFinite(event.priority)) throw new Error(`剧情事件 ${event.id} 优先级无效`);
  }
  // 反向闭包要求每个节点都能到达结束、延期或战斗等待，封闭循环无法靠内容推进。
  const terminating = new Set([...nodes].filter(([, node]) => ['end', 'defer', 'waitEncounter'].includes(node.exit.type)).map(([id]) => id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of nodes) if (!terminating.has(id) && storyExitTargets(node.exit).some(ref => terminating.has(key(ref)))) {
      terminating.add(id); changed = true;
    }
  }
  for (const id of nodes.keys()) if (!terminating.has(id)) throw new Error(`剧情节点 ${id} 无法退出循环或等待战斗`);
}
