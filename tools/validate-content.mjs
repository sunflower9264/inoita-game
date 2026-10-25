import {parseCrafting,validateCrafting} from '../src/domain/crafting.ts';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseStatusHud, parseCharacterStats,validateCharacterStats,validateItemSkills,parseItemCatalog,parseWardrobe,validateWardrobe,parseMenuPanels,validateMenuClasses,parseStoryClasses,parseWorld,parseMap,parseBattle,parseCampaign,parseStoryInterface,parseControlSkin,validateStoryItems,validateStoryPortraits,parseShops,validateShops,parseCompanions,validateCompanions,parseStoryDebugCatalog} from '../src/application/content-validation.ts';
import {validateStoryDebug} from '../src/domain/story-debug.ts';
import {contentDigest} from '../src/application/content-hash.ts';
import {validateDebugCatalog} from '../src/debug/catalog-validation.ts';
import {validateContentRelations} from '../src/application/content-relations.ts';
import {validateSpriteSheet} from './validate-spritesheet.ts';
import {parseDrops} from '../src/domain/drops.ts';
import {parseShopEquipment} from '../src/application/content-validation.ts';
import {parseSprings} from '../src/domain/springs.ts';
import {titleMenuImages} from '../src/application/menu-images.ts';
import {UI_ICON_ATLAS_DATA,UI_ICON_ATLAS_FILE,UI_ICON_FRAMES,UI_ICON_SOURCE_DIGEST} from '../src/generated/icon-atlas.ts';
import {iconSourceDigest} from './build-icon-atlas.ts';
import {PROP_ATLAS_BY_KEY,PROP_ATLAS_LAYOUT_DIGEST,PROP_ATLAS_PAGES,PROP_ATLAS_SOURCE_DIGEST} from '../src/generated/prop-atlas.ts';
import {propSourceDigest} from './build-prop-atlas.ts';
import {residentCombatAssets} from '../src/rendering/resident-combat-assets.ts';
import {residentCombatCoverageGaps} from '../src/rendering/combat-visual-coverage.ts';
export function validateContent(root=fileURLToPath(new URL('../public/',import.meta.url))){
 const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
 const world=parseWorld(read('content/world.json')),battle=parseBattle(read('content/battle.json'));
 const campaignJson=read('content/campaign.json'),campaign=parseCampaign(campaignJson);
 const itemsJson=read('content/items.json'),items=parseItemCatalog(itemsJson);
 const audio=read('content/audio.json');const companions=parseCompanions(read('content/companions.json'));
 // 菜单图标走构建期图集；内容新增图标后必须重新生成，否则运行时会缺帧。
 const iconFiles=[...Object.values(items.items).map(item=>item.icon),...Object.values(battle.skills).map(skill=>skill.icon),
  ...Object.values(companions.groupSkills??{}).map(skill=>skill.icon)];
 for(const icon of iconFiles)if(!UI_ICON_FRAMES[icon])throw new Error(`图标未进入图集：${icon}；运行 npm run atlas:icons`);
 if(iconSourceDigest()!==UI_ICON_SOURCE_DIGEST)throw new Error('图标图集已过期；运行 npm run atlas:icons');
 // 地图 prop 图集：内容里的每个 prop/feature 都必须有帧，且图集不能是旧文件。
 const propKeys=new Set();
 const propPages=new Map(PROP_ATLAS_PAGES.map(page=>[page.key,read(page.data)]));
 const hasPropFrame=(page,frame)=>!!page?.frames?.[frame];
 const pngSize=file=>{const bytes=fs.readFileSync(path.join(root,file));return {w:bytes.readUInt32BE(16),h:bytes.readUInt32BE(20)}};
 const propLayout={pages:PROP_ATLAS_PAGES.map(({key,file,data,frame,width,height})=>({key,file,data,frame,width,height})),
  byKey:PROP_ATLAS_BY_KEY,frames:Object.fromEntries(PROP_ATLAS_PAGES.map(page=>[page.key,propPages.get(page.key)?.frames]))};
 if(contentDigest(propLayout)!==PROP_ATLAS_LAYOUT_DIGEST)throw new Error('地图 prop 图集映射/布局摘要不一致；运行 npm run atlas:props');
 for(const page of PROP_ATLAS_PAGES)if(!hasPropFrame(propPages.get(page.key),page.frame))throw new Error(`prop 图集哨兵帧缺失：${page.frame}`);
 for(const prop of world.props){
  if(propKeys.has(prop.key))throw new Error(`地图物件 key 重复：${prop.key}`);
  propKeys.add(prop.key);
  const entry=PROP_ATLAS_BY_KEY[prop.key];
  if(!entry)throw new Error(`地图物件未进入图集：${prop.key}；运行 npm run atlas:props`);
  const page=propPages.get(entry.key);
  const frame=page?.frames?.[entry.frame];
  if(!frame)throw new Error(`prop 图集缺少帧：${entry.frame}；运行 npm run atlas:props`);
  if(frame.trimmed||frame.rotated)throw new Error(`prop 图集帧不能裁剪或旋转：${entry.frame}`);
  const rect=frame.frame,size=page.meta?.size;
  if(!rect||!(rect.w>0)||!(rect.h>0)||!size||rect.x<0||rect.y<0||rect.x+rect.w>size.w||rect.y+rect.h>size.h)
   throw new Error(`prop 图集帧越界或尺寸无效：${entry.frame}`);
  const source=pngSize(entry.frame);
  if(rect.w!==source.w||rect.h!==source.h||frame.sourceSize?.w!==source.w||frame.sourceSize?.h!==source.h)
   throw new Error(`prop 图集帧尺寸与原图不一致：${entry.frame}`);
 }
 if(propSourceDigest()!==PROP_ATLAS_SOURCE_DIGEST)throw new Error('地图 prop 图集已过期；运行 npm run atlas:props');
 const storyInterface=parseStoryInterface(read('content/story-interface.json'));
 // 生产包把人物动作拆成单文件；校验前先按索引合回来，规则保持和源内容一致。
 const wardrobeJson=read('content/wardrobe.json');
 if(!Object.keys(wardrobeJson.poses??{}).length&&fs.existsSync(path.join(root,'content/wardrobe/pose-index.json')))
  wardrobeJson.poses=Object.fromEntries(read('content/wardrobe/pose-index.json').map(id=>[id,read(`content/wardrobe/poses/${encodeURIComponent(id)}.json`)]));
 const wardrobe=parseWardrobe(wardrobeJson);validateStoryItems(campaign,items);validateWardrobe(wardrobe,items,battle);validateItemSkills(items,battle);
 const crafting=parseCrafting(read('content/crafting.json'));validateCrafting(crafting,items);
 const stats=parseCharacterStats(read('content/character-stats.json'));
 const shops=parseShops(read('content/shops.json'));
 if(fs.existsSync(path.join(root,'content/shops-equipment.json')))shops.equipment=parseShopEquipment(read('content/shops-equipment.json'),stats);
 validateShops(shops,items,world);
 const drops=parseDrops(read('content/drops.json'),items,battle.enemies.map(enemy=>enemy.id));
 const springs=parseSprings(read('content/springs.json'));
 validateStoryPortraits(world,storyInterface);
 validateCharacterStats(stats,items,battle);validateCompanions(companions,world,battle,stats,campaign);
 const menu=parseMenuPanels(read('content/menu-panels.json'));validateMenuClasses(menu,battle);
 const maps=new Map();
 const documents=[crafting,companions,parseStatusHud(read('content/status-hud.json')),items,shops,drops,springs,wardrobe,menu,world,battle,campaign,storyInterface,parseStoryClasses(read('content/story-classes.json')),parseControlSkin(read('content/control-skin.json')),audio];
 const ensure=(value,message)=>{if(!value)throw new Error(message);};
 // 地图要各自读一个文件，读进来后连同其它内容一起交给跨文件规则（src/application/content-relations.ts）。
 for(const reference of world.maps){const map=parseMap(read(reference.file));maps.set(map.id,map);documents.push(map);}
 for(const map of maps.values())for(const feature of map.features)
  if(!propKeys.has(feature.texture))throw new Error(`地图 ${map.id} 的场景物件缺少资源：${feature.texture}`);
 // 调试现场表是独立产物：先校验新鲜度，再挂回 campaign 让跨文件规则照常检查。
 const debug=parseStoryDebugCatalog(read('content/debug/start.json'));
 const sources={campaign:contentDigest(campaignJson),items:contentDigest(itemsJson),
  maps:contentDigest([...maps].map(([id,map])=>[id,map]))};
 for(const [name,value] of Object.entries(sources))if(debug.meta?.sources?.[name]!==value)
  throw new Error(`调试现场表已过期（${name}）；运行 npm run debug-start`);
 if(debug.meta?.sourceHash!==contentDigest(debug.meta.sources))
  throw new Error('调试现场表来源哈希不一致；运行 npm run debug-start');
 campaign.debugStory=debug;validateStoryDebug(campaign);validateDebugCatalog({campaign,maps,catalog:debug});
 validateContentRelations({world,battle,campaign,items,wardrobe,audio,maps});
 // 以下两项需要文件系统，留在构建侧：资源存在性与图集头。
 const assets=new Set();const visit=value=>{if(typeof value==='string'&&/^(assets|content)\//.test(value))assets.add(value);else if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')Object.values(value).forEach(visit);};documents.forEach(visit);
 for(const file of [UI_ICON_ATLAS_FILE,UI_ICON_ATLAS_DATA])assets.add(file);
 for(const page of PROP_ATLAS_PAGES){assets.add(page.file);assets.add(page.data);}
 for(const file of titleMenuImages)assets.add(file.replace(/^\//,''));
 for(const file of assets)ensure(fs.existsSync(path.join(root,file)),`资源不存在 ${file}`);
 const headers=new Map();
 const checkClips=value=>{
  if(Array.isArray(value))value.forEach(checkClips);
  else if(value&&typeof value==='object'){
   if(value.layers&&value.frameWidth)for(const layer of value.layers){
    if(!headers.has(layer.file)){
     const fd=fs.openSync(path.join(root,layer.file),'r');const header=Buffer.alloc(24);
     try{const length=fs.readSync(fd,header,0,24,0);headers.set(layer.file,header.subarray(0,length));}finally{fs.closeSync(fd);}
    }
    validateSpriteSheet(headers.get(layer.file),value,layer.file);
   }
   Object.values(value).forEach(checkClips);
  }
 };documents.forEach(checkClips);
 // 玩家侧战斗资源是会话常驻包；运行时引用必须全部落在包里，否则战斗会在播放动画时缺纹理。
 const resident=residentCombatAssets({battle,wardrobe,world,companions});
 for(const asset of resident.assets)ensure(fs.existsSync(path.join(root,asset.file)),`常驻战斗资源不存在 ${asset.file}`);
 const gaps=residentCombatCoverageGaps({battle,wardrobe,world,companions});
 const uncovered=[...gaps.definitions.map(name=>`特效定义缺失 ${name}`),...gaps.effects.map(name=>`常驻包缺少特效 ${name}`),
  ...gaps.layers.map(key=>`常驻包缺少特效纹理 ${key}`),...gaps.actorLayers.map(key=>`常驻包缺少角色纹理 ${key}`)];
 ensure(!uncovered.length,`战斗常驻资源不完整：\n${uncovered.slice(0,20).join('\n')}`);
 return {maps:world.maps.length,assets:assets.size};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(validateContent(process.argv[2]));
