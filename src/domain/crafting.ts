import {rollChaos,type ChaosTier,type ChaosRule} from './chaos-equipment.ts';
import {DEFAULT_EQUIPMENT_GRADE,type CharacterStatsCatalog} from './character-stats.ts';
import type {ItemCatalog,ItemInstance,ItemRecipe,ItemReward} from './items.ts';
import type {Session} from './session.ts';

interface CraftingOperationBase {name:string;materials:ItemReward[]}
interface ChaosCraftingOperation extends CraftingOperationBase {costPerLevel:number;rule:ChaosRule}
/** 融合器「宝石孔生成」：原版配方 #16；只对 0 孔装备生成孔位。 */
export interface SocketCraftingOperation extends CraftingOperationBase {cost:number;socketWeights:number[];socketLimits:number[]}
export interface CraftingCatalog {operations:{chaos:ChaosCraftingOperation;'epic-chaos':ChaosCraftingOperation;socket:SocketCraftingOperation}}
type CraftingNotice='craft-target'|'craft-incompatible'|'craft-equipment'|'craft-socket'|'craft-epic'|'craft-needs-chaos'|'craft-max'|'craft-money'|'craft-materials'|'craft-recipe';
export class CraftingError extends Error {
  readonly notice:CraftingNotice;
  constructor(notice:CraftingNotice){super('无法进行合成');this.notice=notice;}
}
export interface CraftingQuote {readonly tier:ChaosTier;readonly target:string;readonly revision:number;readonly cost:number}
export interface RecipeQuote {readonly recipe:string;readonly revision:number;readonly cost:number}
export interface SocketQuote {readonly target:string;readonly revision:number;readonly cost:number}

export function parseCrafting(value:unknown):CraftingCatalog {
  const fail=()=>{throw new Error('合成目录无效');};
  if(!value||typeof value!=='object')fail();
  const data=value as CraftingCatalog;
  if(!data.operations||Object.keys(data.operations).length!==3)fail();
  const integer=(n:unknown):n is number=>Number.isSafeInteger(n);
  for(const tier of ['chaos','epic-chaos'] as const){
    const op=data.operations[tier];
    if(!op||typeof op.name!=='string'||!op.name.trim()||!integer(op.costPerLevel)||op.costPerLevel<=0||!Array.isArray(op.materials)||op.materials.length!==4)fail();
    if(op.materials.some(m=>!m||typeof m.item!=='string'||!m.item||!integer(m.quantity)||m.quantity<=0)||new Set(op.materials.map(m=>m.item)).size!==4)fail();
    const rule=op.rule;
    if(!rule||!integer(rule.levelDiceDivisor)||rule.levelDiceDivisor<=0||!integer(rule.levelClampDivisor)||rule.levelClampDivisor<=0)fail();
    for(const pair of [rule.valueDelta,rule.valueBounds])if(!Array.isArray(pair)||pair.length!==2||!pair.every(integer)||pair[0]>pair[1])fail();
    if(rule.valueBounds[0]!==0||rule.valueBounds[1]!== (tier==='chaos'?150:200))fail();
  }
  const socket=data.operations.socket;
  if(!socket||typeof socket.name!=='string'||!socket.name.trim()||!Array.isArray(socket.materials)||socket.materials.length!==2)fail();
  if(socket.materials.some(m=>!m||typeof m.item!=='string'||!m.item||!integer(m.quantity)||m.quantity<=0)||new Set(socket.materials.map(m=>m.item)).size!==2)fail();
  if(!integer(socket.cost)||socket.cost<=0)fail();
  if(!Array.isArray(socket.socketWeights)||!socket.socketWeights.length||!socket.socketWeights.every(n=>integer(n)&&n>0))fail();
  if(!Array.isArray(socket.socketLimits)||socket.socketLimits.length!==5||!socket.socketLimits.every(n=>integer(n)&&n>=1&&n<=4))fail();
  if(socket.socketWeights.length<Math.max(...socket.socketLimits))fail();
  return data;
}
export function validateCrafting(catalog:CraftingCatalog,items:ItemCatalog):void {
  for(const op of Object.values(catalog.operations))for(const material of op.materials)
    if(!items.items[material.item]||items.items[material.item].equipment||items.items[material.item].pickup)throw new Error(`合成材料不存在：${material.item}`);
}

