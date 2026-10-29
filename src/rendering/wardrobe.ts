import type Phaser from 'phaser';
import type { ActorDefinition, AnimationClip, ClipName } from '../domain/content.ts';
import type { EquipmentSlot, ItemCatalog } from '../domain/items.ts';
import { costumeRecipe, type CostumePart, type CostumePiece, type CostumePose, type WardrobeCatalog } from '../domain/wardrobe.ts';
import { onWebGLRestore } from './webgl-recovery.ts';

interface Outfit {
  actor: ActorDefinition;
  preview: string;
  textures: string[];
  /** 正在显示这套外观的角色数；只有 0 才能回收纹理。 */
  users: number;
  /** WebGL 上下文恢复后把显存里丢失的合成图重新画一遍。 */
  redraw: () => void;
}
let serial = 0;

/** 生产内容包把人物动作拆成单文件，合成外观前只取这套武器/职业实际用到的动作。 */
export type WardrobePoseLoader = (ids: readonly string[], signal: AbortSignal) => Promise<Record<string, CostumePose>>;

/** Compile only worn combinations; Phaser owns playback of the resulting frames. */
export class Wardrobe {
  private scene: Phaser.Scene;
  private catalog: WardrobeCatalog;
  private items: ItemCatalog;
  private poseLoader?: WardrobePoseLoader;
  private poseLoads = new Map<string,Promise<void>>();
  private cache = new Map<string,Outfit>();
  private preparations = new Map<string,Promise<Outfit>>();
  private preparationRequest = new AbortController();
  private active = true;
  private readonly onShutdown = () => this.destroy();
  private readonly offRestore: () => void;
  private current?: Outfit;
  /** 切换当前外观：旧外观的引用减一，新外观加一；同一套重复激活不重复计数。 */
  activate(outfit: Outfit): void {
    if (this.current === outfit) return;
    if (this.current) this.current.users = Math.max(0, this.current.users - 1);
    outfit.users += 1;
    this.current = outfit;
  }
  constructor(scene: Phaser.Scene, catalog: WardrobeCatalog, items: ItemCatalog, poseLoader?: WardrobePoseLoader) {
    this.scene=scene;this.catalog=catalog;this.items=items;this.poseLoader=poseLoader;
    for(const [key,piece]of Object.entries(catalog.sprites)) {
      const texture=scene.textures.get(piece.texture);
      if(!texture.has(key))texture.add(key,0,piece.x,piece.y,piece.width,piece.height);
    }
    this.offRestore=onWebGLRestore(scene,()=>this.redrawCached());
    scene.events.once('shutdown',this.onShutdown);
  }
  destroy(): void {
    if (!this.active) return;
    this.active = false;
    this.offRestore();
    this.scene.events.off('shutdown', this.onShutdown);
    this.clear();
  }
  /** 上下文恢复只清空显存，不会丢 Texture 对象和动画帧；把仍在显示的外观按原键重画即可。 */
  private redrawCached(): void {
    if (!this.active) return;
    for (const [signature, outfit] of this.cache) {
      // 没人用的旧外观直接丢掉；再次需要时会按原配方重新合成，避免恢复瞬间重画整套缓存。
      if (outfit !== this.current && outfit.users <= 0) {
        this.dispose(outfit);
        this.cache.delete(signature);
        continue;
      }
      try { outfit.redraw(); }
      catch (error) { console.warn('人物外观恢复失败', error); }
    }
  }
  private dispose(outfit: Outfit): void {
    for(const key of outfit.textures) {
      if(this.scene.anims.exists(key))this.scene.anims.remove(key);
      if(this.scene.textures.exists(key))this.scene.textures.remove(key);
    }
  }
  clear(): void {
    this.preparationRequest.abort(new DOMException('人物外观生成已取消','AbortError'));
    this.preparationRequest=new AbortController();this.preparations.clear();this.poseLoads.clear();
    // 场景关闭时角色也一起销毁，这里可以强制回收全部外观。
    for(const outfit of this.cache.values()){outfit.users=0;this.dispose(outfit);}
    this.cache.clear();this.current=undefined;
  }
  private loadPose(id: string, signal: AbortSignal): Promise<void> {
    if(this.catalog.poses[id])return Promise.resolve();
    const pending=this.poseLoads.get(id);
    if(pending)return pending;
    if(!this.poseLoader)return Promise.reject(new Error(`人物动作未加载：${id}`));
    const load=(async()=>{
      const poses=await this.poseLoader!([id],signal);
      Object.assign(this.catalog.poses,poses);
      if(!this.catalog.poses[id])throw new Error(`人物动作缺失：${id}`);
    })();
    this.poseLoads.set(id,load);
    void load.catch(()=>{if(this.poseLoads.get(id)===load)this.poseLoads.delete(id);});
    return load;
  }
  async prepare(base: ActorDefinition, equipment: Partial<Record<EquipmentSlot,string>>, classId?:string): Promise<Outfit> {
    if(!this.active)throw new DOMException('场景已关闭','AbortError');
    const recipe=costumeRecipe(this.catalog,this.items,equipment,classId,base.id);
    const poseIds=[...new Set(Object.values(recipe.poses))].filter((id):id is string=>typeof id==='string');
    // dev/测试与整包内容已经在 poses 里；此时不能额外让出一拍，否则并发表演的同步阶段被打散。
    const missing=poseIds.filter(id=>!this.catalog.poses[id]);
    if(missing.length)await Promise.all(missing.map(id=>this.loadPose(id,this.preparationRequest.signal)));
    this.preparationRequest.signal.throwIfAborted();
    const signature=JSON.stringify([base.id,recipe.poses,Object.entries(recipe.variants).sort()]);
    const cached=this.cache.get(signature);
    if(cached){this.cache.delete(signature);this.cache.set(signature,cached);return cached;}
    const pending=this.preparations.get(signature);
    if(pending)return pending;
    const preparation=this.compose(base,recipe,signature,this.preparationRequest.signal);
    this.preparations.set(signature,preparation);
    try{return await preparation;}
    finally{if(this.preparations.get(signature)===preparation)this.preparations.delete(signature);}
  }
  private async compose(base:ActorDefinition,recipe:ReturnType<typeof costumeRecipe>,signature:string,signal:AbortSignal):Promise<Outfit> {
    const textures:string[]=[], clips:ActorDefinition['clips']={}, paints:(()=>void)[]=[];
    const source=(part:CostumePart): {key:string;piece:CostumePiece} | undefined => {
      const variant=recipe.variants[part.part];
      if(!variant)return;
      const key=this.catalog.variants[variant][part.piece];
      return key?{key,piece:this.catalog.sprites[key]}:undefined;
    };
    let preview='';
    try {
      for(const [name,id]of Object.entries(recipe.poses)) {
        signal.throwIfAborted();
        const pose=this.catalog.poses[id!];
        const points: {x:number;y:number}[]=[];
        for(const frame of pose.frames)for(const part of frame) {
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
        const key=`outfit-${++serial}`,texture=this.scene.textures.addDynamicTexture(key,columns*width,Math.ceil(pose.frames.length/columns)*height);
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
          if(!this.scene.textures.exists(key))return;
          texture.clear();
          for(const stamp of stamps)texture.stamp(stamp.texture,stamp.frame,stamp.x,stamp.y,stamp.config);
          texture.render();
        };
        paint();
        paints.push(paint);
        const clip:AnimationClip={frameWidth:width,frameHeight:height,frames:pose.frames.length,originX:-left/width,originY:-top/height,
          frameRate:pose.frameRate,mirrorX:pose.mirrorX,layers:[{key,file:'',blend:'normal'}]};
        clips[name as ClipName]=clip;
        if(name==='idle-south')preview=await new Promise<string>((resolve,reject)=>{
          let settled=false;
          const finish=(result:{preview:string}|{error:unknown})=>{
            if(settled)return;settled=true;signal.removeEventListener('abort',cancel);
            if('error' in result)reject(result.error);else resolve(result.preview);
          };
          const cancel=()=>finish({error:signal.reason});
          signal.addEventListener('abort',cancel,{once:true});
          try{texture.snapshotArea(0,0,width,height,image=>{
            if(settled)return;
            if(image instanceof HTMLImageElement)void image.decode().then(()=>finish({preview:image.src}),error=>finish({error}));
            else finish({error:new Error('人物预览生成失败')});
          });}catch(error){finish({error});}
        });
        // 佣兵加入时才首次合成整套外观；把每个动作分开到下一帧，
        // 避免一次性 stamp/render 所有动作形成长任务、卡住画面。
        await new Promise<void>(resolve=>setTimeout(resolve,0));
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      const outfit={actor:{...base,clips:{...base.clips,...clips}},preview,textures,users:0,
        redraw:()=>{for(const paint of paints)paint();}};
      this.cache.set(signature,outfit);
      // 只回收无人引用的外观：换装后旧外观可能仍被队友或演出角色使用。
      while(this.cache.size>3){
        const oldest=[...this.cache].find(([,value])=>value!==this.current&&value!==outfit&&value.users===0);
        if(!oldest)break;
        this.dispose(oldest[1]);this.cache.delete(oldest[0]);
      }
      return outfit;
    } catch(error){this.dispose({actor:base,preview:'',textures,users:0,redraw:()=>{}});throw error;}
  }
}
