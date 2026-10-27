import assert from 'node:assert/strict';
import test from 'node:test';

const KEY='inotia4.display.v1';
const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
let serial=0;

function restoreStorage():void {
  if(original)Object.defineProperty(globalThis,'localStorage',original);
  else Reflect.deleteProperty(globalThis,'localStorage');
}
function installStorage(initial:Record<string,string>={},failWrite=false):Map<string,string> {
  const entries=new Map(Object.entries(initial));
  const storage={
    getItem:(key:string)=>entries.get(key)??null,
    setItem:(key:string,value:string)=>{if(failWrite)throw new Error('storage disabled');entries.set(key,value);},
    removeItem:(key:string)=>{entries.delete(key);},
  };
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:storage});
  return entries;
}
async function freshSettings(){
  const url=new URL('../src/application/display-settings.ts',import.meta.url);
  url.searchParams.set('case',String(++serial));
  return (await import(url.href)) as typeof import('../src/application/display-settings.ts');
}

test('display settings default both switches on and upgrade an old fps-only record',async t=>{
  t.after(restoreStorage);
  installStorage();
  let settings=(await freshSettings()).displaySettings;
  assert.equal(settings.fps,true);
  assert.equal(settings.criticalDecorations,true);

  installStorage({[KEY]:JSON.stringify({fps:false})});
  settings=(await freshSettings()).displaySettings;
  assert.equal(settings.fps,false);
  assert.equal(settings.criticalDecorations,true,'旧记录没有新字段时默认开启');
});

test('critical decorations persist without dropping the fps preference',async t=>{
  t.after(restoreStorage);
  const entries=installStorage();
  const {displaySettings}=await freshSettings();
  displaySettings.setCriticalDecorations(false);
  assert.equal(displaySettings.criticalDecorations,false);
  assert.deepEqual(JSON.parse(entries.get(KEY)!),{fps:true,criticalDecorations:false});
  displaySettings.setFps(false);
  assert.deepEqual(JSON.parse(entries.get(KEY)!),{fps:false,criticalDecorations:false});
});

test('broken storage falls back to defaults and write failures keep the in-memory switch',async t=>{
  t.after(restoreStorage);
  installStorage({[KEY]:'{not json'});
  let settings=(await freshSettings()).displaySettings;
  assert.equal(settings.fps,true);
  assert.equal(settings.criticalDecorations,true);

  installStorage({},true);
  settings=(await freshSettings()).displaySettings;
  assert.doesNotThrow(()=>settings.setCriticalDecorations(false));
  assert.equal(settings.criticalDecorations,false,'写盘失败时本次会话仍生效');
});
