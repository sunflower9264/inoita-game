import assert from 'node:assert/strict';
import test from 'node:test';
import { backupLocalSaves, restoreCloudSaves } from '../src/application/cloud-save-sync.ts';
import type { CloudSaveEntry, CloudSaveError, CloudSavePort } from '../src/application/cloud-save.ts';
import { SAVE_FORMAT, SaveSlots, type SaveSlotRef, type SaveStorage } from '../src/domain/save-game.ts';

function storage(initial:Record<string,string>={}):SaveStorage & { entries:Map<string,string> } {
  const entries=new Map(Object.entries(initial));
  return {entries,getItem:key=>entries.get(key)??null,setItem:(key,value)=>{entries.set(key,value);},removeItem:key=>{entries.delete(key);}};
}

function save(format=SAVE_FORMAT,name='chapter'):string {
  return JSON.stringify({
    format,
    summary:{classId:'dark-knight',className:'黑暗骑士',portrait:'p.png',level:1,mapId:'camp',mapName:'营地',name},
    session:{money:1},
    world:{location:{map:'camp'}},
  });
}

function entry(slot:SaveSlotRef,format=SAVE_FORMAT):CloudSaveEntry {
  return {
    slot,format,bytes:100,updatedAt:1,
    summary:{classId:'dark-knight',className:'黑暗骑士',portrait:'p.png',level:1,mapId:'camp',mapName:'营地'},
  };
}

interface CloudHarness {
  port:CloudSavePort;
  uploads:{slot:SaveSlotRef;game:unknown}[];
  downloads:SaveSlotRef[];
  setEntries(entries:CloudSaveEntry[]):void;
}

function cloudStub(options:{
  entries?:CloudSaveEntry[];
  uploadError?:(slot:SaveSlotRef)=>CloudSaveError|undefined;
  download?:(slot:SaveSlotRef)=>unknown;
}={}):CloudHarness {
  const uploads:{slot:SaveSlotRef;game:unknown}[]=[];
  const downloads:SaveSlotRef[]=[];
  let entries=options.entries??[];
  const port:CloudSavePort={
    get loggedIn(){return true;},
    get account(){return 'Player_1';},
    login:async()=>({ok:false,error:{code:'server',message:'unused'}}),
    register:async()=>({ok:false,error:{code:'server',message:'unused'}}),
    changePassword:async()=>({ok:false,error:{code:'server',message:'unused'}}),
    refresh:async()=>({ok:false,error:{code:'server',message:'unused'}}),
    logout:async()=>({ok:true,value:undefined}),
    list:async()=>({ok:true,value:entries}),
    upload:async(slot,game)=>{
      uploads.push({slot,game});
      const error=options.uploadError?.(slot);
      return error?{ok:false,error}:{ok:true,value:entry(slot)};
    },
    download:async(slot)=>{
      downloads.push(slot);
      return {ok:true,value:options.download?.(slot)??JSON.parse(save())};
    },
    forget(){},
  };
  return {port,uploads,downloads,setEntries(next){entries=next;}};
}

test('backup uploads valid slots, skips obsolete ones, and reports future and damaged local slots',async()=>{
  const s=storage({
    'inotia4.story.v1.slot0':save(),
    'inotia4.story.v1.slot1':save(SAVE_FORMAT+1),
    'inotia4.story.v1.slot2':'{broken',
    'inotia4.story.v1.slot3':save(SAVE_FORMAT-1),
  });
  const slots=new SaveSlots(s),cloud=cloudStub();
  const result=await backupLocalSaves({cloud:cloud.port,saves:slots,confirm:async()=>true});
  assert.equal(result.total,3);
  assert.equal(result.completed,1);
  assert.deepEqual(cloud.uploads.map(item=>item.slot),[0]);
  assert.deepEqual(result.failures.map(item=>item.slot).sort(),[1,2]);
  assert.equal(result.ok,false);
});

test('backup asks before overwriting a cloud slot and does nothing when cancelled',async()=>{
  const s=storage({'inotia4.story.v1.slot0':save()});
  const slots=new SaveSlots(s),cloud=cloudStub({entries:[entry(0)]});
  let asked=0;
  const result=await backupLocalSaves({cloud:cloud.port,saves:slots,confirm:async()=>{asked+=1;return false;}});
  assert.equal(asked,1);
  assert.equal(result.cancelled,true);
  assert.equal(cloud.uploads.length,0);
});

