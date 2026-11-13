import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const require=createRequire(import.meta.url);
execFileSync(process.execPath,['tools/patch-phaser.mjs']);
const bundle=readFileSync('node_modules/phaser/dist/phaser.esm.js','utf8');
const start=bundle.indexOf('var WebGLFramebufferWrapper = new Class({');
const end=bundle.indexOf('module.exports = WebGLFramebufferWrapper;',start);
assert.ok(start>=0&&end>start);
const Wrapper=runInNewContext(bundle.slice(start,end)+';WebGLFramebufferWrapper',{
  Class:require('../node_modules/phaser/src/utils/Class.js'),errors:{36061:'Framebuffer Unsupported'},
});

function fixture(status:number){
  const framebuffer={},renderbuffer={},texture={width:8,height:8,webGLTexture:{}};
  const textures=new Set([texture]),deleted:unknown[]=[],bindings:{framebuffer?:unknown;renderbuffer?:unknown}={};
  const renderer={gl:{FRAMEBUFFER_COMPLETE:36053,
    createFramebuffer:()=>framebuffer,deleteFramebuffer:(value:unknown)=>deleted.push(value),
    createRenderbuffer:()=>renderbuffer,deleteRenderbuffer:()=>{},
    framebufferTexture2D:()=>{},framebufferRenderbuffer:()=>{},renderbufferStorage:()=>{},checkFramebufferStatus:()=>status,
  },glWrapper:{updateBindingsFramebuffer:(state:{bindings:object})=>Object.assign(bindings,state.bindings),updateBindingsRenderbuffer:()=>{}},
  deleteTexture:(value:typeof texture)=>textures.delete(value)};
  return {renderer,texture,textures,deleted,bindings,framebuffer};
}

test('runtime framebuffer constructor frees its color texture and binding on failure',()=>{
  const f=fixture(36061);
  for(let i=0;i<3;i++){
    f.textures.add(f.texture);
    assert.throws(()=>new Wrapper(f.renderer,[f.texture],true,false),/Framebuffer Unsupported/);
    assert.equal(f.textures.size,0);assert.equal(f.bindings.framebuffer,null);
  }
  assert.equal(f.deleted.length,3);
});

test('successful runtime framebuffer remains alive until normal disposal',()=>{
  const f=fixture(36053),wrapper=new Wrapper(f.renderer,[f.texture],true,false);
  assert.equal(f.textures.size,1);assert.equal(f.deleted.length,0);
  wrapper.destroy();assert.equal(f.textures.size,0);assert.deepEqual(f.deleted,[f.framebuffer]);
});

test('runtime patches are idempotent',()=>{
  execFileSync(process.execPath,['tools/patch-phaser.mjs']);
  assert.equal(readFileSync('node_modules/phaser/dist/phaser.esm.js','utf8'),bundle);
});
