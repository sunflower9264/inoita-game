import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { validateContent } from './validate-content.mjs';
import { BUILD_META_FILENAME, computeVersions, hashTree } from './build-version.ts';
import { buildContent } from './content-build.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv.length>2)throw new Error('构建命令无需参数');
const publicDir=path.join(root,'public');
validateContent(publicDir);
// 源 content 的原始哈希：构建期间若被改动，产物与源会不一致，直接失败。
const sourceContentVersion=hashTree(path.join(publicDir,'content'));
const staging=await fs.mkdtemp(path.join(root,'.build-'));
const contentDir=path.join(staging,'content');
const contentStats=await buildContent(path.join(publicDir,'content'),contentDir);
const versions={
 assetVersion:hashTree(path.join(publicDir,'assets')),
 contentVersion:hashTree(contentDir)
};
process.env.STORY_ASSET_VERSION=versions.assetVersion;
process.env.STORY_CONTENT_VERSION=versions.contentVersion;
const dist=path.join(root,'dist'),previous=path.join(staging,'previous'),output=path.join(staging,'output');
let moved=false;
try{
 await build({root,configFile:path.join(root,'vite.config.ts'),build:{outDir:output}});
 if(hashTree(path.join(publicDir,'content'))!==sourceContentVersion)
  throw new Error('构建期间 public/content 发生变化，请重新构建');
 // Vite 会先把 public 原样复制到 output；用构建期编译/压缩后的内容替换。
 await fs.rm(path.join(output,'content'),{recursive:true,force:true});
 await fs.cp(contentDir,path.join(output,'content'),{recursive:true});
 const outputVersions=computeVersions(output);
 if(outputVersions.assetVersion!==versions.assetVersion||outputVersions.contentVersion!==versions.contentVersion)
  throw new Error('构建后的 assets/content 与构建期版本不一致，请重新构建');
 await fs.writeFile(path.join(output,BUILD_META_FILENAME),JSON.stringify({
   schema:1,builtAt:new Date().toISOString(),...versions,
 })+'\n');
 validateContent(output);
 try{await fs.rename(dist,previous);moved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 try{await fs.rename(output,dist);}catch(error){if(moved)await fs.rename(previous,dist);throw error;}
 console.log(`Standalone build: story-game/dist/ (assets ${versions.assetVersion}, content ${versions.contentVersion}; content ${contentStats.files} files, ${contentStats.sourceBytes} -> ${contentStats.outputBytes} bytes)`);
}finally{await fs.rm(staging,{recursive:true,force:true});}
