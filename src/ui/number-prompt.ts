import { skinPrompt, placePrompt } from './dom/prompt-shell.ts';
interface NumberPromptOptions {
  title:string;
  /** 常驻说明，例如「最多可买 3 件」。 */
  hint?:string;
  initial:number;
  minimum:number;
  maximum:number;
  /** 超过上限时的提示；默认「最多 N」。 */
  overMessage?(maximum:number):string;
  /** 当前菜单画布的屏幕倍率；确认/取消据此和同屏菜单按钮同尺寸。 */
  scale?:()=>number;
  onConfirm(value:number):void;
  onCancel():void;
}

/**
 * 数字输入卡：商店数量、能力点加点共用。
 *
 * 输入框只接受数字；超范围时把输入框和提示行标红并禁用「确定」，
 * 非法值不会写回游戏状态。关闭、取消和页面切走都只关闭卡片，不改数据。
 */
export class NumberPrompt {
  private root?:HTMLDivElement;
  private form?:HTMLFormElement;
  private input?:HTMLInputElement;
  private options?:NumberPromptOptions;
  private readonly cancelOnHide=()=>{ if(this.options)this.cancel(); };
  private releaseSkin?:()=>void;
  private readonly place=()=>placePrompt(this.form);

  /** Escape/Enter 挂在 document 上：焦点移到按钮或卡片外时也能退出和提交。 */
  private readonly keydown=(event:KeyboardEvent)=>{
    if(!this.root)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.cancel();return;}
    if(event.key!=='Enter')return;
    event.preventDefault();event.stopPropagation();
    if(this.problem(this.value())){
      this.input?.focus();
      return;
    }
    this.confirm();
  };

  get active():boolean { return !!this.root; }

  show(options:NumberPromptOptions):void {
    this.close();
    if(typeof document==='undefined')return;
    this.options=options;
    const root=document.createElement('div');
    root.className='text-prompt number-prompt';
    const form=document.createElement('form');
    form.autocomplete='off';
    const title=document.createElement('p');
    title.textContent=options.title;
    const hint=document.createElement('p');
    hint.className='text-prompt-hint';
    hint.textContent=options.hint??'';
    const input=document.createElement('input');
    input.type='text';
    input.inputMode='numeric';
    input.enterKeyHint='done';
    input.maxLength=Math.max(3,String(options.maximum).length+1);
    input.setAttribute('autocomplete','off');
    input.setAttribute('autocapitalize','off');
    input.setAttribute('spellcheck','false');
    input.value=String(options.initial);
    const error=document.createElement('p');
    error.className='text-prompt-error';
    error.hidden=true;
    const actions=document.createElement('div');
    actions.className='text-prompt-actions';
    const confirm=document.createElement('button');
    confirm.type='submit';
    confirm.textContent='确定';
    const cancel=document.createElement('button');
    cancel.type='button';
    cancel.textContent='取消';
    actions.append(confirm,cancel);
    form.append(title);
    if(options.hint)form.append(hint);
    form.append(input,error,actions);
    this.releaseSkin=skinPrompt(form,title,actions,options.scale);
    root.append(form);
    document.body.append(root);
    this.root=root;this.form=form;this.input=input;

    const validate=()=>{
      const value=this.value();
      const problem=this.problem(value);
      error.hidden=!problem;
      error.textContent=problem??'';
      input.classList.toggle('number-prompt-invalid',!!problem);
      confirm.disabled=!!problem;
      return problem;
    };
    input.addEventListener('input',()=>{
      const digits=input.value.replace(/\D/g,'');
      if(digits!==input.value){
        const cursor=input.selectionStart??digits.length;
        input.value=digits;
        try{input.setSelectionRange(Math.min(cursor,digits.length),Math.min(cursor,digits.length));}catch{}
      }
      validate();
    });
    form.addEventListener('submit',event=>{event.preventDefault();if(!validate())this.confirm();});
    cancel.addEventListener('click',()=>this.cancel());
    if(typeof document!=='undefined'&&typeof document.addEventListener==='function')document.addEventListener('keydown',this.keydown,true);
    if(typeof window!=='undefined'&&typeof window.addEventListener==='function'){
      window.addEventListener('pagehide',this.cancelOnHide,{once:true});
      window.addEventListener('resize',this.place);
      window.visualViewport?.addEventListener('resize',this.place);
      window.visualViewport?.addEventListener('scroll',this.place);
    }
    this.place();
    validate();
    input.focus();
    input.select();
  }

  /** 摘掉输入框，不回调；菜单关闭或页面切走时用。 */
  close():void {
    if(typeof document!=='undefined'&&typeof document.removeEventListener==='function')document.removeEventListener('keydown',this.keydown,true);
    if(typeof window!=='undefined'&&typeof window.removeEventListener==='function'){
      window.removeEventListener('pagehide',this.cancelOnHide);
      window.removeEventListener('resize',this.place);
      window.visualViewport?.removeEventListener('resize',this.place);
      window.visualViewport?.removeEventListener('scroll',this.place);
    }
    const input=this.input;
    if(input){try{input.blur();}catch{}}
    this.releaseSkin?.();this.releaseSkin=undefined;
    this.root?.remove();
    this.root=undefined;this.form=undefined;this.input=undefined;this.options=undefined;
  }

  private value():number {
    const text=this.input?.value.trim() ?? '';
    return text===''?Number.NaN:Number(text);
  }

  private problem(value:number):string|undefined {
    const options=this.options;
    if(!options)return '输入已关闭';
    if(!Number.isFinite(value))return '请输入数字';
    if(!Number.isSafeInteger(value))return '请输入整数';
    if(value<options.minimum)return `最少 ${options.minimum}`;
    if(value>options.maximum)return options.overMessage?.(options.maximum)??`最多 ${options.maximum}`;
    return undefined;
  }

  private confirm():void {
    const options=this.options;
    if(!options||this.problem(this.value()))return;
    const value=this.value();
    this.options=undefined;
    this.close();
    options.onConfirm(value);
  }

  private cancel():void {
    const options=this.options;
    this.options=undefined;
    this.close();
    options?.onCancel();
  }
}
