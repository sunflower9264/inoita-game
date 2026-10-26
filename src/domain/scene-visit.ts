import type {BattleCatalog} from './battle.ts';
import type {Campaign} from './campaign.ts';
import {rollPlacement} from './chests.ts';
import type {EntityPlacement, WorldIndex, WorldMap} from './content.ts';
import type {DropCatalog} from './drops.ts';
import {NavigationWorld, mirroredCollision} from './navigation-world.ts';
import {choosePartyLanding} from './party-placement.ts';
import {QuestEnemyWatch} from './quest-enemies.ts';
import type {SceneActorState, SceneSnapshot} from './scene-snapshot.ts';
import type {Session} from './session.ts';
import {rollSpring, type SpringCatalog} from './springs.ts';
import {WorldEnemyRoster} from './world-enemies.ts';

export interface SceneVisitInputs {
  session: Session;
  campaign: Campaign;
  world: WorldIndex;
  battleCatalog: BattleCatalog;
  drops: DropCatalog;
  springs: SpringCatalog;
  partyActors?: readonly SceneActorState[];
}

/** 正式进图与剧情预备共用一次访问的宝箱、泉水和人物生成规则。 */
export function generateMapEntities(map:WorldMap,campaign:Campaign,springs:SpringCatalog,level:number,random:()=>number):EntityPlacement[]{
  const authored=campaign.placements.filter(entity=>entity.map===map.id);
  const placed=map.entities.filter(entity=>!authored.some(other=>other.characterId&&entity.characterId
    ?other.characterId===entity.characterId:other.actor===entity.actor))
    .map(entity=>rollPlacement(entity,random)).filter(entity=>entity!==undefined);
  return [...placed,...authored].map(entity=>entity.spring
    ?{...entity,actor:rollSpring(springs,level,random).id}:{...entity});
}

/** 在独立会话中准备地图；正式会话到达时接收同一份随机结果。 */
export function prepareSceneVisit(inputs:SceneVisitInputs,map:WorldMap,player:SceneActorState,random:()=>number=Math.random):SceneSnapshot{
  const {campaign,world,battleCatalog,drops,springs}=inputs;
  const session=inputs.session.createStorySandbox();
  session.restoreState(inputs.session.captureState());
  session.storyWorld.apply({kind:'travel',destination:{map:map.id,x:player.x,y:player.y,facing:player.facing}});
  session.enterMap(map.id,map.questItemSpawns??[],map,map.enemySpawns);
  const level=session.hero?.level??1;
  const generatedEntities=generateMapEntities(map,campaign,springs,level,random);
  const entities=session.storyWorld.projectEntities(map.id,generatedEntities,campaign.placements);
  const navigation=new NavigationWorld(map);
  const actors:SceneActorState[]=entities.map(entity=>{
    const original=world.actors[session.storyWorld.actorAppearance(entity.actor)];
    if(!original)throw new Error(`剧情地图角色缺失：${entity.actor}`);
    const appearance=entity.spring&&session.springs.isEmpty(map.id,entity.id)?world.actors[springs.empty]:original;
    if(!appearance)throw new Error('剧情地图泉水缺少喝空外观');
    const visible=session.visible(entity)&&session.storyWorld.actorVisible(map.id,entity.actor,entity.characterId)
      &&!(original.chest&&session.chests.isOpened(map.id,entity.id,session.storyWorld.isPlaced(entity.id)));
    return {id:`entity:${entity.id}`,actor:entity.actor,worldEntityId:entity.id,characterId:entity.characterId,
      x:entity.x,y:entity.y,
      facing:session.storyWorld.entity(entity.id)?.facing??(entity.flip&&appearance.clips['idle-east']?'east':'south'),
      visible,flip:entity.flip,
      appearance:structuredClone(appearance)};
  });
  const register=(actor:SceneActorState,faction:'neutral'|'party'|'hostile')=>navigation.register({
    shape:()=>({collision:mirroredCollision(actor.appearance?.collision,actor.flip)}),
    position:()=>actor,enabled:()=>actor.visible,faction:()=>faction
  });
  for(const actor of actors)register(actor,'neutral');
  const hero=structuredClone(player);
  hero.id='player';hero.memberId='player';hero.visible=true;
  hero.appearance??=structuredClone(world.actors[hero.actor]);
  if(!hero.appearance)throw new Error('剧情地图缺少主角外观');
  Object.assign(hero,navigation.nearestBody(hero.appearance,hero)??navigation.nearest(hero.appearance,hero));
  actors.unshift(hero);register(hero,'party');
  for(const id of session.party?.activeIds.slice(1)??[]){
    const member=session.party!.get(id);if(!member)continue;
    const previous=inputs.partyActors?.find(actor=>actor.memberId===id);
    const appearance=previous?.appearance??world.actors[member.definition.actor];
    if(!appearance)throw new Error(`剧情地图队员外观缺失：${id}`);
    const position=choosePartyLanding(navigation,appearance,hero)??hero;
    const actor:SceneActorState={id:`member:${id}`,memberId:id,followsPlayer:true,actor:member.definition.actor,
      x:position.x,y:position.y,facing:'south',visible:member.alive,appearance:structuredClone(appearance)};
    actors.push(actor);register(actor,'party');
  }
  const roster=new WorldEnemyRoster(session,map,(campaign.enemyPlacements??[]).filter(enemy=>enemy.map===map.id),level,
    new QuestEnemyWatch(session,drops.questItems),random);
  for(const placed of roster.enemies){
    const definition=battleCatalog.enemies.find(enemy=>enemy.id===placed.enemyId);
    if(!definition?.actor.collision)throw new Error(`剧情地图敌人外观缺失：${placed.enemyId}`);
    const position=navigation.nearestBody(definition.actor,placed)??navigation.nearest(definition.actor,placed);
    roster.moveEnemy(placed.key,position.x,position.y);
    const actor:SceneActorState={id:`enemy:${placed.key}`,actor:definition.actor.id,enemyKey:placed.key,
      enemyId:placed.enemyId,...position,facing:'south',visible:(roster.enemySnapshot(placed.key,definition,level)?.health??0)>0,
      appearance:structuredClone(definition.actor)};
    actors.push(actor);register(actor,'hostile');
  }
  return {map:map.id,actors,visit:{generatedEntities,...roster.capturePreparedState()}};
}
