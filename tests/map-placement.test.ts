import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {authoredPlacements,baseMapEntities,mapPlacementCandidates,placementMayBeInactive,withoutReplacedStatic} from '../src/domain/map-placement.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const campaign=read('campaign');
const world=read('world');
const mapId='south-pendrik-6312caf9';
const map=JSON.parse(readFileSync(new URL(`../public/${world.maps.find((entry:{id:string})=>entry.id===mapId).file}`,import.meta.url),'utf8'));
const placement=campaign.placements.find((entry:{id:string})=>entry.id==='quest-npc-located-npc-100');
const staticBoulder='boulder2-01484abb-004';

test('a conditional story placement only replaces the static actor while it is active',()=>{
  const inactive=baseMapEntities(map,campaign,entity=>entity.id!==placement.id);
  assert(inactive.some(entity=>entity.id===staticBoulder),'条件不成立时静态巨石必须保留');
  const active=baseMapEntities(map,campaign);
  assert(!active.some(entity=>entity.id===staticBoulder),'条件成立时由剧情摆放接管');
  assert(mapPlacementCandidates(map,campaign).some(entity=>entity.id===placement.id));
  assert.equal(placementMayBeInactive(placement),true);
  assert.equal(placementMayBeInactive({...placement,condition:{type:'always'}}),false);
});

test('the formal map keeps both candidates and picks the active one at each projection',()=>{
  const full=[...baseMapEntities(map,campaign,()=>false),...authoredPlacements(map,campaign)];
  assert(full.some(entity=>entity.id===staticBoulder));
  assert(full.some(entity=>entity.id===placement.id));
  const active=withoutReplacedStatic(full,map,campaign,()=>true);
  assert(!active.some(entity=>entity.id===staticBoulder));
  assert(active.some(entity=>entity.id===placement.id));
  const inactive=withoutReplacedStatic(full,map,campaign,()=>false);
  assert(inactive.some(entity=>entity.id===staticBoulder));
  assert(inactive.some(entity=>entity.id===placement.id),'未生效的剧情摆放仍留给投影层过滤');
});