/** 先核对装备、材料和费用，确认时重新核对，再一次性提交给会话。 */
export class EquipmentCrafting {
  readonly session:Session;readonly catalog:CraftingCatalog;
  constructor(session:Session,catalog:CraftingCatalog){this.session=session;this.catalog=catalog;}
  recipe(id:string):ItemRecipe|undefined { return this.session.bag.catalog.recipes[id]; }
  /** 配方书配方只有学会后才进入列表；常备配方（药水、宝石）始终可用。 */
  availableRecipes():{id:string;recipe:ItemRecipe}[] {
    const learned=new Set(this.session.bag.learnedRecipes);
    return Object.entries(this.session.bag.catalog.recipes)
      .filter(([id,recipe])=>!recipe.book||learned.has(id))
      .map(([id,recipe])=>({id,recipe}));
  }
  recipeQuote(id:string):RecipeQuote {
    const bag=this.session.bag,recipe=bag.catalog.recipes[id];
    if(!recipe||(recipe.book&&!bag.learnedRecipes.includes(id)))throw new CraftingError('craft-recipe');
    if(recipe.materials.some(m=>bag.count(m.item)<m.quantity))throw new CraftingError('craft-materials');
    if(this.session.money<recipe.cost)throw new CraftingError('craft-money');
    return {recipe:id,revision:bag.revision,cost:recipe.cost};
  }
  recipeCommit(quote:RecipeQuote):void {
    const bag=this.session.bag;
    if(bag.revision!==quote.revision)throw new CraftingError('craft-target');
    const current=this.recipeQuote(quote.recipe),recipe=bag.catalog.recipes[current.recipe];
    if(bag.revision!==current.revision)throw new CraftingError('craft-target');
    this.session.transaction(()=>{
      for(const material of recipe.materials)bag.remove(material.item,material.quantity);
      this.session.spendMoney(current.cost);
      bag.add(recipe.result,1);
    });
  }
  targetProblem(tier:ChaosTier,target?:string):CraftingNotice|undefined {
    const bag=this.session.bag,entry=target?bag.get(target):undefined;
    if(!entry||!bag.entries.some(e=>e.id===target))return 'craft-target';
    const item=bag.catalog.items[entry.item];
    if(!entry.numbers||!item.equipment||!['weapon','armor'].includes(item.priceKind??''))return 'craft-incompatible';
    const chaos=entry.numbers.chaos;
    if(tier==='chaos'){
      if(chaos?.tier==='epic-chaos')return 'craft-epic';
      if((chaos?.valuePercent??100)>=this.catalog.operations.chaos.rule.valueBounds[1])return 'craft-max';
    }else{
      if(!chaos)return 'craft-needs-chaos';
      if(chaos.tier==='epic-chaos'&&chaos.valuePercent>=this.catalog.operations['epic-chaos'].rule.valueBounds[1])return 'craft-max';
    }
    return undefined;
  }
  quote(tier:ChaosTier,target?:string):CraftingQuote {
    const problem=this.targetProblem(tier,target);if(problem)throw new CraftingError(problem);
    const bag=this.session.bag,entry=bag.get(target!)!,op=this.catalog.operations[tier],cost=bag.catalog.items[entry.item].level*op.costPerLevel;
    if(op.materials.some(m=>bag.count(m.item)<m.quantity))throw new CraftingError('craft-materials');
    if(this.session.money<cost)throw new CraftingError('craft-money');
    return {tier,target:target!,revision:bag.revision,cost};
  }
  commit(quote:CraftingQuote,random:()=>number=Math.random):void {
    const bag=this.session.bag;
    if(bag.revision!==quote.revision)throw new CraftingError('craft-target');
    const current=this.quote(quote.tier,quote.target),entry=bag.get(current.target)!,op=this.catalog.operations[current.tier];
    const chaos=rollChaos(bag.catalog.items[entry.item],entry,current.tier,op.rule,random);
    // Random callbacks and other callers may have changed inventory or money since the first query.
    if(bag.revision!==current.revision)throw new CraftingError('craft-target');
    this.quote(current.tier,current.target);
    this.session.transaction(()=>{
      bag.applyChaos(current.target,chaos,current.revision);
      for(const material of op.materials)bag.remove(material.item,material.quantity);
      this.session.spendMoney(current.cost);
    });
  }

