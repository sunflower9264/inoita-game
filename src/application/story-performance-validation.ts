import type { ClipName, DialogueLine, WorldIndex, WorldMap } from '../domain/content.ts';
import type { Campaign } from '../domain/campaign.ts';
import type { AudioCatalog } from './game-audio.ts';
import { storyExitTargets, type StoryNodeRef } from '../domain/story-graph.ts';
import type { PerformanceAction } from '../domain/story-performance.ts';
import { mapPlacementCandidates } from '../domain/map-placement.ts';
import { NavigationWorld, type NavigationActor, type Placement } from '../domain/navigation-world.ts';

/** 加载时核对演出引用；构建提供地图后同时检查整段走位。 */
export function validateStoryPerformance(world: WorldIndex, campaign: Campaign, maps?: ReadonlyMap<string, WorldMap>, audio?: Pick<AudioCatalog, 'music' | 'effects'>): void {
  for (const event of campaign.events) {
    if (event.map && !world.maps.some(map => map.id === event.map)) throw new Error(`剧情事件地图缺失 ${event.map}`);
  }
  for (const name of Object.keys(campaign.scripts)) {
    let mapId = campaign.start.map, dynamicMap = false;
    interface Member { actor:string; x:number; y:number; visible:boolean; unpositioned?:boolean; characterId?:string; worldEntityId?:string; scenery?:boolean }
    const cast = new Map<string, Member>();
    let navigation: NavigationWorld | undefined;
    const participants = new Map<string, NavigationActor>();
    const ensure = (condition: unknown, message: string): void => { if (!condition) throw new Error(`剧情 ${name}: ${message}`); };
    const visit = (action: PerformanceAction, validateEnd = true): void => {
      if (action.type === 'parallel') {
        const flattened = (a: PerformanceAction): Exclude<PerformanceAction, {type:'parallel'}>[] => a.type === 'parallel' ? a.actions.flatMap(flattened) : [a];
        const children = action.actions.flatMap(flattened), before = new Map(cast);
        // 各路线读取同一组起点；所有终点一起校验，不依赖子动作的排列顺序。
        for (const child of children) { cast.clear(); for (const [id, member] of before) cast.set(id, member); visit(child, false); }
        cast.clear(); for (const [id, member] of before) cast.set(id, member);
        for (const child of children) updatePosition(child);
        validatePositions(); return;
      }
      if (action.type === 'sound') { ensure(!audio || audio.effects[action.sound], `音效缺失 ${action.sound}`); return; }
      if (action.type === 'music') { ensure(action.sound === null || !audio || audio.music[action.sound], `音乐缺失 ${action.sound}`); return; }
      if (action.type === 'stage') {
        if (action.audio) {
          ensure(action.audio.music === null || !audio || audio.music[action.audio.music], `音乐缺失 ${action.audio.music}`);
          ensure(action.audio.ambience === null || !audio || audio.effects[action.audio.ambience], `环境音缺失 ${action.audio.ambience}`);
        }
        if (action.camera) ensure(Number.isFinite(action.camera.x) && Number.isFinite(action.camera.y), '镜头位置无效');
        if (action.curtain) ensure(Number.isFinite(action.curtain.opacity) && action.curtain.opacity >= 0 && action.curtain.opacity <= 1 && Number.isSafeInteger(action.curtain.color) && action.curtain.color >= 0 && action.curtain.color <= 0xffffff, '幕布状态无效');
        ensure(world.maps.some(m => m.id === action.map), `地图缺失 ${action.map}`);
        dynamicMap = action.mapFromWorld === true; navigation = undefined;
        mapId = action.map; cast.clear(); participants.clear();
        cast.set('player', { actor: campaign.start.actor, x: action.x, y: action.y, visible: action.playerVisible });
        for (const member of action.cast) {
          ensure(!cast.has(member.id), `出场标识重复 ${member.id}`);
          ensure(world.actors[member.actor], `人物资源缺失 ${member.actor}`);
          cast.set(member.id, member);
        }
        for (const member of cast.values()) for (const facing of ['north', 'south', 'east', 'west']) {
          ensure(world.actors[member.actor]?.clips[`idle-${facing}` as ClipName], `待机动画缺失 ${member.actor}/${facing}`);
        }
        if (maps && !dynamicMap) {
          const map = maps.get(mapId); ensure(map, `地图未载入 ${mapId}`);
          // 人物编号可能对应多个地图实体。舞台没有唯一实例键时，至少要求本图只有一个
          // 候选；多个候选必须补 worldEntityId，不能等运行时“碰巧拿第一个”。
          const candidates = mapPlacementCandidates(map!, campaign);
          const bound = new Map<string, string>();
          for (const member of action.cast) {
            if (member.memberId || member.enemyId) continue;
            const matches = member.worldEntityId
              ? candidates.filter(entity => entity.id === member.worldEntityId)
              : member.characterId
                ? candidates.filter(entity => entity.characterId === member.characterId)
                : candidates.filter(entity => entity.actor === member.actor);
            if (matches.length > 1)
              ensure(false, `人物来源不唯一 ${member.id}（${member.characterId ?? member.actor}）：${matches.slice(0, 6).map(entity => entity.id).join('、')}；请补 worldEntityId`);
            if (matches.length === 1) {
              const owner = bound.get(matches[0].id);
              ensure(!owner, `人物实例重复绑定 ${owner} / ${member.id}（${matches[0].id}）`);
              bound.set(matches[0].id, member.id);
            }
          }
          navigation = new NavigationWorld(map!);
          for (const id of cast.keys()) {
            const actor: NavigationActor = { shape: () => world.actors[cast.get(id)!.actor], position: () => cast.get(id)!, enabled: () => cast.get(id)!.visible && !cast.get(id)!.scenery };
            participants.set(id, actor); navigation.register(actor);
          }
          validatePositions();
        }
        return;
      }
      if (action.type === 'location-effect') { ensure(!!world.storyEffects?.[action.effect]?.clips.default, `特效缺失 ${action.effect}`); return; }
      if (action.type === 'map-effect') { ensure(typeof action.enabled === 'boolean', '地图效果开关状态无效'); return; }
      if (action.type === 'world-object') {
        if (action.command.kind === 'place') ensure(world.actors[action.command.entity.actor], `人物资源缺失 ${action.command.entity.actor}`);
        if (action.target) ensure(cast.has(action.target), `人物未出场 ${action.target}`);
        updatePosition(action); return;
      }
      if (!('target' in action)) return;
      const target = cast.get(action.target);
      ensure(target, `人物未出场 ${action.target}`);
      if (!target) return;
      if (action.type === 'effect') ensure(world.storyEffects?.[action.effect]?.clips.default, `特效缺失 ${action.effect}`);
      if (action.type === 'walk' || action.type === 'pose') {
        const pose = action.type === 'walk' ? 'walk' : action.pose;
        for (const facing of ['north', 'south', 'east', 'west']) ensure(world.actors[target.actor].clips[`${pose}-${facing}` as ClipName], `动作缺失 ${target.actor}/${pose}-${facing}`);
      }
      if (action.type === 'walk' && maps && !dynamicMap && !target.unpositioned) {
        const path = navigation!.path(participants.get(action.target)!, action);
        ensure(path, `道路不可达 ${action.target} (${target.x},${target.y}) → (${action.x},${action.y})`);
      }
      updatePosition(action);
      if (validateEnd) validatePositions();
    };
    const updatePosition = (action: Exclude<PerformanceAction, {type:'parallel'}>): void => {
      if (action.type === 'world-object') {
        const command = action.command;
        if (command.kind === 'place' && action.target) {
          const target = cast.get(action.target);
          if (target) cast.set(action.target, {...target,...command.entity,worldEntityId:command.entity.id,
            visible:command.entity.visible !== false,unpositioned:false,scenery:true});
        } else {
          for (const [id,target] of cast) {
            const matches = command.kind === 'remove-character' ? target.characterId === command.characterId
              : 'id' in command && target.worldEntityId === command.id;
            if (matches) {
              cast.set(id,{...target,visible:command.kind === 'show'});
              if (command.kind === 'remove-character' && !command.all) break;
            }
          }
        }
        return;
      }
      if (!('target' in action)) return;
      const target = cast.get(action.target); if (!target) return;
      if (action.type === 'walk' && target.unpositioned) return;
      if (action.type === 'walk' || action.type === 'appear') cast.set(action.target, { ...target, x: action.x, y: action.y, visible: action.type === 'appear' || target.visible,
        unpositioned:action.type==='appear'?false:target.unpositioned });
      if (action.type === 'show') cast.set(action.target, { ...target, visible: true });
      if (action.type === 'leave') cast.set(action.target, { ...target, visible: false });
    };
    const validatePositions = (): void => {
      if (!navigation) return;
      const placements: Placement[] = [...participants].map(([id, actor]) => ({ actor, position: cast.get(id)!, enabled: cast.get(id)!.visible && !cast.get(id)!.scenery }));
      for (const [id, actor] of participants) {
        const member = cast.get(id)!;
        ensure(member.scenery || !member.visible || navigation.canPlace(actor.shape(), member, actor, placements), `人物落位被地形或其他人物阻挡 ${id} (${member.x},${member.y})`);
      }
    };
    interface StageState { dynamicMap: boolean; map: string; members: [string, Member][] }
    const snapshot = (): StageState => ({ dynamicMap, map: mapId, members: [...cast].map(([id, member]) => [id, { ...member }]) });
    const restore = (state: StageState): void => {
      dynamicMap = state.dynamicMap; mapId = state.map; cast.clear(); participants.clear(); navigation = undefined;
      for (const [id, member] of state.members) cast.set(id, { ...member });
      if (maps && cast.size && !dynamicMap) {
        const map = maps.get(mapId); ensure(map, `地图未载入 ${mapId}`);
        navigation = new NavigationWorld(map!);
        for (const id of cast.keys()) {
          const actor: NavigationActor = { shape: () => world.actors[cast.get(id)!.actor], position: () => cast.get(id)!, enabled: () => cast.get(id)!.visible && !cast.get(id)!.scenery };
          participants.set(id, actor); navigation.register(actor);
        }
      }
    };
    const pending: { reference: StoryNodeRef; state: StageState; stack: StoryNodeRef[] }[] = [{ reference: { script: name, node: campaign.scripts[name].entry }, state: snapshot(), stack: [] }];
    const seen = new Set<string>();
    let visits = 0;
    while (pending.length) {
      const { reference, state, stack } = pending.pop()!;
      // Different incoming casts are checked separately; one branch cannot lend its actor to another.
      const identity = JSON.stringify([reference.script, reference.node, stack, state]);
      if (seen.has(identity)) continue; seen.add(identity); restore(state);
      ensure(++visits <= 100000, '演出分支校验超过节点限制');
      const node = campaign.scripts[reference.script]?.nodes.find(node => node.id === reference.node);
      ensure(node, `剧情节点缺失 ${reference.script}/${reference.node}`);
      if (!node) continue;
      if (node.stage) visit(node.stage);
      const validateLine = (line: DialogueLine): void => {
        ensure(!line.actor || world.actors[line.actor], `对白人物缺失 ${line.actor}`);
        ensure(!line.portrait || world.portraits[line.portrait], `对白立绘缺失 ${line.portrait}`);
      };
      for (const action of node.presentation) {
        if (action.type === 'dialogue') validateLine(action);
        else if (action.type === 'choice') action.options.flatMap(option => option.lines ?? []).forEach(validateLine);
        else if (action.type === 'quest-popup') {
          // 隐藏任务不进日志、不挂标记，也不该在脚本里占一次面板。
          const quest = campaign.quests.find(quest => quest.id === action.quest);
          ensure(!quest?.hidden, `隐藏任务不应有任务面板 ${action.quest}`);
        } else visit(action);
      }
      const after = snapshot();
      if (node.exit.type === 'call') {
        ensure(stack.length < 32, '剧情调用层级超过限制');
        pending.push({ reference: node.exit.target, state: after, stack: [...stack, node.exit.then] });
      } else if (node.exit.type === 'end' && stack.length) {
        pending.push({ reference: stack.at(-1)!, state: after, stack: stack.slice(0, -1) });
      } else {
        for (const target of storyExitTargets(node.exit)) pending.push({ reference: target, state: after, stack });
      }
    }
  }
}
