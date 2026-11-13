#!/usr/bin/env node
/**
 * 静态验收离线 APK：签名、包信息、权限、清单属性、资产完整性与入口一致性。
 *
 * 用法：node tools/verify-apk.mjs [apk 路径]
 * 不传路径时取 apk-out/ 里最新的 APK。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, parsePointer, sha256Hex, verifyBytes, verifyManifestFiles } from './update-manifest.ts';
import { readUpdatePublicKey } from './update-key.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'apk-out');
const sdk = path.resolve(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), '.local/android-sdk'));
const buildTools = path.join(sdk, 'build-tools', '37.0.0');

const apk = process.argv[2]
  ? path.resolve(process.argv[2])
  : newestApk();

const problems = [];
/** zipalign 检查：普通条目 4 字节对齐，原生库按 16 KB 页对齐。 */
const ZIP_ALIGNMENT_BYTES = 4;
const PAGE_ALIGNMENT_KB = 16;
/** AndroidManifest 里 screenOrientation=sensorLandscape、windowSoftInputMode=adjustResize 的原始值。 */
const ANDROID_SENSOR_LANDSCAPE = 6;
const ANDROID_ADJUST_RESIZE = 0x10;
/** apksigner/aapt2/unzip 的输出上限。 */
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024 * 1024;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(name);
}

