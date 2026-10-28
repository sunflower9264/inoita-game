import type { StoryCommand } from './story-graph.ts';
import type { StoryNodeCommit } from './story-runtime.ts';
import type { StoryWorldState, StoryEntityState } from './story-world.ts';

/** 正常演出和调试预演共用角色落位、转场及事件完成的提交规则。 */
export function storyCommitCommands(commit: StoryNodeCommit, world: StoryWorldState, changes: readonly StoryEntityState[],
  hasPartyMember: (memberId: string) => boolean = () => true): StoryCommand[] {
  let commands = [...commit.commands];
  const run = commit.checkpoint.runs.find(candidate => candidate.id === commit.runId);
  const explicitTravel = commands.some(command => command.type === 'travel' || command.type === 'world' && command.command.kind === 'travel');
  const stage = commit.stage ?? run?.stage;
  commands=commands.flatMap((command,index):StoryCommand[]=>{
    if(command.type!=='world'||command.command.kind!=='place'||!stage)return [command];
    const place=command.command;
    const map=place.mapFromStage?stage.map:place.entity.map;
    if(map!==stage.map)return [command];
    const actor=stage.scene.actors.find(actor=>actor.worldEntityId===place.entity.id);
    const dirty=changes.some(entity=>entity.id===place.entity.id&&entity.map===map);
    const laterPlacement=commands.slice(index+1).some(candidate=>candidate.type==='world'&&candidate.command.kind==='place'
      &&candidate.command.entity.id===place.entity.id&&(candidate.command.mapFromStage?stage.map:candidate.command.entity.map)===map);
    // 同图最后一次落位承接演出的最终姿态，生命周期与后续删除、迁移仍由节点命令决定。
    const projected:StoryCommand=dirty&&actor&&!actor.unpositioned&&!actor.removed&&!laterPlacement
      ?{...command,command:{...place,entity:{...place.entity,x:actor.x,y:actor.y,facing:actor.facing,visible:actor.visible}}}:command;
    if(!actor?.id.startsWith('entity:'))return [projected];
    const previousId=actor.id.slice('entity:'.length);
    if(previousId===place.entity.id)return [projected];
    const existing=world.entity(previousId);
    if(existing?.map&&existing.map!==map)return [projected];
    return [{type:'world',command:{kind:'remove',id:previousId}},projected];
  });
  // 舞台同时点名了队伍成员和人物编号，说明这个 NPC 已经由队伍系统接管。
  // 收尾时把同图的地图副本隐藏，否则回到正式地图会看到队伍成员和旧 NPC 两份。
  for (const member of stage?.cast ?? []) {
    if (!member.memberId || !member.characterId || !hasPartyMember(member.memberId)) continue;
    commands.push({type:'world',command:{kind:'remove-character',characterId:member.characterId,map:stage!.map,all:true}});
  }
  const bindings: StoryCommand[] = [];
  for (const entity of changes) {
    if (!entity.map || !entity.actor || entity.x === undefined || entity.y === undefined) throw new Error('绑定剧情角色缺少地图与位置');
    const existing=world.entity(entity.id);
    // 隐式走位只更新仍在本图的实例；复活或迁移由显式命令决定。
    if(existing?.removed)continue;
    if(existing?.map&&existing.map!==entity.map)continue;
    const persistent=existing?.map&&existing.actor&&existing.mapVisit===undefined;
    bindings.push({type:'world',command:{kind:'place',...(!persistent?{scope:'visit' as const}:{}),entity:{...entity,map:entity.map,actor:entity.actor,x:entity.x,y:entity.y}}});
  }
  commands.unshift(...bindings);
  // `retainPlayerPosition` 只说明这一幕从主角真实站位起步，不意味着整段都没动过他：
  // 演出里出现过 `walk`/`face` 时，表现层的最终帧已经和入场位置不同，收尾仍要把这个位置写回。
  // 没有表现层时只拿到脚本里的兜底锚点，保持不提交（见 findings 106）。
  const performed = commit.stage;
  const moved = !!performed && (!world.currentLocation || performed.map !== world.currentLocation.map ||
    performed.x !== world.currentLocation.x || performed.y !== world.currentLocation.y ||
    performed.facing !== world.currentLocation.facing);
  if ((run?.status === 'completed' || run?.status === 'waiting') && stage && !explicitTravel && (!stage.retainPlayerPosition || moved))
    commands.push({type:'travel',destination:{map:stage.map,x:stage.x,y:stage.y,facing:stage.facing}});
  if(commit.eventId&&run?.status==='completed')commands.push({type:'flag',flag:commit.eventId});
  return commands;
}
