import {parseCrafting,validateCrafting} from '../src/domain/crafting.ts';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseStatusHud, parseCharacterStats,validateCharacterStats,validateItemSkills,parseItemCatalog,parseWardrobe,validateWardrobe,parseMenuPanels,validateMenuClasses,parseStoryClasses,parseWorld,parseMap,parseBattle,parseCampaign,parseStoryInterface,parseControlSkin,validateStoryItems,validateStoryPortraits,parseShops,validateShops,parseCompanions,validateCompanions,parseStoryDebugCatalog,parseChangelog} from '../src/application/content-validation.ts';
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
import {UI_ATLAS_FRAMES,UI_ATLAS_PAGES,UI_ATLAS_SOURCE_DIGEST} from '../src/generated/ui-atlas.ts';
import {uiAtlasFiles,uiAtlasSourceDigest} from './build-ui-atlas.ts';
import {EFFECT_ATLAS_BY_FILE,EFFECT_ATLAS_PAGES,EFFECT_ATLAS_SOURCE_DIGEST} from '../src/generated/effect-atlas.ts';
import {effectAtlasSourceDigest,effectUses} from './build-effect-atlas.ts';
import {CHARACTER_ATLAS_BY_FILE,CHARACTER_ATLAS_PAGES,CHARACTER_ATLAS_SOURCE_DIGEST} from '../src/generated/character-atlas.ts';
import {CHARACTER_ATLAS_ALIASES} from './character-atlas-aliases.ts';
import {characterAtlasSourceDigest,frameName as characterAtlasFrameName} from './build-character-atlas.ts';
import {PROP_ATLAS_BY_KEY,PROP_ATLAS_LAYOUT_DIGEST,PROP_ATLAS_PAGES,PROP_ATLAS_SOURCE_DIGEST} from '../src/generated/prop-atlas.ts';
import {propSourceDigest} from './build-prop-atlas.ts';
import {residentCombatAssets} from '../src/rendering/resident-combat-assets.ts';
import {residentCombatCoverageGaps} from '../src/rendering/combat-visual-coverage.ts';
import {sourceAssetPath} from './asset-source.ts';
/** PNG 文件头：读到 IHDR 宽高需要 24 字节，宽高分别位于 +16 和 +20。 */
const PNG_HEADER_BYTES=24;
const PNG_WIDTH_OFFSET=16;
const PNG_HEIGHT_OFFSET=20;
/** 错误信息里最多列出 20 个缺口，避免刷屏。 */
const MAX_REPORTED_GAPS=20;

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
 // 菜单静态 UI 图集：菜单框架、商店、剧情页签、职业预览与队伍头像。
 const uiPages=new Map(UI_ATLAS_PAGES.map(page=>[page.key,read(page.data)]));
 for(const page of UI_ATLAS_PAGES)if(!uiPages.get(page.key)?.frames?.[page.frame])throw new Error(`菜单 UI 图集哨兵帧缺失：${page.frame}；运行 npm run atlas:ui`);
 for(const file of uiAtlasFiles()){
  if(UI_ICON_FRAMES[file])throw new Error(`菜单 UI 图同时出现在两个图集：${file}`);
  if(!UI_ATLAS_FRAMES[file])throw new Error(`菜单 UI 图未进入图集：${file}；运行 npm run atlas:ui`);
 }
 for(const [file,entry] of Object.entries(UI_ATLAS_FRAMES)){
  const page=uiPages.get(entry.key);
  if(!page?.frames?.[entry.frame])throw new Error(`菜单 UI 图集缺少帧：${file} → ${entry.key}/${entry.frame}；运行 npm run atlas:ui`);
 }
 if(uiAtlasSourceDigest()!==UI_ATLAS_SOURCE_DIGEST)throw new Error('菜单 UI 图集已过期；运行 npm run atlas:ui');
 // 地图 prop 图集：内容里的每个 prop/feature 都必须有帧，且图集不能是旧文件。
 const propKeys=new Set();
 const propPages=new Map(PROP_ATLAS_PAGES.map(page=>[page.key,read(page.data)]));
 const hasPropFrame=(page,frame)=>!!page?.frames?.[frame];
 const pngSize=file=>{const bytes=fs.readFileSync(sourceAssetPath(file));return {w:bytes.readUInt32BE(PNG_WIDTH_OFFSET),h:bytes.readUInt32BE(PNG_HEIGHT_OFFSET)}};
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
 // 技能特效裁边图集：四个大特效的每一帧都必须有可用的裁剪帧，摘要不能过期。
 const effectPages=new Map(EFFECT_ATLAS_PAGES.map(page=>[page.key,read(page.data)]));
 for(const page of EFFECT_ATLAS_PAGES){
  const json=effectPages.get(page.key);
  if(!json?.frames?.[page.frame])throw new Error(`技能特效图集哨兵帧缺失：${page.frame}；运行 npm run atlas:effects`);
  for(const [name,frame] of Object.entries(json.frames)){
   const rect=frame.frame;
   if(!rect||!(rect.w>0)||!(rect.h>0)||rect.x<0||rect.y<0||rect.x+rect.w>page.width||rect.y+rect.h>page.height)
    throw new Error(`技能特效图集帧越界：${name}`);
   if(frame.spriteSourceSize.x<0||frame.spriteSourceSize.y<0
    ||frame.spriteSourceSize.x+frame.spriteSourceSize.w>frame.sourceSize.w
    ||frame.spriteSourceSize.y+frame.spriteSourceSize.h>frame.sourceSize.h)
    throw new Error(`技能特效图集裁剪信息越界：${name}`);
  }
 }
 for(const [file,frames] of Object.entries(EFFECT_ATLAS_BY_FILE)){
  if(!frames.length)throw new Error(`技能特效图集映射为空：${file}`);
  for(const ref of frames)if(!effectPages.get(EFFECT_ATLAS_PAGES[ref.page]?.key)?.frames?.[ref.frame])
   throw new Error(`技能特效图集帧缺失：${file} → ${ref.frame}；运行 npm run atlas:effects`);
 }
 for(const use of effectUses())if(!EFFECT_ATLAS_BY_FILE[use.file])
  throw new Error(`特效文件未进入图集：${use.file}；运行 npm run atlas:effects`);
 if(effectAtlasSourceDigest()!==EFFECT_ATLAS_SOURCE_DIGEST)throw new Error('技能特效图集已过期；运行 npm run atlas:effects');
 const characterPages=new Map(CHARACTER_ATLAS_PAGES.map(page=>[page.key,read(page.data)]));
 for(const page of CHARACTER_ATLAS_PAGES)if(!characterPages.get(page.key)?.frames?.[page.frame])
  throw new Error(`角色图集哨兵帧缺失：${page.frame}；运行 npm run atlas:characters`);
 if(characterAtlasSourceDigest()!==CHARACTER_ATLAS_SOURCE_DIGEST)throw new Error('角色图集已过期；运行 npm run atlas:characters');
 // 编译后内容已经合并到规范路径；逐 actor 核对映射，能抓住去重规则变化导致的漂移。
 // 源内容仍保留重复路径，不能套用同一判据。
 if(fs.existsSync(path.join(root,'content-manifest.json'))){
  const actors=[];
  for(const actor of Object.values(world.actors??{}))actors.push(actor);
  for(const character of battle.classes??[])actors.push(character.actor);
  for(const enemy of battle.enemies??[])actors.push(enemy.actor);
  // 职业选择的 playerActor 开局后合并进英雄动作；它与 battle 里的职业 actor 同 id，
  // 不能按 id 去重，否则会漏掉它自己保留的动作路径。
  const storyClassJson=JSON.parse(fs.readFileSync(path.join(root,'content/story-classes.json'),'utf8'));
  for(const entry of storyClassJson.classes??[])actors.push(entry.playerActor,entry.previewActor);
  for(const actor of actors){
   if(!actor?.id)continue;
   for(const [clipName,clip] of Object.entries(actor.clips??{})){
    if(!clip)continue;
    for(const layer of clip.layers??[]){
     if(!layer.file)continue;
     const entry=CHARACTER_ATLAS_BY_FILE[layer.file];
     if(!entry)throw new Error(`角色图集缺少映射：${actor.id}/${clipName} → ${layer.file}；运行 npm run atlas:characters`);
     if(entry.pages.length<clip.frames)
      throw new Error(`角色图集帧数不足：${actor.id}/${clipName}（${entry.pages.length} < ${clip.frames}）；运行 npm run atlas:characters`);
    }
   }
  }
 }
 // 图集帧必须逐帧存在；Phaser 找不到帧名时会静默退回页首帧，显示成同页另一张图。
 for(const [file,entry] of Object.entries(CHARACTER_ATLAS_BY_FILE)){
  for(let index=0;index<entry.pages.length;index++){
   const page=CHARACTER_ATLAS_PAGES[entry.pages[index]];
   if(!page)throw new Error(`角色图集页索引悬空：${file} 第 ${index} 帧；运行 npm run atlas:characters`);
   const data=characterPages.get(page.key);
   const frame=characterAtlasFrameName(entry.prefix,index);
   if(!data?.frames?.[frame])
    throw new Error(`角色图集缺少帧：${file} 第 ${index} 帧（${frame}）；运行 npm run atlas:characters`);
  }
 }
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
 const documents=[crafting,companions,parseStatusHud(read('content/status-hud.json')),items,shops,drops,springs,wardrobe,menu,world,battle,campaign,storyInterface,parseStoryClasses(read('content/story-classes.json')),parseControlSkin(read('content/control-skin.json')),parseChangelog(read('content/changelog.json')),audio];
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
 const propFileKeys=new Map((world.props??[]).map(prop=>[prop.file,prop.key]));
 // 已被图集页替代的原图不在 public/dist 里，打包时只保留图集页；原图由 asset-source 归档。
 const atlasCovered=file=>!!CHARACTER_ATLAS_BY_FILE[CHARACTER_ATLAS_ALIASES[file]??file]||!!EFFECT_ATLAS_BY_FILE[file]
  ||!!UI_ATLAS_FRAMES[file]||!!UI_ICON_FRAMES[file]
  ||(propFileKeys.has(file)&&!!PROP_ATLAS_BY_KEY[propFileKeys.get(file)]);
 const assets=new Set();const visit=value=>{if(typeof value==='string'&&/^(assets|content)\//.test(value))assets.add(value);else if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')Object.values(value).forEach(visit);};documents.forEach(visit);
 for(const file of [UI_ICON_ATLAS_FILE,UI_ICON_ATLAS_DATA])assets.add(file);
 for(const page of UI_ATLAS_PAGES){assets.add(page.file);assets.add(page.data);}
 for(const page of PROP_ATLAS_PAGES){assets.add(page.file);assets.add(page.data);}
 for(const page of EFFECT_ATLAS_PAGES){assets.add(page.file);assets.add(page.data);}
 for(const page of CHARACTER_ATLAS_PAGES){assets.add(page.file);assets.add(page.data);}
 for(const file of titleMenuImages)assets.add(file.replace(/^\//,''));
 for(const file of assets)if(!atlasCovered(file))ensure(fs.existsSync(path.join(root,file)),`资源不存在 ${file}`);
 const headers=new Map();
 const checkClips=value=>{
  if(Array.isArray(value))value.forEach(checkClips);
  else if(value&&typeof value==='object'){
   if(value.layers&&value.frameWidth)for(const layer of value.layers){
    if(atlasCovered(layer.file))continue;
    if(!headers.has(layer.file)){
     const fd=fs.openSync(path.join(root,layer.file),'r');const header=Buffer.alloc(PNG_HEADER_BYTES);
     try{const length=fs.readSync(fd,header,0,PNG_HEADER_BYTES,0);headers.set(layer.file,header.subarray(0,length));}finally{fs.closeSync(fd);}
    }
    validateSpriteSheet(headers.get(layer.file),value,layer.file);
   }
   Object.values(value).forEach(checkClips);
  }
 };documents.forEach(checkClips);
 // 玩家侧战斗资源是会话常驻包；运行时引用必须全部落在包里，否则战斗会在播放动画时缺纹理。
 const resident=residentCombatAssets({battle,wardrobe,world,companions});
 for(const asset of resident.assets){
  // 源内容可能还是合并前的原始路径；运行时内容构建会改写为规范路径，再由角色图集页接管。
  const canonical=CHARACTER_ATLAS_ALIASES[asset.file]??asset.file;
  if(asset.kind==='spritesheet'&&CHARACTER_ATLAS_BY_FILE[canonical])continue;
  ensure(fs.existsSync(path.join(root,asset.file)),`常驻战斗资源不存在 ${asset.file}`);
 }
 const gaps=residentCombatCoverageGaps({battle,wardrobe,world,companions});
 const uncovered=[...gaps.definitions.map(name=>`特效定义缺失 ${name}`),...gaps.effects.map(name=>`常驻包缺少特效 ${name}`),
  ...gaps.layers.map(key=>`常驻包缺少特效纹理 ${key}`),...gaps.actorLayers.map(key=>`常驻包缺少角色纹理 ${key}`),
  ...gaps.companions.map(id=>`佣兵外观无法按需加载 ${id}`)];
 ensure(!uncovered.length,`战斗常驻资源不完整：\n${uncovered.slice(0,MAX_REPORTED_GAPS).join('\n')}`);
 // 运行时只常驻当前职业 + 已拥有伙伴外观 + 共享特效；每个职业都必须能单独形成完整子集。
 const fullAssets=new Map(resident.assets.map(asset=>[asset.key,asset]));
 for(const character of battle.classes){
  const scoped=residentCombatAssets({battle,wardrobe,world,companions,classIds:[character.id]});
  for(const asset of scoped.assets){
   const previous=fullAssets.get(asset.key);
   ensure(!!previous,`职业 ${character.id} 的常驻资源不在全量包：${asset.key}`);
   // 同一图集页在不同职业包里需要的帧集合可以不同，页文件和数据文件必须一致。
   if(previous.kind==='atlas'&&asset.kind==='atlas')
    ensure(previous.file===asset.file&&previous.atlas===asset.atlas,`职业 ${character.id} 的常驻资源与全量包不一致：${asset.key}`);
   else ensure(JSON.stringify(previous)===JSON.stringify(asset),`职业 ${character.id} 的常驻资源与全量包不一致：${asset.key}`);
  }
  const scopedGaps=residentCombatCoverageGaps({battle,wardrobe,world,companions,classIds:[character.id]});
  const missing=[...scopedGaps.definitions.map(name=>`特效定义缺失 ${name}`),...scopedGaps.effects.map(name=>`常驻包缺少特效 ${name}`),
   ...scopedGaps.layers.map(key=>`常驻包缺少特效纹理 ${key}`),...scopedGaps.actorLayers.map(key=>`常驻包缺少角色纹理 ${key}`),
   ...scopedGaps.companions.map(id=>`佣兵外观无法按需加载 ${id}`)];
  ensure(!missing.length,`职业 ${character.id} 的常驻资源不完整：\n${missing.slice(0,MAX_REPORTED_GAPS).join('\n')}`);
 }
 return {maps:world.maps.length,assets:assets.size};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(validateContent(process.argv[2]));
