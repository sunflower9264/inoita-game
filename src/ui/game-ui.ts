import type { ChoiceOption, DialogueLine, QuestRewardReceipt } from '../domain/content.ts';
import type { CampaignQuest } from '../domain/campaign.ts';
import { ControlState } from '../application/control-state.ts';
import type { GameMode } from '../application/control-state.ts';
import { InstantMessage } from './instant-message.ts';
import { typedIndex, typedLength, typedOffset } from '../domain/text-markup.ts';
import type { DialoguePage } from './dialogue-text.ts';

/** 提示条停留时长，以及打字机每次推进的间隔和字数。 */
const TOAST_DURATION_MS=2600;
const TYPE_INTERVAL_MS=24;
const TYPE_CHARS_PER_INTERVAL=2;

interface DialogueState { text:string; start:number; readTo:number; skipped:boolean }
type DefeatAction = 'prayer' | 'checkpoint';
interface DefeatActions {
  prayerCount:()=>number;
  revive:()=>boolean|Promise<boolean>;
  restore:()=>void|Promise<void>;
}
interface DefeatState { prayerCount:number; confirmation?:DefeatAction; busy:boolean; error?:string }
export interface GameUiView {
  sync(ui:GameUI):void;
  resetInput?():void;
  renderText(ui:GameUI):void;
  paginate(ui:GameUI,text:string):DialoguePage[];
  portrait(file:string,signal?:AbortSignal):Promise<void>;
  preloadPortraits?(files:string[],signal:AbortSignal,progress:(value:number)=>void):Promise<void>;
}
/** 流程状态独立于显示层；由 Phaser 场景显示。 */
export class GameUI {
  controlLayoutEditing=false;
  setControlLayoutEditing(value:boolean):void {
    if(this.controlLayoutEditing===value)return;
    this.controlLayoutEditing=value;this.resetInput();this.updateControls();
  }
  /** 键位设置面板打开时，世界侧移动、技能与攻击全部让位。 */
  keyBindingEditing=false;
  setKeyBindingEditing(value:boolean):void {
    if(this.keyBindingEditing===value)return;
    this.keyBindingEditing=value;this.resetInput();this.updateControls();
  }
  readonly controls=new ControlState();
  get mode(){return this.controls.mode;} set mode(value:GameMode){this.controls.mode=value;}
  get failed(){return this.controls.failed;} set failed(value:boolean){this.controls.failed=value;}
  get locked(){return this.controls.locked;}
  get lockOwners(){return this.controls.lockOwners;}
  get defeatOpen(){return !!this.defeatFlow;}
  get suspended(){return this.controls.suspended;} set suspended(value:boolean){this.controls.suspended=value;}
  get ready(){return this.controls.ready;} set ready(value:boolean){this.controls.ready=value;}
  onMenu?:()=>void; onResetInput?:()=>void; onStateChange?:()=>void;
  onQuestPopup?:(kind:'start'|'complete')=>void; questItemName?:(id:string)=>string;
  view?:GameUiView;
  loadingState?:{label:string;progress:number;retry?:()=>void;actionLabel?:string};
  toastMessage=''; private toastRemaining=0;
  /** 剧情跨图静默重建期间的全屏黑幕；与会画进度条的 loadingState 分开。 */
  private rebuildCover=false;
  get worldRebuildCover():boolean{return this.rebuildCover;}
  setWorldRebuildCover(covered:boolean):void{
    if(this.rebuildCover===covered)return;
    this.rebuildCover=covered;
    if(covered)this.resetInput();
    globalThis.storyDiagnostics?.record('story-rebuild-cover',{covered});
    this.updateControls();
  }
  /** 原版 `INSTANTMSGSYSTEM_Add` 的屏幕提示（泉水效果文本走这条），与 toast 各自独立。 */
  readonly instant=new InstantMessage();
  showInstant(message:string):void{this.instant.show(message);}
  locationName='';
  dialogueLine?:DialogueLine;
  portraitFile?:string;
  choices?:{prompt:string;description:string;options:ChoiceOption[];choose:(option:ChoiceOption)=>void};
  quest?:{kind:'start'|'complete';definition:CampaignQuest;reward?:QuestRewardReceipt;confirm:()=>void};
  private cancelDialogue?:()=>void; private cancelQuestPopup?:()=>void;
  /** `pageEnd` 是当前页在原文里的结束位置；翻页按它推进游标，不能用 `page.length` 反推。 */
  pending:(()=>void)|null=null; page=''; revealed=0; pageEnd=0; dialogueState:DialogueState|null=null;
  drawPortrait?:(actor:string|null,portrait?:string|null,signal?:AbortSignal)=>void|Promise<void>;
  portraitToken?:symbol; playerActor='';
  private defeatFlow?:{actions:DefeatActions;confirmation?:DefeatAction;busy:boolean;error?:string};
  get defeated():boolean{return !!this.defeatFlow;}
  get defeatState():DefeatState|undefined {
    const flow=this.defeatFlow;
    return flow?{prayerCount:flow.actions.prayerCount(),confirmation:flow.confirmation,busy:flow.busy,error:flow.error}:undefined;
  }
  private elapsed=0;
  private pressed?:{id:number;pending:()=>void};
  resetInput():void{this.pressed=undefined;this.view?.resetInput?.();this.onResetInput?.();}
  get canReturn():boolean{return this.mode!=='menu'&&!this.locked&&!this.suspended&&(this.ready||this.failed);}
  setMode(mode:GameMode):void{
    this.controlLayoutEditing=false;this.keyBindingEditing=false;
    this.closeDefeat();this.mode=mode;this.ready=false;this.failed=false;this.resetInput();
    this.closeDialogue();this.cancelQuestPopup?.();this.toastMessage='';this.instant.clear();this.loadingState=undefined;this.rebuildCover=false;this.updateControls();
  }
  lock(value:boolean,owner='interaction'):void{this.controls.lock(owner,value);if(value)this.resetInput();this.updateControls();}
  suspend(value:boolean):void{this.suspended=value;if(value)this.resetInput();this.updateControls();}
  updateControls():void{this.view?.sync(this);this.onStateChange?.();}
  loading(label:string,progress=0):void{this.ready=false;this.failed=false;this.loadingState={label,progress};this.resetInput();this.updateControls();}
  loaded():void{this.ready=true;this.failed=false;this.loadingState=undefined;this.updateControls();}
  /** 进图预载剧情立绘；视图不存在时（单元测试）直接完成。 */
  async preloadPortraits(files:string[],signal:AbortSignal,progress:(value:number)=>void=()=>{}):Promise<void>{
    await this.view?.preloadPortraits?.(files,signal,progress);
  }
  menuLoaded():void{this.loaded();}
  error(message:string,retry:()=>void,actionLabel='重新加载'):void{
    globalThis.storyDiagnostics?.record('ui-error',{message});
    this.loading(message);this.failed=true;
    this.loadingState!.retry=()=>{if(!this.failed||this.suspended)return;this.loading('正在重新加载…');retry();};
    this.loadingState!.actionLabel=actionLabel;this.updateControls();
  }
  showDefeat(actions:DefeatActions):void {
    if(this.defeatFlow)return;
    this.defeatFlow={actions,busy:false};this.toastMessage='';this.loadingState=undefined;this.lock(true,'defeat');
  }
  selectDefeatAction(action:DefeatAction):void {
    const flow=this.defeatFlow;if(this.suspended||!flow||flow.busy)return;
    if(action==='prayer'&&flow.actions.prayerCount()<1)return;
    flow.confirmation=action;flow.error=undefined;this.resetInput();this.updateControls();
  }
  cancelDefeatConfirmation():void {
    const flow=this.defeatFlow;if(this.suspended||!flow||flow.busy)return;
    flow.confirmation=undefined;flow.error=undefined;this.resetInput();this.updateControls();
  }
  async confirmDefeat():Promise<void> {
    const flow=this.defeatFlow;if(this.suspended||!flow?.confirmation||flow.busy)return;
    const action=flow.confirmation;flow.busy=true;flow.error=undefined;this.resetInput();this.updateControls();
    try {
      if(action==='prayer') {
        if(flow.actions.prayerCount()<1||!await flow.actions.revive())throw new Error('当前无法使用复活圣文');
      } else await flow.actions.restore();
      if(this.defeatFlow===flow)this.closeDefeat();
    } catch(error) {
      if(this.defeatFlow!==flow)return;
      flow.busy=false;flow.confirmation=undefined;flow.error=error instanceof Error?error.message:'恢复失败，请重试';this.updateControls();
    }
  }
  closeDefeat():void {if(!this.defeatFlow)return;this.defeatFlow=undefined;this.lock(false,'defeat');}
  location(name:string):void{this.locationName=name;this.view?.sync(this);}
  toast(message:string):void{this.toastMessage=message;this.toastRemaining=TOAST_DURATION_MS;this.view?.sync(this);}
  tick(delta:number):void{
    if(this.suspended)return;
    this.instant.tick(delta);
    if(this.toastMessage){this.toastRemaining-=delta;if(this.toastRemaining<=0){this.toastMessage='';this.view?.sync(this);}}
    if(!this.pending){this.elapsed=0;return;}
    // 进度按**打出来的字**记：控制码零宽，显式换行是排版断行，都不该让打字机停一拍。
    const typed=typedIndex(this.page).text;
    if(this.revealed>=typed.length){this.elapsed=0;return;}
    this.elapsed+=delta;const count=Math.floor(this.elapsed/TYPE_INTERVAL_MS)*TYPE_CHARS_PER_INTERVAL;this.elapsed%=TYPE_INTERVAL_MS;
    if(count){let end=Math.min(typed.length,this.revealed+count);if(end<typed.length&&/[\uD800-\uDBFF]/.test(typed[end-1]))end++;this.revealed=end;this.renderText();}
  }
  pressDialogue(id:number):void{this.pressed=this.canSkip&&this.pending?{id,pending:this.pending}:undefined;}
  cancelPress(id:number):void{if(this.pressed?.id===id)this.pressed=undefined;}
  releaseDialogue(id:number):void{
    if(this.pressed?.id!==id)return;const pending=this.pressed.pending;this.pressed=undefined;
    queueMicrotask(()=>{if(this.pending===pending)this.advance();});
  }
  questPopup(kind:'start'|'complete',quest:CampaignQuest,reward?:QuestRewardReceipt,signal?:AbortSignal):Promise<void>{
    signal?.throwIfAborted();this.closeDialogue();this.cancelQuestPopup?.();this.onQuestPopup?.(kind);
    return new Promise((resolve,reject)=>{
      let settled=false;const clean=()=>{signal?.removeEventListener('abort',cancel);this.cancelQuestPopup=undefined;this.quest=undefined;this.view?.sync(this);};
      const cancel=()=>{if(settled)return;settled=true;clean();reject(new DOMException('任务提示已取消','AbortError'));};
      this.cancelQuestPopup=cancel;signal?.addEventListener('abort',cancel,{once:true});
      this.quest={kind,definition:quest,reward,confirm:()=>{if(settled||this.suspended)return;settled=true;clean();resolve();}};this.view?.sync(this);
    });
  }
  async portrait(file:string|null|undefined,_name='',signal?:AbortSignal):Promise<void>{
    signal?.throwIfAborted();const token=Symbol('portrait');this.portraitToken=token;this.portraitFile=undefined;
    if(!file){this.view?.sync(this);return;}
    try{await this.view?.portrait(file,signal);}catch{signal?.throwIfAborted();this.view?.sync(this);return;}signal?.throwIfAborted();
    if(this.portraitToken===token){this.portraitFile=file;this.view?.sync(this);}
  }
  paginate(text:string):DialoguePage[]{return this.view?.paginate(this,text)??[{text,end:text.length}];}
  renderText():void{this.view?.renderText(this);}
  reflowDialogue():void{const state=this.dialogueState;if(!state||!this.pending)return;state.readTo=Math.max(state.readTo,state.start+typedOffset(this.page,this.revealed));this.layoutDialoguePage();}
  layoutDialoguePage():void{
    const state=this.dialogueState!,page=this.paginate(state.text.slice(state.start))[0]!;
    // `pageEnd` 由分页给出：这一页吃掉的原文可能比 `page.length` 长（页尾那个被分页承担的换行）。
    this.page=page.text;this.pageEnd=state.start+page.end;
    // `start`/`readTo` 是原文下标；进度是打出来的字数，换算一次即可。
    this.revealed=Math.min(typedLength(this.page),Math.max(0,typedLength(state.text.slice(state.start,Math.max(state.start,state.readTo)))));
    this.view?.sync(this);this.renderText();
  }
  advance():void{if(this.suspended||!this.pending)return;const typed=typedLength(this.page);if(this.revealed<typed){this.revealed=typed;this.renderText();return;}const done=this.pending;this.pending=null;done();}
  get canSkip():boolean{return this.ready&&!this.suspended&&!!this.dialogueState&&!!this.pending;}
  skipDialogue():void{if(!this.canSkip)return;this.dialogueState!.skipped=true;const done=this.pending;this.pending=null;done?.();this.updateControls();}
  async dialogue(line:DialogueLine,signal?:AbortSignal):Promise<void>{
    signal?.throwIfAborted();this.cancelDialogue?.();await this.drawPortrait?.(line.actor??null,line.portrait,signal);signal?.throwIfAborted();
    this.dialogueLine=line;this.choices=undefined;
    const state=this.dialogueState={text:line.text,start:0,readTo:0,skipped:false};
    do{
      this.layoutDialoguePage();await new Promise<void>((resolve,reject)=>{
        const clean=()=>{signal?.removeEventListener('abort',cancel);this.cancelDialogue=undefined;};
        const cancel=()=>{clean();reject(new DOMException('对白已取消','AbortError'));};this.cancelDialogue=cancel;signal?.addEventListener('abort',cancel,{once:true});
        this.pending=()=>{clean();resolve();};this.updateControls();
      });signal?.throwIfAborted();if(this.dialogueState!==state)throw new DOMException('对白已取消','AbortError');
      state.start=this.pageEnd;state.readTo=Math.max(state.readTo,state.start);
    }while(!state.skipped&&state.start<line.text.length);
    this.dialogueState=null;this.updateControls();
  }
  choice(prompt:string,options:ChoiceOption[],description='',signal?:AbortSignal):Promise<ChoiceOption>{
    signal?.throwIfAborted();this.cancelDialogue?.();this.dialogueState=null;this.pending=null;this.page='';this.revealed=0;this.dialogueLine=undefined;this.portraitFile=undefined;
    return new Promise((resolve,reject)=>{
      let settled=false;const clean=()=>{signal?.removeEventListener('abort',cancel);this.cancelDialogue=undefined;this.choices=undefined;this.updateControls();};
      const cancel=()=>{if(settled)return;settled=true;clean();reject(new DOMException('选项已取消','AbortError'));};this.cancelDialogue=cancel;signal?.addEventListener('abort',cancel,{once:true});
      this.choices={prompt,options,description,choose:option=>{if(settled||this.suspended)return;settled=true;clean();resolve(option);}};this.updateControls();
    });
  }
  closeDialogue():void{this.cancelDialogue?.();this.portraitToken=Symbol('closed');this.portraitFile=undefined;this.dialogueLine=undefined;this.choices=undefined;this.dialogueState=null;this.pending=null;this.page='';this.updateControls();}
}
