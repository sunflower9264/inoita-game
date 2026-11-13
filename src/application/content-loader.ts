import {parseCrafting} from '../domain/crafting.ts';
import type { WorldIndex, WorldMap } from '../domain/content.ts';
import type { Campaign } from '../domain/campaign.ts';
import type { BattleCatalog } from '../domain/battle.ts';
import { parseStatusHud, parseCharacterStats, parseMenuPanels, parseBattle, parseCampaign, parseMap, parseWorld, parseStoryInterface, parseControlSkin, parseStoryClasses, parseItemCatalog, parseWardrobe, parseShops, parseShopEquipment, parseCompanions, parseStoryDebugCatalog, parseChangelog } from './content-validation.ts';
import type { ChangelogCatalog } from '../domain/changelog.ts';
import type { StoryInterface } from '../domain/story-interface.ts';
import type { ShopCatalog } from '../domain/shop.ts';
import { parseSprings, type SpringCatalog } from '../domain/springs.ts';
import { wardrobePoseFile, type CostumePose, type WardrobeCatalog } from '../domain/wardrobe.ts';
import { contentVersionNow, versionedContent } from './asset-version.ts';
import { storyDevMode } from '../domain/dev-mode.ts';

const CONTENT_TIMEOUT_MS = 15_000;

async function withContentTimeout<T>(file: string, controller: AbortController, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`资源加载超时：${file}`);
      controller.abort(error);
      reject(error);
    }, CONTENT_TIMEOUT_MS);
  });
  try { return await Promise.race([work, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

interface ContentManifest {
  schema: 1;
  contentVersion: string;
  required: Record<string, string[]>;
}

/** 核心内容表跨会话常驻；会话级内容只服务当前地图/外观，可在回菜单或新会话时丢弃。 */
type ContentScope = 'core' | 'map' | 'pose';

interface ContentRequest<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
  finished: boolean;
  scope: ContentScope;
}

export class ContentLoader {
  /**
   * 生产构建信任构建期校验：只做 JSON.parse，不重复跑 parseX 的语义校验。
   * 开发服务、Node 测试与直接 import 默认 false；main.ts 按构建常量/GM 打开。
   */
  trusted = false;
  /**
   * 页面构建时注入的内容版本。生产信任路径先核对服务端清单与它是否一致；
   * Node 测试默认空串，可显式赋值来验证不匹配分支。
   */
  contentVersion = contentVersionNow();
  private manifestRequest?: Promise<ContentManifest>;
  private readonly requests = new Map<string, ContentRequest<unknown>>();
  private splitWardrobe = true;
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
    this.splitWardrobe = !Object.keys(core.poses).length;
    if(this.trusted)return core;
    if(Object.keys(core.poses).length)return parseWardrobe(core);
    const ids=await this.read<string[]>('content/wardrobe/pose-index.json',value=>value as string[],signal);
    return parseWardrobe({...core,poses:await this.wardrobePoses(ids,signal)});
  }
  async wardrobePoses(ids:readonly string[],signal?:AbortSignal):Promise<Record<string,CostumePose>>{
    if (!this.splitWardrobe) {
      const catalog = await this.read('content/wardrobe.json', parseWardrobe, signal, 'pose');
      return Object.fromEntries(ids.map(id => {
        const pose = catalog.poses[id];
        if (!pose) throw new Error(`人物动作缺失：${id}`);
        return [id, pose];
      }));
    }
    const entries=await Promise.all(ids.map(async id=>[id,await this.read<CostumePose>(wardrobePoseFile(id),value=>value as CostumePose,signal,'pose')]as const));
    return Object.fromEntries(entries);
  }
  /** 全量校验完成后仅保留衣柜目录；动作由会话中的外观池按需持有。 */
  releaseValidationCaches(wardrobe: WardrobeCatalog): void {
    wardrobe.poses = {};
    if (!this.splitWardrobe) this.requests.delete('content/wardrobe.json');
    this.clearSessionCaches();
  }
  /**
   * 会话边界清理：丢弃已经完成的会话级内容（地图与人物动作），核心内容表继续常驻。
   * 只删缓存条目，不 abort 进行中的请求，也不改动已经返回给调用方的对象。
   */
  clearSessionCaches(): void {
    for (const [file, request] of this.requests) {
      if (request.scope !== 'core' && request.finished && this.requests.get(file) === request)
        this.requests.delete(file);
    }
  }
  private trimMaps(): void {
    const completed = [...this.requests].filter(([, request]) => request.scope === 'map' && request.finished);
    let excess = completed.length - 2;
    for (const [file, request] of completed) {
      if (excess <= 0) break;
      if (request.waiters) continue;
      this.requests.delete(file); excess--;
    }
  }
  /**
   * 生产内容哨兵：只取一次很小的清单，核对版本和本次文件声明的必需顶层键。
   *
   * 版本或键不匹配时明确失败，不静默继续。网页上由启动错误页提示刷新；
   * Android 壳把启动失败交给热更新回退到上一版（见 `docs/live-update.md`）。
   */
  private async verifyTrusted(file:string, value:unknown, signal?:AbortSignal):Promise<void>{
    const manifest=await this.trustedManifest();
    signal?.throwIfAborted();
    if(!this.contentVersion&&!storyDevMode())
      throw new Error('页面没有内容版本，无法核对生产内容，请刷新页面或更新客户端');
    if(this.contentVersion && manifest.contentVersion!==this.contentVersion)
      throw new Error(`内容版本与页面不一致（页面 ${this.contentVersion}，内容 ${manifest.contentVersion}），请刷新页面或更新客户端`);
    const required=manifest.required[file];
    if(!required)return;
    if(!value||typeof value!=='object'||Array.isArray(value))
      throw new Error(`内容文件格式无效：${file}；请刷新页面或更新客户端`);
    for(const key of required)if(!(key in value))
      throw new Error(`内容缺少必需字段：${file} ${key}；请刷新页面或更新客户端`);
  }
  private trustedManifest():Promise<ContentManifest>{
    if(!this.manifestRequest){
      const controller = new AbortController();
      const request=(async():Promise<ContentManifest>=>{
        // 清单很小，和单个内容请求解耦；调用方取消只在读完后由 signal 检查。
        const response=await fetch('content-manifest.json', { signal: controller.signal });
        if(!response.ok)throw new Error('生产内容清单缺失，请刷新页面或更新客户端');
        const manifest=await response.json() as ContentManifest;
        if(manifest?.schema!==1||typeof manifest.contentVersion!=='string'||!manifest.required||typeof manifest.required!=='object'||Array.isArray(manifest.required))
          throw new Error('生产内容清单格式无效，请刷新页面或更新客户端');
        return manifest;
      })();
      // 失败后允许重试，与单个内容文件的行为一致。
      this.manifestRequest=withContentTimeout('content-manifest.json', controller, request)
        .catch(error=>{this.manifestRequest=undefined;throw error;});
    }
    return this.manifestRequest;
  }
  private read<T>(file:string, parse:(data:unknown)=>T, signal?:AbortSignal, scope:ContentScope='core'):Promise<T>{
    signal?.throwIfAborted();
    let request = this.requests.get(file) as ContentRequest<T> | undefined;
    if (!request) {
      const controller = new AbortController();
      const promise = withContentTimeout(file, controller, (async () => {
        const response = await fetch(versionedContent(file), { signal: controller.signal });
        if (!response.ok) throw new Error(`资源暂时无法加载：${file}`);
        const value = await response.json();
        controller.signal.throwIfAborted();
        // 生产信任路径只核对内容哨兵；dev/test/GM 仍完整校验。
        if(this.trusted){
          await this.verifyTrusted(file,value,controller.signal);
          return value as T;
        }
        return parse(value);
      })());
      request = { promise, controller, waiters: 0, finished: false, scope };
      this.requests.set(file, request);
      const current = request;
      void promise.then(
        () => {
          current.finished = true;
          if (current.scope === 'pose' && this.requests.get(file) === current) this.requests.delete(file);
        },
        error => {
          if(!controller.signal.aborted || controller.signal.reason === error && error instanceof Error && error.message.startsWith('资源加载超时'))
            globalThis.storyDiagnostics?.record('content-load-error',{file,error});
          current.finished = true;
          if (this.requests.get(file) === current) this.requests.delete(file);
        }
      );
    } else if (request.scope === 'map') {
      this.requests.delete(file); this.requests.set(file, request);
    }
    return new Promise<T>((resolve, reject) => {
      let waiting = true;
      request.waiters++;
      const finish = () => {
        if (!waiting) return false;
        waiting = false;
        signal?.removeEventListener('abort', abort);
        request.waiters--;
        if (request.scope === 'map' && request.finished) this.trimMaps();
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
  releaseStoryDebug():void { this.requests.delete('content/debug/start.json'); }
  /** 标题页更新日志：点开弹窗才请求，不和主菜单一起加载。 */
  changelog(signal?:AbortSignal):Promise<ChangelogCatalog>{return this.read('content/changelog.json',parseChangelog,signal);}
  releaseChangelog():void { this.requests.delete('content/changelog.json'); }
  storyInterface(signal?:AbortSignal):Promise<StoryInterface>{return this.read('content/story-interface.json',parseStoryInterface,signal);}
  storyClasses(signal?:AbortSignal){return this.read('content/story-classes.json',parseStoryClasses,signal);}
  battle(signal?:AbortSignal):Promise<BattleCatalog>{return this.read('content/battle.json',parseBattle,signal);}
  map(file:string,signal?:AbortSignal):Promise<WorldMap>{return this.read(file,parseMap,signal,'map');}
}
