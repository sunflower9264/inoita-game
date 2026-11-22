import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { validateContent } from './validate-content.mjs';
import { BUILD_META_FILENAME, computeVersions, hashTree } from './build-version.ts';
import { buildContent } from './content-build.ts';
import { writeContentManifest } from './content-manifest.ts';
import { writeUpdateArtifacts } from './update-manifest.ts';
import { pruneAssets } from './prune-assets.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const noPrune=args.includes('--no-prune');
const unknown=args.filter(arg=>arg!=='--no-prune');
if(unknown.length)throw new Error(`未知构建参数：${unknown.join(' ')}`);
const publicDir=path.join(root,'public');
validateContent(publicDir);
// 图集由 `npm run build` 的 prebuild 在独立进程里重新生成；这里不再写图集，
// 否则本进程启动时静态导入的 generated 映射会停留在生成前的旧值。
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
 // 内容哨兵放在 content/ 外，contentVersion 仍只由 hashTree(content) 决定。
 await writeContentManifest(output,contentDir,versions.contentVersion);
 const outputVersions=computeVersions(output);
 if(outputVersions.assetVersion!==versions.assetVersion||outputVersions.contentVersion!==versions.contentVersion)
  throw new Error('构建后的 assets/content 与构建期版本不一致，请重新构建');
 const builtAt=new Date().toISOString();
 await fs.writeFile(path.join(output,BUILD_META_FILENAME),JSON.stringify({
   schema:1,builtAt,...versions,
 })+'\n');
 validateContent(output);
 // 版本号按源素材算；裁剪只移动未引用的文件，保留文件内容不变，所以不需要重算。
 const assetKeep=await pruneAssets({
   contentDir:path.join(output,'content'),
   assetsDir:path.join(output,'assets'),
   archiveDir:path.join(root,'asset-archive'),
   keepAll:noPrune,
 });
 const update=await writeUpdateArtifacts(output,{builtAt,assetVersion:versions.assetVersion,contentVersion:versions.contentVersion});
 try{await fs.rename(dist,previous);moved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 try{await fs.rename(output,dist);}catch(error){if(moved)await fs.rename(previous,dist);throw error;}
 console.log(`Standalone build: story-game/dist/ (assets ${versions.assetVersion}, content ${versions.contentVersion}; content ${contentStats.files} files, ${contentStats.sourceBytes} -> ${contentStats.outputBytes} bytes; clip keys ${contentStats.clipKeysBefore} -> ${contentStats.clipKeysAfter}, ${contentStats.dedupedLayers} layers deduped)`);
 console.log(`Assets: keep ${assetKeep.keptFiles} files / ${(assetKeep.keptBytes/1048576).toFixed(1)} MB${noPrune?'（--no-prune，未归档）':`，archive ${assetKeep.archivedFiles} files / ${(assetKeep.archivedBytes/1048576).toFixed(1)} MB`}`);
 if(!noPrune)for(const [reason,bucket] of Object.entries(assetKeep.reasons).sort((a,b)=>b[1].bytes-a[1].bytes))
   console.log(`  ${reason}: ${bucket.files} files / ${(bucket.bytes/1048576).toFixed(1)} MB`);
 console.log(`Update: update/${update.buildId}.json, ${update.fileCount} files${update.signed?'，已签名':'，未签名（缺少私钥）'}`);
}finally{await fs.rm(staging,{recursive:true,force:true});}