function newestApk() {
  if (!fs.existsSync(outDir)) return '';
  const files = fs.readdirSync(outDir).filter(name => name.endsWith('.apk'))
    .map(name => path.join(outDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || '';
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} 失败：${result.stderr || result.stdout}`);
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function walk(directory, base = directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, base, files);
    else files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files;
}

try {
  if (!apk || !fs.existsSync(apk)) throw new Error(`找不到 APK：${apk || '(apk-out/ 为空)'}`);
  if (!fs.existsSync(buildTools)) throw new Error(`找不到 build-tools：${buildTools}`);
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('dist/ 不存在，先运行 npm run build');
  console.log(`[verify] ${apk}`);
  console.log(`[verify] ${(fs.statSync(apk).size / 1024 / 1024).toFixed(1)} MB\n`);

  const signed = run(path.join(buildTools, 'apksigner'), ['verify', '--verbose', '--print-certs', apk], { allowFailure: true });
  check('APK 签名有效', signed.status === 0, signed.status === 0 ? '' : signed.stderr.trim());
  check('签名为 v2 或 v3', /Verified using v2 scheme .*: true/.test(signed.stdout)
    || /Verified using v3 scheme .*: true/.test(signed.stdout));
  check('签名为 v3', /Verified using v3 scheme \(APK Signature Scheme v3\): true/.test(signed.stdout));

  const aligned = run(path.join(buildTools, 'zipalign'), ['-c', '-v', String(ZIP_ALIGNMENT_BYTES), apk], { allowFailure: true });
  check(`${ZIP_ALIGNMENT_BYTES} 字节对齐`, aligned.status === 0);
  const aligned16 = run(path.join(buildTools, 'zipalign'),
    ['-c', '-P', String(PAGE_ALIGNMENT_KB), '-v', String(ZIP_ALIGNMENT_BYTES), apk], { allowFailure: true });
  check('16 KB 页对齐', aligned16.status === 0);

  const integrity = run('unzip', ['-tqq', apk], { allowFailure: true });
  check('ZIP 完整性', integrity.status === 0);

  const badging = run(path.join(buildTools, 'aapt2'), ['dump', 'badging', apk]).stdout;
  check('包名', /package: name='io\.github\.sunflower9264\.inoita'/.test(badging));
  check('应用名 Inotia 4', /application-label:'Inotia 4'/.test(badging));
  // 版本号只维护 android/app/build.gradle 一处，校验时直接读它。
  const expectedVersion =
    /versionName\s+'([^']+)'/.exec(
      fs.readFileSync(path.join(root, 'android', 'app', 'build.gradle'), 'utf8'))?.[1] ?? '';
  check(`版本 ${expectedVersion || '未知'}`,
    expectedVersion !== '' && badging.includes(`versionName='${expectedVersion}'`));
  check('minSdk 29', /minSdkVersion:'29'/.test(badging));
  check('targetSdk 34', /targetSdkVersion:'34'/.test(badging));
  check('启动 Activity', /launchable-activity: name='io\.github\.sunflower9264\.inoita\.MainActivity'/.test(badging));

  const permissions = run(path.join(buildTools, 'aapt2'), ['dump', 'permissions', apk]).stdout;
  check('申请 INTERNET 权限（诊断上报）', /android\.permission\.INTERNET/.test(permissions));

  const xmltree = run(path.join(buildTools, 'aapt2'), ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk]).stdout;
  check('锁定横屏 sensorLandscape', new RegExp(`screenOrientation[^=]*=${ANDROID_SENSOR_LANDSCAPE}\\b`).test(xmltree));
  check('软键盘 adjustResize',
    new RegExp(`windowSoftInputMode[^=]*=0x0*${ANDROID_ADJUST_RESIZE.toString(16)}\\b`).test(xmltree));
  check('关闭 predictive back', /enableOnBackInvokedCallback[^=]*=false/.test(xmltree));
  check('禁止明文网络', /usesCleartextTraffic[^=]*=false/.test(xmltree));
  check('配置了诊断服务器的网络安全策略', /networkSecurityConfig/.test(xmltree));

  const entries = run('unzip', ['-Z1', apk]).stdout.split('\n').map(line => line.trim())
    .filter(name => name && !name.endsWith('/'));
  // dexopt/ 是 Android Gradle 插件自动生成的 baseline profile，不属于游戏资源。
  const apkAssets = entries.filter(name => name.startsWith('assets/')).map(name => name.slice('assets/'.length))
    .filter(name => !name.startsWith('dexopt/'));
  const diagnosticsInApk = run('unzip', ['-p', apk, 'assets/diagnostics.js']).stdout;
  check('诊断脚本与 dist 一致', diagnosticsInApk === fs.readFileSync(path.join(dist, 'diagnostics.js'), 'utf8'));
  const dexText = entries.filter(name => /^classes\d*\.dex$/.test(name))
    .map(name => run('unzip', ['-p', apk, name]).stdout).join('\n');
  check('包含 Cefrium 浏览器', dexText.includes('com/cefrium/CefriumBrowser'));
  check('包含本地资源服务', dexText.includes('LocalAssetServer'));
  const nativeLibs = entries.filter(name => name.startsWith('lib/'));
  check('包含 arm64 Chromium 原生库', nativeLibs.some(name => name.startsWith('lib/arm64-v8a/') && name.endsWith('.so')));
  check('只打包 arm64 ABI', nativeLibs.length > 0 && nativeLibs.every(name => name.startsWith('lib/arm64-v8a/')));
  check('原生库解压到磁盘', /extractNativeLibs[^=]*=true/.test(xmltree));
  check('未打包 .build-meta.json', !apkAssets.includes('.build-meta.json'));

  const distFiles = walk(dist).filter(name => name !== '.build-meta.json');
  const apkSet = new Set(apkAssets);

  const updateTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'inoita-verify-apk-'));
  try {
    // 资源名混淆后会出现只差大小写的条目，APFS 不区分大小写，必须用 -o 覆盖，否则 unzip 会卡在交互提问。
    run('unzip', ['-o', '-q', apk, '-d', updateTemp]);
    const updateAssets = path.join(updateTemp, 'assets', 'update');
    const publicKey = readUpdatePublicKey();
    const pointerBuilds = [];
    const seenBuilds = new Set();
    for (const name of ['latest.json', 'latest-staging.json']) {
      const pointerPath = path.join(updateAssets, name);
      const pointerSigPath = `${pointerPath}.sig`;
      check(`APK 内存在 assets/update/${name} 与 .sig`, fs.existsSync(pointerPath) && fs.existsSync(pointerSigPath));
      if (!fs.existsSync(pointerPath) || !fs.existsSync(pointerSigPath)) continue;
      const pointerBytes = fs.readFileSync(pointerPath);
      check(`${name} 签名有效`, verifyBytes(pointerBytes, fs.readFileSync(pointerSigPath, 'utf8'), publicKey));
      const pointer = parsePointer(JSON.parse(pointerBytes.toString('utf8')));
      pointerBuilds.push(pointer.buildId);
      if (!apkSet.has(pointer.manifest) || !apkSet.has(`${pointer.manifest}.sig`)) {
        check(`APK 内存在清单 ${pointer.manifest} 与 .sig`, false);
        continue;
      }
      if (seenBuilds.has(pointer.buildId)) continue;
      seenBuilds.add(pointer.buildId);

      const manifestPath = path.join(updateAssets, `${pointer.buildId}.json`);
      const manifestSigPath = `${manifestPath}.sig`;
      const manifestBytes = fs.readFileSync(manifestPath);
      check(`清单 ${pointer.buildId} SHA-256 与指针一致`, sha256Hex(manifestBytes) === pointer.manifestSha256);
      check(`清单 ${pointer.buildId} 签名有效`, verifyBytes(manifestBytes, fs.readFileSync(manifestSigPath, 'utf8'), publicKey));
      const manifest = parseManifest(JSON.parse(manifestBytes.toString('utf8')));
      check(`清单 buildId 与指针一致`, manifest.buildId === pointer.buildId);

      try {
        const result = await verifyManifestFiles(path.join(updateTemp, 'assets'), manifest);
        check(`清单 ${pointer.buildId} 的文件哈希与大小`, true, `${result.checked} 个文件`);
      } catch (error) {
        check(`清单 ${pointer.buildId} 的文件哈希与大小`, false, error.message);
      }

      const distManifest = path.join(dist, pointer.manifest);
      check(`dist 清单 ${pointer.manifest} 与 APK 一致`,
        fs.existsSync(distManifest) && fs.readFileSync(distManifest).equals(manifestBytes));
      const mismatched = manifest.files.filter(file => {
        const inApk = path.join(updateTemp, 'assets', ...file.p.split('/'));
        const onDisk = path.join(dist, ...file.p.split('/'));
        return !fs.existsSync(inApk) || !fs.existsSync(onDisk)
          || !fs.readFileSync(inApk).equals(fs.readFileSync(onDisk));
      });
      check(`清单 ${pointer.buildId} 的文件与 dist 逐字节一致`, mismatched.length === 0,
        mismatched.length ? `${mismatched.length} 个不同（如 ${mismatched[0].p}）` : `${manifest.files.length} 个文件`);
    }
    check('两个更新指针指向同一份清单', pointerBuilds.length > 0 && pointerBuilds.every(id => id === pointerBuilds[0]));
  } finally {
    fs.rmSync(updateTemp, { recursive: true, force: true });
  }

  const distSet = new Set(distFiles);
  const missing = distFiles.filter(name => !apkSet.has(name));
  // Cefrium 自带 Chromium 运行资源，不属于游戏内容，不参与和 dist 的逐文件对比。
  // 0.18.0 会把引擎资源改名为 `名字+com.cefrium+`，避免和系统 WebView 撞名。
  const engineAssets = ['icudtl.dat', 'resources.pak', 'chrome_100_percent.pak',
    'chrome_200_percent.pak', 'stored-locales/', 'cefrium/'];
  const isEngineAsset = name => name.endsWith('+com.cefrium+') || engineAssets.some(prefix =>
    prefix.endsWith('/') ? name.startsWith(prefix) : name === prefix);
  const extra = apkAssets.filter(name => !distSet.has(name) && !isEngineAsset(name));
  check('游戏资产与 dist 完全一致', missing.length === 0 && extra.length === 0,
    missing.length || extra.length
      ? `缺少 ${missing.length} 个${missing.length ? `（如 ${missing[0]}）` : ''}，多出 ${extra.length} 个${extra.length ? `（如 ${extra[0]}）` : ''}`
      : `${distFiles.length} 个游戏文件，另有 Chromium 运行资源`);

  const indexInApk = run('unzip', ['-p', apk, 'assets/index.html']).stdout;
  const indexOnDisk = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  check('入口 index.html 与 dist 一致', indexInApk === indexOnDisk);

  for (const required of ['assets/bundles/', 'assets/assets/ui/app-icon.png', 'assets/content/campaign.json', 'assets/content/debug/start.json', 'assets/diagnostics.js', 'assets/manifest.webmanifest']) {
    const present = required.endsWith('/')
      ? apkAssets.some(name => name.startsWith(required.slice('assets/'.length)))
      : apkSet.has(required.slice('assets/'.length));
    check(`存在 ${required}`, present);
  }

  console.log('');
  if (problems.length) {
    console.error(`[verify] 失败 ${problems.length} 项：${problems.join('、')}`);
    process.exit(1);
  }
  console.log('[verify] 全部检查通过');
} catch (error) {
  console.error(`[verify] ${error.message}`);
  process.exit(1);
}
