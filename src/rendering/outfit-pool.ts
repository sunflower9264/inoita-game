import { CompositionBudget } from './composition-budget.ts';
import type { AssetLease } from '../application/assets.ts';
import type Phaser from 'phaser';
import type { ActorDefinition, AnimationClip, ClipName } from '../domain/content.ts';
import type { EquipmentSlot, ItemCatalog } from '../domain/items.ts';
import { costumeRecipe, type CostumePart, type CostumePiece, type CostumePose, type WardrobeCatalog } from '../domain/wardrobe.ts';
import { retainLoadedSceneAssets } from './scene-assets.ts';
import { releaseEffectAnimations } from './effect-animations.ts';
import { onWebGLRestore } from './webgl-recovery.ts';

export interface Outfit {
  actor: ActorDefinition;
  textures: string[];
  users: number;
  redraw(): void;
}
export interface WardrobePrepareOptions {
  /** 菜单预览只需要 idle-south；省略表示整套动作。 */
  clipNames?: Iterable<string>;
  /** 只合成这些技能的动作；省略表示该职业全部技能（构建期/测试）。 */
  learnedSkills?: ReadonlySet<string>;
  signal?: AbortSignal;
}
type WardrobePoseLoader = (ids: readonly string[], signal: AbortSignal) => Promise<Record<string, CostumePose>>;
interface OutfitLease { outfit: Outfit; release(): void }
interface OutfitEntry {
  promise: Promise<Outfit>;
  controller: AbortController;
  users: number;
  outfit?: Outfit;
  retired?: boolean;
}
export const OUTFIT_CACHE_LIMIT = 8;
let serial = 0;

/** 本次游戏共用合成纹理；使用权由场景衣柜持有，缓存不持有具体场景。 */
export class OutfitPool {
  private readonly host: Phaser.Scene;
  private readonly catalog: WardrobeCatalog;
  private readonly items: ItemCatalog;
  private readonly poseLoader?: WardrobePoseLoader;
  private readonly entries = new Map<string, OutfitEntry>();
  private readonly poseLoads = new Map<string, Promise<void>>();
  private lifetime = new AbortController();
  private active = true;
  private readonly offRestore: () => void;

