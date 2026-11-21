import {AUTO_SAVE_SLOT,type SaveSlotRef,type SaveSlots} from '../domain/save-game.ts';
import {TextPrompt} from './text-prompt.ts';

interface RenameHost {
  saves:Pick<SaveSlots,'peek'|'rename'>;
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
    scale:()=>number;current:()=>boolean;opened:()=>void;finished:(slot:number,submitted:boolean)=>void;
  }):void {
    if(slot===AUTO_SAVE_SLOT)return;
    const reading=host.saves.peek(slot);
    if(reading.kind!=='ok')return;
    this.cancel();
    const request={slot},initial=reading.summary.name??'';
    this.request=request;
    const finish=(value?:string)=>{
      if(this.request!==request)return;
      this.request=undefined;
      if(!view.current())return;
      if(value!==undefined){
        try{host.saves.rename(slot,value);}catch(error){console.warn('存档改名失败',error);}
      }
      view.finished(slot,value!==undefined);
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
