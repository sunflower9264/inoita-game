import {parseCrafting} from '../domain/crafting.ts';
import type { WorldIndex, WorldMap } from '../domain/content.ts';
import type { Campaign } from '../domain/campaign.ts';
import type { BattleCatalog } from '../domain/battle.ts';
import { parseStatusHud, parseCharacterStats, parseMenuPanels, parseBattle, parseCampaign, parseMap, parseWorld, parseStoryInterface, parseControlSkin, parseStoryClasses, parseItemCatalog, parseWardrobe, parseShops, parseShopEquipment, parseCompanions, parseStoryDebugCatalog } from './content-validation.ts';
import type { StoryInterface } from '../domain/story-interface.ts';
import type { ShopCatalog } from '../domain/shop.ts';
import { parseSprings, type SpringCatalog } from '../domain/springs.ts';
import { wardrobePoseFile, type CostumePose, type WardrobeCatalog } from '../domain/wardrobe.ts';
import { versionedContent } from './asset-version.ts';

interface ContentRequest<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
  finished: boolean;
}

export class ContentLoader {
  /**
   * 生产构建信任构建期校验：只做 JSON.parse，不重复跑 parseX 的语义校验。
   * 开发服务、Node 测试与直接 import 默认 false；main.ts 按构建常量/GM 打开。
   */
  trusted = false;
  private readonly requests = new Map<string, ContentRequest<unknown>>();
  statusHud(signal?:AbortSignal){return this.read('content/status-hud.json',parseStatusHud,signal);}
  characterStats(signal?:AbortSignal){return this.read('content/character-stats.json',parseCharacterStats,signal);}
  items(signal?:AbortSignal){return this.read('content/items.json',parseItemCatalog,signal);}
  drops(signal?:AbortSignal):Promise<unknown>{return this.read('content/drops.json',(value:unknown)=>value,signal);}
  springs(signal?:AbortSignal):Promise<SpringCatalog>{return this.read('content/springs.json',parseSprings,signal);}
  crafting(signal?:AbortSignal){return this.read('content/crafting.json',parseCrafting,signal);}
  shops(signal?:AbortSignal){return this.read('content/shops.json',parseShops,signal);}
  /** 生产内容包把大型装备表拆到独立文件；打开商店时再取。 */
  async shopEquipment(signal?:AbortSignal):Promise<ShopCatalog['equipment']>{
    const value=await this.read<{equipment:ShopCatalog['equipment']}>('content/shops-equipment.json',
      data=>data as {equipment:ShopCatalog['equipment']},signal);
    // 生产包省略了 variants；从已加载的 character-stats 派生，避免重复存储 726 KB。
    const stats=await this.characterStats(signal);
    return parseShopEquipment(value, stats);
  }
  companions(signal?:AbortSignal){return this.read('content/companions.json',parseCompanions,signal);}
  /**
   * 人物动作占 wardrobe 的绝大部分。生产包把它们拆成单文件，`Wardrobe` 只取当前
   * 武器/职业用到的动作；dev/GM 需要完整校验时再把全部动作合回来跑 parseWardrobe。
   */
  async wardrobe(signal?:AbortSignal):Promise<WardrobeCatalog>{
    const core=await this.read<WardrobeCatalog>('content/wardrobe.json',value=>value as WardrobeCatalog,signal);
    if(this.trusted)return core;
    if(Object.keys(core.poses).length)return parseWardrobe(core);
    const ids=await this.read<string[]>('content/wardrobe/pose-index.json',value=>value as string[],signal);
    return parseWardrobe({...core,poses:await this.wardrobePoses(ids,signal)});
  }
  async wardrobePoses(ids:readonly string[],signal?:AbortSignal):Promise<Record<string,CostumePose>>{
    const entries=await Promise.all(ids.map(async id=>[id,await this.read<CostumePose>(wardrobePoseFile(id),value=>value as CostumePose,signal)]as const));
    return Object.fromEntries(entries);
  }
  private read<T>(file:string, parse:(data:unknown)=>T, signal?:AbortSignal):Promise<T>{
    signal?.throwIfAborted();
    let request = this.requests.get(file) as ContentRequest<T> | undefined;
    if (!request) {
      const controller = new AbortController();
      const promise = (async () => {
        const response = await fetch(versionedContent(file), { signal: controller.signal });
        if (!response.ok) throw new Error(`资源暂时无法加载：${file}`);
        const value = await response.json();
        controller.signal.throwIfAborted();
        // 已核对现有 parseX 都是“校验后返回原对象”，生产可跳过；dev/test 仍完整校验。
        return this.trusted ? value as T : parse(value);
      })();
      request = { promise, controller, waiters: 0, finished: false };
      this.requests.set(file, request);
      const current = request;
      void promise.then(
        () => { current.finished = true; },
        error => {
          if(!controller.signal.aborted)globalThis.storyDiagnostics?.record('content-load-error',{file,error});
          current.finished = true;
          if (this.requests.get(file) === current) this.requests.delete(file);
        }
      );
    }
    return new Promise<T>((resolve, reject) => {
      let waiting = true;
      request.waiters++;
      const finish = () => {
        if (!waiting) return false;
        waiting = false;
        signal?.removeEventListener('abort', abort);
        request.waiters--;
        if (!request.waiters && !request.finished) {
          if (this.requests.get(file) === request) this.requests.delete(file);
          request.controller.abort();
        }
        return true;
      };
      const abort = () => { if (finish()) reject(signal?.reason ?? new DOMException('加载已取消', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      void request.promise.then(
        value => { if (finish()) resolve(value); },
        error => { if (finish()) reject(error); }
      );
    });
  }
  menuPanels(signal?:AbortSignal){return this.read('content/menu-panels.json',parseMenuPanels,signal);}
  controlSkin(signal?:AbortSignal){return this.read('content/control-skin.json',parseControlSkin,signal);}
  world(signal?:AbortSignal):Promise<WorldIndex>{return this.read('content/world.json',parseWorld,signal);}
  campaign(signal?:AbortSignal):Promise<Campaign>{return this.read('content/campaign.json',parseCampaign,signal);}
  /** GM 现场表按需加载；普通游玩不请求这个文件。 */
  storyDebug(signal?:AbortSignal){return this.read('content/debug/start.json',parseStoryDebugCatalog,signal);}
  storyInterface(signal?:AbortSignal):Promise<StoryInterface>{return this.read('content/story-interface.json',parseStoryInterface,signal);}
  storyClasses(signal?:AbortSignal){return this.read('content/story-classes.json',parseStoryClasses,signal);}
  battle(signal?:AbortSignal):Promise<BattleCatalog>{return this.read('content/battle.json',parseBattle,signal);}
  map(file:string,signal?:AbortSignal):Promise<WorldMap>{return this.read(file,parseMap,signal);}
}