  constructor(host: Pick<Phaser.Scene, 'textures' | 'anims' | 'game'>, catalog: WardrobeCatalog,
    items: ItemCatalog, poseLoader?: WardrobePoseLoader) {
    this.host = { textures: host.textures, anims: host.anims, game: host.game,
      sys: { settings: { key: 'outfit-pool' } } } as Phaser.Scene;
    this.catalog = { ...catalog, poses: { ...catalog.poses } }; this.items = items; this.poseLoader = poseLoader;
    this.offRestore = onWebGLRestore(this.host, () => this.redrawCached());
  }
  get available():boolean { return this.active; }
  key(base: ActorDefinition, equipment: Partial<Record<EquipmentSlot, string>>, classId?: string,
    options?: WardrobePrepareOptions): string {
    const recipe = costumeRecipe(this.catalog, this.items, equipment, classId, base.id, options?.learnedSkills);
    return JSON.stringify([base.id, base.clips, recipe.poses, Object.entries(recipe.variants).sort(),
      options?.clipNames === undefined ? null : [...options.clipNames].sort()]);
  }
  async acquire(base: ActorDefinition, equipment: Partial<Record<EquipmentSlot, string>>, classId: string | undefined,
    options: WardrobePrepareOptions | undefined, signal: AbortSignal): Promise<OutfitLease> {
    signal.throwIfAborted();
    if (!this.active) throw new DOMException('人物外观池已关闭', 'AbortError');
    const key = this.key(base, equipment, classId, options);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { controller: new AbortController(), users: 0, promise: undefined! };
      this.entries.set(key, entry);
      entry.promise = this.prepare(base, equipment, classId, options, entry.controller.signal).then(outfit => {
        if(entry!.controller.signal.aborted){this.dispose(outfit);entry!.controller.signal.throwIfAborted();}
        entry!.outfit = outfit; this.trim(); return outfit;
      }, error => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    } else { this.entries.delete(key); this.entries.set(key, entry); }
    entry.users++;
    const held = entry;
    let released = false;
    const release = (retain = true) => {
      if (released) return; released = true; held.users--;
      if (!held.users && (!held.outfit || !retain)) {
        if (this.entries.get(key) === held) this.entries.delete(key);
        held.controller.abort(new DOMException('人物外观已无人使用', 'AbortError'));
        if(held.outfit)this.dispose(held.outfit);
      } else if (!held.users && held.retired && held.outfit) this.dispose(held.outfit);
      this.trim();
    };
    try {
      const outfit = await new Promise<Outfit>((resolve, reject) => {
        const abort = () => { clean(); reject(signal.reason); };
        const clean = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        held.promise.then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
      });
      signal.throwIfAborted();
      return { outfit, release };
    } catch (error) { release(false); throw error; }
  }
  clear(): void {
    this.lifetime.abort(new DOMException('人物外观生成已取消', 'AbortError'));
    this.lifetime = new AbortController(); this.poseLoads.clear();
    if (this.poseLoader) this.catalog.poses = {};
    for (const entry of this.entries.values()) {
      entry.retired = true; entry.controller.abort(new DOMException('人物外观池已清理', 'AbortError'));
      if (!entry.users && entry.outfit) this.dispose(entry.outfit);
    }
    this.entries.clear();
  }
  destroy(): void {
    if (!this.active) return;
    this.active = false; this.offRestore(); this.clear();
  }
  private trim(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= OUTFIT_CACHE_LIMIT) break;
      if (entry.users || !entry.outfit) continue;
      this.dispose(entry.outfit); this.entries.delete(key);
    }
  }
  private redrawCached(): void {
    for (const [key, entry] of this.entries) {
      if (!entry.outfit) continue;
      if (!entry.users) { this.dispose(entry.outfit); this.entries.delete(key); continue; }
      try { entry.outfit.redraw(); }
      catch (error) { console.warn('人物外观恢复失败', error); }
    }
  }
  private readonly sources = new WeakMap<Outfit, AssetLease>();
  private dispose(outfit: Outfit): void {
    for (const key of outfit.textures) {
      // 合成外观的动画 key 是 `${key}#...`，不是纹理 key；按全局账本删掉引用它的动画。
      releaseEffectAnimations(this.host.anims, key);
      if (this.host.textures.exists(key)) this.host.textures.remove(key);
    }
    this.sources.get(outfit)?.release(); this.sources.delete(outfit);
  }
  private loadPose(id: string): Promise<void> {
    if (this.catalog.poses[id]) return Promise.resolve();
    const pending = this.poseLoads.get(id); if (pending) return pending;
    if (!this.poseLoader) return Promise.reject(new Error(`人物动作未加载：${id}`));
    const signal = this.lifetime.signal;
    const load = this.poseLoader([id], signal).then(poses => {
      signal.throwIfAborted(); Object.assign(this.catalog.poses, poses);
      if (!this.catalog.poses[id]) throw new Error(`人物动作缺失：${id}`);
    });
    this.poseLoads.set(id, load);
    void load.catch(() => { if (this.poseLoads.get(id) === load) this.poseLoads.delete(id); });
    return load;
  }
  private async prepare(base: ActorDefinition, equipment: Partial<Record<EquipmentSlot, string>>, classId: string | undefined,
    options: WardrobePrepareOptions | undefined, signal: AbortSignal): Promise<Outfit> {
    const recipe = costumeRecipe(this.catalog, this.items, equipment, classId, base.id, options?.learnedSkills);
    const requested = options?.clipNames === undefined ? undefined : new Set(options.clipNames);
    const poses = Object.entries(recipe.poses).filter(([name]) => !requested || requested.has(name));
    const missing = [...new Set(poses.map(([, id]) => id).filter((id): id is string => !!id && !this.catalog.poses[id]))];
    if (missing.length) await Promise.all(missing.map(id => this.loadPose(id)));
    signal.throwIfAborted();
    const sources = retainLoadedSceneAssets(this.host, this.catalog.textures.map(texture => ({ kind: 'image' as const, ...texture })));
    try {
      for (const [key, piece] of Object.entries(this.catalog.sprites)) {
        const texture = this.host.textures.get(piece.texture);
        if (!texture.has(key)) texture.add(key, 0, piece.x, piece.y, piece.width, piece.height);
      }
      const outfit = await this.compose(base, recipe, poses, signal);
      this.sources.set(outfit, sources);
      if(signal.aborted){this.dispose(outfit);signal.throwIfAborted();}
      return outfit;
    } catch (error) { sources.release(); throw error; }
  }
  private async compose(base:ActorDefinition,recipe:ReturnType<typeof costumeRecipe>,poses:[string,string|undefined][],
    signal:AbortSignal):Promise<Outfit> {
    const textures:string[]=[], clips:ActorDefinition['clips']={}, paints:(()=>void)[]=[];
    const source=(part:CostumePart): {key:string;piece:CostumePiece} | undefined => {
      const variant=recipe.variants[part.part];
      if(!variant)return;
      const key=this.catalog.variants[variant][part.piece];
      return key?{key,piece:this.catalog.sprites[key]}:undefined;
    };
    try {
      const budget=new CompositionBudget();
      let partCount=0;
      for(const [name,id]of poses) {
        signal.throwIfAborted();
        const pose=this.catalog.poses[id!];
        const points: {x:number;y:number}[]=[];
        for(const frame of pose.frames)for(const part of frame) {
          if(budget.due)await budget.pause(signal);
          const info=source(part);if(!info)continue;
          const {piece}=info,angle=part.angle*Math.PI/180,co=Math.cos(angle),si=Math.sin(angle);
          for(const x of [0,piece.width])for(const y of [0,piece.height]) {
            const u=(x-piece.anchorX)*part.scaleX,v=(y-piece.anchorY)*part.scaleY;
            points.push({x:part.x+u*co-v*si,y:part.y+u*si+v*co});
          }
        }
        if(!points.length)points.push({x:0,y:0});
        const left=Math.floor(Math.min(...points.map(p=>p.x)))-1,top=Math.floor(Math.min(...points.map(p=>p.y)))-1;
        const width=Math.ceil(Math.max(...points.map(p=>p.x)))-left+1,height=Math.ceil(Math.max(...points.map(p=>p.y)))-top+1;
        const columns=Math.min(pose.frames.length,Math.max(1,Math.floor(2048/width)));
        const key=`outfit-${++serial}`,texture=this.host.textures.addDynamicTexture(key,columns*width,Math.ceil(pose.frames.length/columns)*height);
        if(!texture)throw new Error('人物外观纹理创建失败');
        textures.push(key);
        const stamps:{texture:string;frame:string;x:number;y:number;config:{originX:number;originY:number;scaleX:number;scaleY:number;angle:number;alpha:number}}[]=[];
        pose.frames.forEach((parts,index)=>{
          const x=index%columns*width,y=Math.floor(index/columns)*height;
          for(const part of parts) {
            const info=source(part);if(!info)continue;
            stamps.push({texture:info.piece.texture,frame:info.key,x:x+part.x-left,y:y+part.y-top,
              config:{originX:info.piece.anchorX/info.piece.width,originY:info.piece.anchorY/info.piece.height,
                scaleX:part.scaleX,scaleY:part.scaleY,angle:part.angle,alpha:part.alpha}});
          }
          texture.add(String(index),0,x,y,width,height);
        });
        const paint=()=>{
          if(!this.host.textures.exists(key))return;
          texture.clear();
          for(const stamp of stamps)texture.stamp(stamp.texture,stamp.frame,stamp.x,stamp.y,stamp.config);
          texture.render();
        };
        texture.clear();
        for(let offset=0;offset<stamps.length;offset+=128){
          signal.throwIfAborted();
          for(const stamp of stamps.slice(offset,offset+128))texture.stamp(stamp.texture,stamp.frame,stamp.x,stamp.y,stamp.config);
          texture.render();partCount+=Math.min(128,stamps.length-offset);
          if(budget.due)await budget.pause(signal);
        }
        if(!stamps.length)texture.render();
        paints.push(paint);
        const clip:AnimationClip={frameWidth:width,frameHeight:height,frames:pose.frames.length,originX:-left/width,originY:-top/height,
          frameRate:pose.frameRate,mirrorX:pose.mirrorX,layers:[{key,file:'',blend:'normal'}]};
        clips[name as ClipName]=clip;
        if(budget.due)await budget.pause(signal);
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      budget.finish();
      globalThis.storyDiagnostics?.record('outfit-compose-summary',{clips:poses.length,parts:partCount,longestWorkMs:Math.round(budget.longestMs*10)/10});
      const outfit={actor:{...base,clips:{...base.clips,...clips}},textures,users:0,
        redraw:()=>{for(const paint of paints)paint();}};
      return outfit;
    } catch(error){this.dispose({actor:base,textures,users:0,redraw:()=>{}});throw error;}
  }
}
