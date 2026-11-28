import type Phaser from 'phaser';
import type { ActorDefinition, EntityPlacement, Facing, WorldMap } from '../domain/content.ts';
import type { Cooldown } from '../domain/combat.ts';
import type { GameRectangle, Point } from '../domain/navigation.ts';
import type { CharacterVisual } from '../rendering/characters.ts';
import type { MovementWorld } from '../rendering/movement-world.ts';

/**
 * 战斗的世界协作能力。世界场景另外把完整 Phaser.Scene 交给渲染组件，
 * 引擎服务则按实际使用列出，避免把整个场景当成战斗接口。
 */
export interface CombatWorldHost {
  /** 渲染组件和 Phaser 系统需要的完整场景；不属于世界协作接口。 */
  readonly phaserScene: Phaser.Scene;
  readonly cameras: Phaser.Scene['cameras'];
  readonly events: Phaser.Scene['events'];
  readonly time: Phaser.Scene['time'];
  readonly tweens: Phaser.Scene['tweens'];
  readonly game: Phaser.Scene['game'];
  readonly canCombatControl:boolean;
  readonly map?:WorldMap;
  readonly entities:readonly EntityPlacement[];
  readonly player?:CharacterVisual;
  readonly movement?:MovementWorld;
  facing:Facing;
  combatEnemyIds():string[];
  equipmentAppearance(id:string):ActorDefinition|undefined;
  handleCombatDefeat():void;
  offensiveSkillCompleted(actorId:string):void;
  preparePartyMember(id:string,signal?:AbortSignal,options?:{full?:boolean;pin?:boolean}):Promise<void>;
  preparePlayerAppearance():Promise<void>;
  refreshCombatHud(cooldowns?:Readonly<Record<string,Cooldown>>):void;
  refreshCombatTarget():void;
  reviveMember(id:string):{ok:boolean;reason?:string};
  lootLanding(map:string,x:number,y:number):{x:number;y:number};
  refreshGroundLoot():void;
  syncControlledCharacter(resetExitTrigger?:boolean):void;
  /** 当前地图对非受控队友禁入的活动区域剧情矩形（排除队长已踏入的区域）。 */
  activeStoryRegions?(excludeAt?:Point):readonly GameRectangle[];
}
