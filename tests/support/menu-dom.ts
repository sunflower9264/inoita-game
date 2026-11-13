import { readFileSync } from 'node:fs';

/** Node 下的 DOM 边界：保留捕获、冒泡和 AbortSignal，不启动浏览器。 */
export class MenuElement {
  style = Object.assign({} as Record<string, any>, { setProperty(name: string, value: string) { (this as Record<string,any>)[name] = value; }, removeProperty(name: string) { delete (this as Record<string,any>)[name]; } });
  dataset: Record<string,string> = {};
  children: MenuElement[] = [];
  parentElement?: MenuElement;
  hidden = false; textContent = ''; className = ''; id = ''; src = ''; draggable = false; alt = '';
  classList = { add: (...names: string[]) => { this.className += ` ${names.join(' ')}`; } };
  private captures = new Set<number>();
  private listeners = new Map<string, { run: (event:any)=>void; capture:boolean; once:boolean }[]>();
  get firstChild() { return this.children[0] ?? null; }
  get isConnected():boolean { return (this as MenuElement)===domWindow || !!this.parentElement?.isConnected; }
  appendChild(child: MenuElement) { child.remove(); this.children.push(child); child.parentElement=this; return child; }
  append(...children:MenuElement[]) { children.forEach(child=>this.appendChild(child)); }
  insertBefore(child:MenuElement,before:MenuElement|null) { if(child===before)return child;child.remove();const index=before?this.children.indexOf(before):-1;this.children.splice(index<0?this.children.length:index,0,child);child.parentElement=this;return child; }
  remove() { if(this.parentElement){const siblings=this.parentElement.children; siblings.splice(siblings.indexOf(this),1);this.parentElement=undefined;} }
  getContext() { return {font:'22px',measureText(text:string){return {width:text.length*Number.parseFloat(this.font)*.55};}}; }
  setAttribute(name:string,value:string) { (this as any)[name]=value; }
  setPointerCapture(id:number) { this.captures.add(id); }
  hasPointerCapture(id:number) { return this.captures.has(id); }
  releasePointerCapture(id:number) { this.captures.delete(id); }
  getBoundingClientRect() { return {x:0,y:0,left:0,top:0,width:1024,height:640,right:1024,bottom:640}; }
  addEventListener(name:string,run:(event:any)=>void,options:any={}) { if(options.signal?.aborted)return;const row={run,capture:options===true||!!options.capture,once:!!options.once};const rows=this.listeners.get(name)??[];rows.push(row);this.listeners.set(name,rows);options.signal?.addEventListener('abort',()=>this.removeEventListener(name,run,options),{once:true}); }
  removeEventListener(name:string,run:(event:any)=>void,options:any={}) { this.listeners.set(name,(this.listeners.get(name)??[]).filter(row=>row.run!==run||row.capture!==(options===true||!!options.capture))); }
  dispatchEvent(event:any) {
    let stopped=false;const stop=event.stopPropagation.bind(event);event.stopPropagation=()=>{stopped=true;stop();};
    Object.defineProperty(event,'target',{value:this,configurable:true});
    const path:MenuElement[]=[];for(let node:MenuElement|undefined=this;node;node=node.parentElement)path.push(node);
    const visit=(node:MenuElement,capture:boolean)=>{for(const row of [...node.listeners.get(event.type)??[]])if(row.capture===capture){if(row.once)node.removeEventListener(event.type,row.run,{capture});row.run(event);}};
    for(const node of [...path].reverse()){visit(node,true);if(stopped)return !event.defaultPrevented;}
    visit(this,false);if(!stopped&&event.bubbles)for(const node of path.slice(1)){visit(node,false);if(stopped)break;}
    return !event.defaultPrevented;
  }
}
export const domWindow = Object.assign(new MenuElement(), {devicePixelRatio:1});
/** 画框的屏幕矩形；与测试场景的画布像素宽高分别设置。 */
export const menuFrame = {left:0,top:0,width:1024,height:640};
const documentRoot=new MenuElement();domWindow.appendChild(documentRoot);
const layers=new Map<string,MenuElement>();
for(const id of ['game-frame','safe-area','ui-screen','ui-overlay','ui-hud','ui-world']){const node=new MenuElement();node.id=id;documentRoot.appendChild(node);layers.set(id,node);}
layers.get('game-frame')!.getBoundingClientRect=()=>({...menuFrame,x:menuFrame.left,y:menuFrame.top,right:menuFrame.left+menuFrame.width,bottom:menuFrame.top+menuFrame.height});
export function installMenuDom() {
  Object.assign(menuFrame,{left:0,top:0,width:1024,height:640});
  const names=['window','document','getComputedStyle','Image','fetch'];
  const previous=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));
  Object.defineProperties(globalThis,{
    window:{configurable:true,value:domWindow},
    document:{configurable:true,value:{documentElement:documentRoot,createElement:()=>new MenuElement(),createElementNS:()=>new MenuElement(),getElementById:(id:string)=>layers.get(id),addEventListener:documentRoot.addEventListener.bind(documentRoot),removeEventListener:documentRoot.removeEventListener.bind(documentRoot)}},
    getComputedStyle:{configurable:true,value:()=>({paddingLeft:'0',paddingRight:'0',paddingTop:'0',paddingBottom:'0'})},
    Image:{configurable:true,value:class {onload?:()=>void;onerror?:()=>void;naturalWidth=0;naturalHeight=0;removeAttribute(){};set src(url:string){if(!url)return;const bytes=readFileSync(new URL(`../../public/${url.split('?')[0].replace(/^\//,'')}`,import.meta.url));this.naturalWidth=bytes.readUInt32BE(16);this.naturalHeight=bytes.readUInt32BE(20);queueMicrotask(()=>this.onload?.());}}},
    fetch:{configurable:true,value:async(url:string)=>({ok:true,json:async()=>JSON.parse(readFileSync(new URL(`../../public/${url.split('?')[0].replace(/^\//,'')}`,import.meta.url),'utf8'))})}
  });
  return ()=>names.forEach((name,index)=>{const value=previous[index];if(value)Object.defineProperty(globalThis,name,value);else Reflect.deleteProperty(globalThis,name);});
}
export function domEvent(target:HTMLElement|MenuElement,name:string,pointer:{id:number;x:number;y:number;isDown:boolean},deltaY=0) {
  const event=new Event(name,{bubbles:true,cancelable:true});
  Object.assign(event,{pointerId:pointer.id,clientX:pointer.x,clientY:pointer.y,buttons:pointer.isDown?1:0,button:0,deltaY});
  (target as unknown as MenuElement).dispatchEvent(event);return event;
}