  /** 宝石孔生成只接受装备类、且当前孔位上限为 0 的实例；对应原版 CheckMixture 的 0 孔检查。 */
  targetSocketProblem(target?:string):CraftingNotice|undefined {
    const bag=this.session.bag,entry=target?bag.get(target):undefined;
    if(!entry||!bag.entries.some(e=>e.id===target))return 'craft-target';
    const item=bag.catalog.items[entry.item];
    if(!item.equipment)return 'craft-equipment';
    if(!entry.numbers)return 'craft-incompatible';
    if(entry.numbers.sockets>0)return 'craft-socket';
    return undefined;
  }
  /** 预览这次会生成几个孔：普通品级 1..上限，稀有品级固定 1。 */
  socketRange(target?:string):{min:number;max:number}|undefined {
    const entry=target?this.session.bag.get(target):undefined;
    if(!entry?.numbers)return undefined;
    const rarity=socketRarity(entry,this.session.hero?.catalog);
    const limit=this.catalog.operations.socket.socketLimits[rarity]??1;
    return rarity===0?{min:1,max:limit}:{min:1,max:1};
  }
  socketQuote(target?:string):SocketQuote {
    const problem=this.targetSocketProblem(target);if(problem)throw new CraftingError(problem);
    const bag=this.session.bag,op=this.catalog.operations.socket;
    if(op.materials.some(m=>bag.count(m.item)<m.quantity))throw new CraftingError('craft-materials');
    if(this.session.money<op.cost)throw new CraftingError('craft-money');
    return {target:target!,revision:bag.revision,cost:op.cost};
  }
  socketCommit(quote:SocketQuote,random:()=>number=Math.random):void {
    const bag=this.session.bag;
    if(bag.revision!==quote.revision)throw new CraftingError('craft-target');
    const current=this.socketQuote(quote.target),entry=bag.get(current.target)!,op=this.catalog.operations.socket;
    const sockets=rollSocketCreation(entry,this.session.hero?.catalog,op,random);
    // 随机回调不读写背包，但保持与混沌合成相同的二次核对口径。
    if(bag.revision!==current.revision)throw new CraftingError('craft-target');
    this.socketQuote(current.target);
    this.session.transaction(()=>{
      bag.applySockets(current.target,sockets,current.revision);
      for(const material of op.materials)bag.remove(material.item,material.quantity);
      this.session.spendMoney(current.cost);
    });
  }
}


/** 品级对应的稀有度档；与原版 `ITEMGRADEBASE[grade].+4` 同一来源。 */
function socketRarity(entry:ItemInstance,stats:CharacterStatsCatalog|undefined):number {
  const grade=entry.numbers?.grade??DEFAULT_EQUIPMENT_GRADE;
  return stats?.equipment[entry.item]?.gradeVariants?.[grade]?.rarity
    ?? stats?.grades?.find(value=>value.index===grade)?.rarity ?? 0;
}

/** 原版 ApplySocketForMixure：普通稀有度档按权重随机 1..上限；更高档固定 1 孔。 */
export function rollSocketCreation(entry:ItemInstance,stats:CharacterStatsCatalog|undefined,
  operation:SocketCraftingOperation,random:()=>number):number {
  const rarity=socketRarity(entry,stats);
  if(rarity!==0)return 1;
  const limit=operation.socketLimits[rarity]??operation.socketLimits[0]??1;
  const value=random();
  if(!Number.isFinite(value)||value<0||value>=1)throw new Error('宝石孔随机值无效');
  const roll=Math.floor(value*100);
  let threshold=0;
  for(let index=0;index<Math.min(limit,operation.socketWeights.length);index+=1){
    threshold+=operation.socketWeights[index]!;
    if(roll<threshold)return index+1;
  }
  return 1;
}
