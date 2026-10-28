import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mapPlacementCandidates} from '../src/domain/map-placement.ts';

type Row=Record<string,any>;
type Stage={map:string;mapFromWorld?:boolean;cast?:Row[]};
type Node={id:string;presentation?:Row[];stage?:Stage;commands?:Row[]};
type Script={nodes:Node[]};
type MapDocument={id:string;entities:Row[]};

const DEFAULT_ROOT=fileURLToPath(new URL('../public/',import.meta.url));

/**
 * 只读取材：为剧情演员的身份迁移生成台账。
 * 不修改运行状态，也不把报告写进游戏包；输出到 stdout，需要时重定向到文件。
 */
export function auditStoryActors(root=DEFAULT_ROOT){
  const read=(file:string)=>JSON.parse(readFileSync(root+file,'utf8')) as Row;
  const readBytes=(file:string)=>readFileSync(root+file);
  const campaign=read('content/campaign.json');
  const world=read('content/world.json');
  const debug=read('content/debug/start.json');
  const maps=new Map<string,MapDocument>();
  for(const reference of world.maps as Row[]){
    maps.set(reference.id,JSON.parse(readFileSync(`${root}${reference.file}`,'utf8')) as MapDocument);
  }

  const stages:Row[]=[];
  const castRows:{script:string;node:string;stage:Stage;member:Row}[]=[];
  const placeIds=new Set<string>();
  const placeMaps=new Map<string,Set<string>>();
  const placeCharacters=new Map<string,Set<string>>();
  const entityMaps=new Map<string,Set<string>>();
  const remember=(target:Map<string,Set<string>>,id:string,value:string)=>{
    if(!id||!value)return;
    const values=target.get(id);
    if(values)values.add(value);else target.set(id,new Set([value]));
  };
  for(const map of maps.values())for(const entity of map.entities)if(entity.id)remember(entityMaps,entity.id,map.id);
  for(const entity of campaign.placements??[])if(entity.id)remember(entityMaps,entity.id,entity.map);
  for(const entity of campaign.mapEntryPlacements??[])if(entity.id)remember(entityMaps,entity.id,entity.map);

  const scripts=Object.entries(campaign.scripts as Record<string,Script>);
  for(const [scriptName,script] of scripts){
    for(const node of script.nodes){
      const presentation=node.presentation??[];
      const nodeStages=[
        ...(node.stage?[node.stage]:[]),
        ...presentation.filter(action=>action.type==='stage') as Stage[],
      ];
      for(const stage of nodeStages){
        stages.push({script:scriptName,node:node.id,stage});
        for(const member of stage.cast??[])castRows.push({script:scriptName,node:node.id,stage,member});
      }
      for(const command of node.commands??[]){
        if(command.type!=='world'||command.command?.kind!=='place')continue;
        const entity=command.command.entity;
        if(!entity?.id)continue;
        placeIds.add(entity.id);
        remember(placeMaps,entity.id,entity.map??'');
        if(entity.characterId)remember(placeCharacters,entity.id,entity.characterId);
      }
    }
  }

  const selectorCounts={worldEntityId:0,memberId:0,enemyId:0,characterId:0,actor:0};
  const multipleSelectors:Row[]=[];
  const characterOnly:Row[]=[];
  const templates:Row[]=[];
  const explicitWorldRefs:Row[]=[];
  const mapFromWorld={stages:0,casts:0};
  const ambiguous:Row[]=[];

  for(const row of castRows){
    const {script,node,stage,member}=row;
    for(const key of Object.keys(selectorCounts) as (keyof typeof selectorCounts)[])
      if(member[key])selectorCounts[key]++;
    const instanceSelectors=['worldEntityId','memberId','enemyId'].filter(key=>member[key]);
    if(instanceSelectors.length>1)multipleSelectors.push({script,node,map:stage.map,alias:member.id,selectors:instanceSelectors});
    if(!instanceSelectors.length&&member.characterId)characterOnly.push({script,node,map:stage.map,alias:member.id,characterId:member.characterId});
    if(member.unpositioned&&member.visible===false&&!member.worldEntityId) templates.push({script,node,map:stage.map,alias:member.id,characterId:member.characterId});
    if(member.worldEntityId){
      explicitWorldRefs.push({script,node,map:stage.map,alias:member.id,worldEntityId:member.worldEntityId});
      const homes=entityMaps.get(member.worldEntityId);
      if(homes&&homes.size>1&&!homes.has(stage.map)) ambiguous.push({kind:'world-ref-cross-map',script,node,map:stage.map,alias:member.id,worldEntityId:member.worldEntityId,homes:[...homes]});
    }
    if(stage.mapFromWorld===true){mapFromWorld.casts++;}
    if(stage.mapFromWorld===true)continue;
    const map=maps.get(stage.map);
    if(!map)continue;
    if(member.memberId||member.enemyId)continue;
    const candidates=mapPlacementCandidates(map as never,campaign as never);
    const matches=member.worldEntityId
      ? candidates.filter(entity=>entity.id===member.worldEntityId)
      : member.characterId
        ? candidates.filter(entity=>entity.characterId===member.characterId)
        : candidates.filter(entity=>entity.actor===member.actor);
    if(matches.length>1)ambiguous.push({kind:'cast-ambiguous',script,node,map:stage.map,alias:member.id,selector:member.characterId??member.actor,candidates:matches.map(entity=>entity.id)});
  }
  for(const row of stages)if(row.stage.mapFromWorld===true)mapFromWorld.stages++;

  const duplicatePlaceIds=[...placeMaps].filter(([,mapsForId])=>mapsForId.size>1).map(([id,mapsForId])=>({id,maps:[...mapsForId]}));
  const duplicatePlaceCharacters=[...placeCharacters].filter(([,ids])=>ids.size>1).map(([id,ids])=>({id,characterIds:[...ids]}));
  const prefix=(value:string)=>value.startsWith('story-character-')?'story-character'
    :value.startsWith('quest-npc-located-')?'quest-npc-located':value.startsWith('story-')?'story-other':'other';
  const placePrefixes:Record<string,number>={};
  for(const id of placeIds)placePrefixes[prefix(id)]=(placePrefixes[prefix(id)]??0)+1;

  const summary={
    maps:maps.size,
    scripts:scripts.length,
    stages:stages.length,
    castMembers:castRows.length,
    placeIds:placeIds.size,
    debugTasks:(debug.tasks as Row[]).length,
  };
  const body={
    schema:1,
    source:{
      campaign:createHash('sha256').update(readBytes('content/campaign.json')).digest('hex').slice(0,16),
      world:createHash('sha256').update(readBytes('content/world.json')).digest('hex').slice(0,16),
      debug:createHash('sha256').update(readBytes('content/debug/start.json')).digest('hex').slice(0,16),
    },
    summary,
    selectors:selectorCounts,
    mapFromWorld,
    identity:{
      multipleSelectors,
      characterOnly:characterOnly.length,
      templates,
      explicitWorldRefs:explicitWorldRefs.length,
    },
    places:{
      uniqueIds:placeIds.size,
      prefixes:placePrefixes,
      duplicateAcrossMaps:duplicatePlaceIds,
      duplicateCharacterIds:duplicatePlaceCharacters,
    },
    ambiguous,
  };
  return {...body,reportHash:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(auditStoryActors(),null,2));
