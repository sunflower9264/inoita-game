import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {mapPlacementCandidates} from '../src/domain/map-placement.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const campaign=read('campaign');
const world=read('world');
const maps=new Map<string,unknown>(world.maps.map((reference:{id:string;file:string})=>[
  reference.id,JSON.parse(readFileSync(new URL(`../public/${reference.file}`,import.meta.url),'utf8')),
]));

test('every stage cast names at most one map instance without an explicit world entity',()=>{
  let stages=0,castMembers=0;
  for(const [script,body] of Object.entries(campaign.scripts as Record<string,{nodes:any[]}>)){
    for(const node of body.nodes){
      const declarations=[
        ...(node.stage?[node.stage]:[]),
        ...(node.presentation??[]).filter((action:any)=>action.type==='stage'),
      ];
      for(const stage of declarations){
        stages++;
        const map=maps.get(stage.map);
        assert.ok(map,`${script}/${node.id}: 地图不存在 ${stage.map}`);
        const candidates=mapPlacementCandidates(map as never,campaign as never);
        const chosen=new Map<string,string>();
        for(const member of stage.cast??[]){
          castMembers++;
          if(member.memberId||member.enemyId)continue;
          const matches=member.worldEntityId
            ? candidates.filter(entity=>entity.id===member.worldEntityId)
            : member.characterId
              ? candidates.filter(entity=>entity.characterId===member.characterId)
              : candidates.filter(entity=>entity.actor===member.actor);
          assert.ok(!member.worldEntityId||matches.length,
            `${script}/${node.id}: 舞台实例不存在 ${member.id}（${member.worldEntityId}）`);
          assert.ok(matches.length<=1,
            `${script}/${node.id}: 舞台人物不唯一 ${member.id}（${member.characterId??member.actor}）：`+
            matches.map(entity=>entity.id).join('、'));
          if(!matches.length)continue;
          const owner=chosen.get(matches[0].id);
          assert.equal(owner,undefined,
            `${script}/${node.id}: ${owner} 与 ${member.id} 绑定了同一个实例 ${matches[0].id}`);
          chosen.set(matches[0].id,member.id);
        }
      }
    }
  }
  assert.ok(stages>=700,`只审计到 ${stages} 个舞台，内容遍历不完整`);
  assert.ok(castMembers>=1500,`只审计到 ${castMembers} 个舞台演员，内容遍历不完整`);
});
