import {AUTO_SAVE_SLOT,type SaveSlotRef,type SaveSlots} from '../domain/save-game.ts';
import {TextPrompt} from './text-prompt.ts';

interface RenameHost {
  saves:Pick<SaveSlots,'peek'|'rename'> & Partial<Pick<SaveSlots,'flush'>>;
  promptText?:(initial:string)=>Promise<string|undefined>;
}

/** 标题页和游戏内各持有一个改名请求，关页后原请求的结果即失效。 */
export class SaveSlotRename {
  private request?:{slot:number};
  private readonly prompt=new TextPrompt();
  get active():boolean { return !!this.request; }

  cancel():void {
    this.request=undefined;
    this.prompt.close();
  }

  start(slot:SaveSlotRef,host:RenameHost,view:{
    scale:()=>number;current:()=>boolean;opened:()=>void;finished:(slot:number,submitted:boolean,failed?:boolean)=>void;
  }):void {
    if(slot===AUTO_SAVE_SLOT)return;
    const reading=host.saves.peek(slot);
    if(reading.kind!=='ok')return;
    this.cancel();
    const request={slot},initial=reading.summary.name??'';
    this.request=request;
    const finish=(value?:string)=>{
      if(this.request!==request)return;
      if(!view.current()){this.request=undefined;return;}
      let submitted=value!==undefined;
      let failed=false;
      if(value!==undefined){
        try{
          host.saves.rename(slot,value);
          const flushing=host.saves.flush?.(slot);
          if(flushing){
            void flushing.then(
              ()=>{
                if(this.request!==request)return;
                this.request=undefined;
                if(view.current())view.finished(slot,true,false);
              },
              error=>{
                console.warn('存档改名失败',error);
                if(this.request!==request)return;
                this.request=undefined;
                if(view.current())view.finished(slot,false,true);
              },
            );
            return;
          }
        }catch(error){console.warn('存档改名失败',error);submitted=false;failed=true;}
      }
      this.request=undefined;
      view.finished(slot,submitted,failed);
    };
    view.opened();
    if(this.request!==request)return;
    if(host.promptText){
      try{void host.promptText(initial).then(finish,()=>finish());}catch{finish();}
      return;
    }
    this.prompt.show({title:'存档名称',initial,scale:view.scale,onConfirm:finish,onCancel:()=>finish()});
    if(!this.prompt.active)finish();
  }
}