test('backup stops on a network error but keeps the already uploaded slots',async()=>{
  const s=storage({'inotia4.story.v1.slot0':save(),'inotia4.story.v1.slot1':save()});
  const slots=new SaveSlots(s);
  const cloud=cloudStub({uploadError:slot=>slot===1?{code:'network',message:'offline'}:undefined});
  const result=await backupLocalSaves({cloud:cloud.port,saves:slots,confirm:async()=>true});
  assert.equal(result.completed,1);
  assert.deepEqual(result.failures.map(item=>item.slot),[1]);
  assert.equal(result.ok,false);
});

test('restore skips incompatible cloud formats and writes the valid slots',async()=>{
  const s=storage(),slots=new SaveSlots(s);
  const cloud=cloudStub({entries:[entry(0),entry(1,SAVE_FORMAT+1)]});
  const result=await restoreCloudSaves({cloud:cloud.port,saves:slots,confirm:async()=>true,validate:async()=>{}});
  assert.equal(result.total,2);
  assert.equal(result.completed,1);
  assert.deepEqual(result.failures.map(item=>item.slot),[1]);
  assert.equal(slots.readRaw(0).kind,'ok');
  assert.equal(slots.readRaw(1).kind,'empty');
  assert.deepEqual(cloud.downloads,[0],'未来版本不下载');
});

test('restore asks before overwriting local slots and does nothing when cancelled',async()=>{
  const s=storage({'inotia4.story.v1.slot0':save()});
  const slots=new SaveSlots(s),cloud=cloudStub({entries:[entry(0)]});
  let asked=0;
  const result=await restoreCloudSaves({cloud:cloud.port,saves:slots,confirm:async()=>{asked+=1;return false;},validate:async()=>{}});
  assert.equal(asked,1);
  assert.equal(result.cancelled,true);
  assert.equal(cloud.downloads.length,0);
});

test('restore stops when the local storage is full and reports the failure',async()=>{
  const quota={name:'QuotaExceededError'};
  const full:SaveStorage={
    getItem:()=>null,
    setItem:()=>{const error=new Error('full') as Error & {name:string};error.name=quota.name;throw error;},
    removeItem:()=>{},
  };
  const slots=new SaveSlots(full);
  const cloud=cloudStub({entries:[entry(0),entry(1)]});
  const result=await restoreCloudSaves({cloud:cloud.port,saves:slots,confirm:async()=>true,validate:async()=>{}});
  assert.equal(result.completed,0);
  assert.deepEqual(result.failures.map(item=>item.slot),[0]);
  assert.deepEqual(cloud.downloads,[0],'配额失败后不再继续下载');
});

test('a rejected candidate keeps the original slot and a later valid download is restored',async()=>{
  const original=save(SAVE_FORMAT,'original');
  const memory=storage({'inotia4.story.v1.slot0':original}),slots=new SaveSlots<{location:{map:string}}>(memory);
  const cloud=cloudStub({entries:[entry(0),entry(1)],download:slot=>{
    const game=JSON.parse(save());if(slot===0)game.world.location.map='retired-map';return game;
  }});
  const result=await restoreCloudSaves({cloud:cloud.port,saves:slots,confirm:async()=>true,
    validate:async game=>{if(game.world.location.map!=='camp')throw new Error('存档记录的地图或位置无效');}});
  assert.equal(memory.entries.get('inotia4.story.v1.slot0'),original);
  assert.deepEqual(result.failures,[{slot:0,reason:'存档记录的地图或位置无效'}]);
  assert.equal(result.completed,1);
  assert.equal(slots.peek(1).kind,'ok');
});

test('leaving during candidate validation prevents the downloaded slot from being written',async()=>{
  const slots=new SaveSlots(storage()),controller=new AbortController();
  const cloud=cloudStub({entries:[entry(0)]});
  const result=await restoreCloudSaves({cloud:cloud.port,saves:slots,signal:controller.signal,
    confirm:async()=>true,validate:async()=>{controller.abort();}});
  assert.equal(result.aborted,true);
  assert.equal(result.completed,0);
  assert.equal(slots.peek(0).kind,'empty');
});

test('an aborted signal stops the batch before the first write',async()=>{
  const s=storage({'inotia4.story.v1.slot0':save()});
  const slots=new SaveSlots(s),cloud=cloudStub();
  const controller=new AbortController();controller.abort();
  const result=await backupLocalSaves({cloud:cloud.port,saves:slots,confirm:async()=>true,signal:controller.signal});
  assert.equal(result.aborted,true);
  assert.equal(cloud.uploads.length,0);
});
