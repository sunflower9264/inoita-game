import { StoryExecutionBudgetError } from './domain/story-runtime.ts';
import Phaser from 'phaser';
import type {StoryApp} from './app.ts';
import type {Session} from './domain/session.ts';
import type {WorldScene} from './scenes/world-scene.ts';
import type {StoryStageScene} from './scenes/story-stage-scene.ts';
import type {AutoSaver} from './application/auto-save.ts';
import type {StoryWorldViewSnapshot} from './application/world-snapshot.ts';
import {SavedGameLoader} from './application/saved-game-loader.ts';
import {prepareSavedGame} from './application/saved-game.ts';
import {AUTO_SAVE_SLOT,type SaveGame,type SaveSlotRef} from './domain/save-game.ts';
import {SCENE_KEYS} from './application/scene-keys.ts';
import {nextStoryMap} from './domain/story-preparation.ts';
import {StoryPresenter} from './rendering/story-presenter.ts';
import {OutfitPool} from './rendering/outfit-pool.ts';
import {StoryDirector} from './domain/story-director.ts';
import {installStorySkipDiagnostics} from './application/game-diagnostics.ts';
import {createGmActions, type GmStoryJumpPort, type GmStoryJumpSnapshot} from './debug/gm-actions.ts';
import type {CheckpointSnapshot} from './domain/session-checkpoint.ts';

interface SessionLifecycleHooks {
  lifetime: {current:AbortController};
  worldScene():WorldScene|undefined;
  currentScene():Phaser.Scene|undefined;
  gmOn():boolean;
  runtimeDiagnostics():Record<string,unknown>;
  prepareStory(signal:AbortSignal):Promise<void>;
  prepareMenuCore(signal:AbortSignal,progress:(value:number)=>void):Promise<void>;
  refreshMenuWhenReady(signal:AbortSignal):void;
  cancelCommonPreload():void;
  clearMenuPreparations():void;
  recordSceneChange(scene:string,details:Record<string,unknown>):void;
  remeasureRefreshAfterStart():void;
  startAutoSave(session:Session):void;
  stopAutoSave():void;
  autoSaver():AutoSaver<StoryWorldViewSnapshot>|undefined;
}

/** 本局的装配、读档交接和退出顺序共用同一入口。 */
export function createSessionLifecycle(app:StoryApp,hooks:SessionLifecycleHooks) {
  const ui=app.ui;
  const {lifetime,worldScene,currentScene,gmOn,runtimeDiagnostics,prepareStory,prepareMenuCore,
    refreshMenuWhenReady,cancelCommonPreload,clearMenuPreparations,recordSceneChange,
    remeasureRefreshAfterStart,startAutoSave,stopAutoSave}=hooks;
  const savedGameLoader=new SavedGameLoader();
  const AUDIO_READY_DIAGNOSTIC_DELAY_MS=4000;
  function stopCurrentWork():void {
    worldScene()?.discardWorldWork();
    stopAutoSave();app.gm?.dispose();lifetime.current.abort();app.director?.dispose();
    app.gm=undefined;delete globalThis.gm;
    app.clearMapPrefetch();app.clearStoryPrefetch();ui.resetInput();
  }
  async function prepareCandidate(game:SaveGame<StoryWorldViewSnapshot>,request:AbortSignal,slot?:SaveSlotRef) {
    request.throwIfAborted();
    app.storyClasses=await app.content.storyClasses(request);
    request.throwIfAborted();
    await prepareStory(request);
    request.throwIfAborted();
    let candidate:ReturnType<typeof prepareSavedGame>;
    try { candidate=prepareSavedGame(game,app); }
    catch(error){
      if(slot===undefined)throw error;
      globalThis.storyDiagnostics?.record('load-validation-failed',{slot,
        reason:error instanceof Error?error.message:String(error)},false);
      throw new Error('游戏存档出错。无法正常进行游戏。');
    }
    await app.content.map(candidate.map.file,request);
    request.throwIfAborted();
    return candidate;
  }
  async function resumeSlot(slot:SaveSlotRef,signal?:AbortSignal):Promise<void> {
    // 压测不读写存档；要读档先返回标题，避免把压测会话和存档会话混在一起。
    if(app.pressureMode)return;
    const game=app.game,sourceMode=app.mode,sourceScene=currentScene(),sourceSession=app.session,sourceLifetime=lifetime.current;
    if(!game||(sourceMode!=='menu'&&sourceMode!=='game')||app.suspended||!ui.ready||savedGameLoader.busy||
      !sourceScene?.sys.isActive()||sourceMode==='game'&&worldScene()?.loadingWorld)return;
    const isCurrent=()=>lifetime.current===sourceLifetime&&app.mode===sourceMode&&currentScene()===sourceScene&&app.session===sourceSession&&
      (sourceScene.sys.isActive()||sourceScene.sys.isPaused());
    const loadStarted=performance.now();
    globalThis.storyDiagnostics?.record('load-start',{slot,from:sourceMode},false);
    try{
      await savedGameLoader.load(slot,{
        isCurrent,
        prepare:async(selectedSlot,request)=>{
          const reading=app.saves.inspect(selectedSlot);
          if(reading.kind!=='ok')throw new Error(reading.kind==='empty'?'没有可以载入的存档。':'游戏存档出错。无法正常进行游戏。');
          ui.loading('正在读取存档…');
          const candidate=await prepareCandidate(reading.game,request,selectedSlot);
          ui.loading('正在准备游戏菜单…',0.15);
          await prepareMenuCore(request,value=>ui.loading('正在准备游戏菜单…',0.15+0.35*value));
          refreshMenuWhenReady(request);
          request.throwIfAborted();return candidate;
        },
        stopCurrent:async()=>{
          cancelCommonPreload();
          stopCurrentWork();
          const stopped=new Promise<void>(resolve=>sourceScene.events.once(Phaser.Scenes.Events.SHUTDOWN,()=>resolve()));
          game.scene.stop(sourceScene.sys.settings.key);await stopped;
          app.releaseResidentCombat();
        },
        install:(candidate,request)=>{
          lifetime.current=request;const {session,world}=candidate,location=world.location;
          app.mode='game';ui.setMode('game');ui.loading('正在读取存档…');
          // 自动槽不是玩家手动选择的槽，所以这里留空。
          app.saveSlot=slot===AUTO_SAVE_SLOT?undefined:slot;
          installSession(session, candidate.map.file);
          recordSceneChange(SCENE_KEYS.world, { map: location.map, source: 'load' });
          game.scene.start(SCENE_KEYS.world,{map:location.map,x:location.x,y:location.y,facing:location.facing,
            initialEntry:true,suppressEntry:true,resumeStory:true,signal:request.signal,checkpoint:world.world,generatedEntities:world.generatedEntities,preparedScene:world.scene,triggerContacts:world.triggerContacts,
            onReady:()=>{
              if(request.signal.aborted)return;
              remeasureRefreshAfterStart?.();
              if(world.audio)app.audio?.restoreStoryAudio(world.audio);
              window.setTimeout(()=>{if(!request.signal.aborted)globalThis.storyDiagnostics?.record('load-audio-ready',{map:location.map});},AUDIO_READY_DIAGNOSTIC_DELAY_MS);
            }});
        },
      },signal);
      globalThis.storyDiagnostics?.record('load',{slot,
        elapsedMs:Math.round((performance.now()-loadStarted)*10)/10},false);
    }catch(error){
      // 玩家返回、切槽或换会话会让 loader 抛 AbortError；取消不是读档失败，不能写进错误流。
      const cancelled=!!signal?.aborted||(typeof error==='object'&&error!==null
        &&(error as {name?:string}).name==='AbortError');
      if(cancelled){
        globalThis.storyDiagnostics?.record('load-cancel',{slot},false);
      }else{
        globalThis.storyDiagnostics?.record('load-error',{slot,
          elapsedMs:Math.round((performance.now()-loadStarted)*10)/10,error});
      }
      if(isCurrent())ui.loaded();throw error;
    }
  }

  function installSession(session: Session, keepMapFile?: string): void {
    stopAutoSave();app.gm?.dispose();app.director?.dispose();
    // 会话可能换了职业；旧常驻包、历史地图纹理和会话级内容解析结果都不再复用。
    app.releaseResidentCombat();
    app.clearMapHistory();
    app.clearStoryPrefetch();
    app.content.clearSessionCaches(keepMapFile);
    app.outfits?.destroy();
    app.outfits = new OutfitPool({ textures: app.game!.textures, anims: app.game!.anims, game: app.game! },
      app.wardrobe, app.items, (ids, signal) => app.content.wardrobePoses(ids, signal));
    const campaign = app.campaign, presentation = app.storyInterface;
    app.session = session;
    globalThis.storyDiagnostics?.record('session-install', {
      slot: app.saveSlot ?? null, map: session.storyWorld.currentLocation?.map ?? null,
      pressure: app.pressureMode, party: session.party?.activeIds ?? null,
      classId: session.hero?.classId ?? null, level: session.hero?.level ?? null,
    }, false);
    app.storySignal = lifetime.current.signal;
    const signal=lifetime.current.signal;
    const worldScene=()=>app.session===session&&!signal.aborted?hooks.worldScene():undefined;
    const requireWorldScene=()=>{const scene=worldScene();if(!scene)throw new Error('请等待地图加载');return scene;};
    app.checkpoint.clear();
    app.summonLampMerchant=(entry,signal)=>requireWorldScene().summonLampMerchant(entry,signal);
    app.changeEquipment=async(entry,slot,signal,memberId)=>requireWorldScene().changeEquipment(entry,slot,signal,memberId);
    app.equipmentAppearance=memberId=>worldScene()?.equipmentAppearance(memberId);
    app.previewAppearance=memberId=>worldScene()?.previewAppearance(memberId);
    app.useRecoveryItem=(entry,memberId)=>requireWorldScene().useRecoveryItem(entry,memberId);
    app.preparePartyMember=async(id,signal,options)=>{const scene=worldScene();if(scene)await scene.preparePartyMember(id,signal,options);};
    app.releasePartyPreview=()=>worldScene()?.releasePartyPreview();
    // 属性页只在菜单重绘时读一次；菜单打开期间战斗已暂停，Buff 不会继续走。
    app.combatAttribute=(id,attribute,base,passives)=>worldScene()?.combatAttribute(id,attribute,base,passives)??base;
    app.combatStealthed=id=>worldScene()?.combatStealthed(id)??false;
    app.revivePartyMember=(id,item)=>requireWorldScene().revivePartyMember(id,item);
    ui.playerActor = campaign.start.actor;
    app.storyUI.bind(session, app.world, presentation);
    ui.questItemName = id => app.items.items[id]?.name ?? id;
    const presenter = new StoryPresenter(app, worldScene, () => app.game!.scene.getScene(SCENE_KEYS.storyStage) as StoryStageScene);
    const director = new StoryDirector(campaign, session, ui, locked => {
      if (app.director !== director || signal.aborted) return;
      ui.lock(locked,'game');
      if (!locked) app.storyAssetPreparation.clear();
      const scene = worldScene();
      if (locked && scene?.player) scene.setClip(scene.player, `idle-${scene.facing}`);
    }, presenter, {
      normalize: async signal => {
        const scene = worldScene();
        await scene?.waitWorldReady(signal);
        signal.throwIfAborted();
        await scene?.normalizeForStory(signal);
      },
      capture: () => worldScene()?.captureStoryWorld(),
      restore: async (snapshot, signal) => { await worldScene()?.restoreStoryWorld(snapshot, signal); },
      project: async (stage, signal) => { await worldScene()?.projectStoryWorld(stage, signal); },
      checkpoint: () => worldScene()?.checkpointStoryWorld(),
      settle: () => worldScene()?.settleStoryPlayback(),
      prepare: (_commands, signal, stage, script, cursor) => {
        const scene = worldScene();
        signal.throwIfAborted();
        if (scene?.map) {
          const target = cursor ? nextStoryMap(campaign, cursor, scene.map.id)
            : stage && !stage.mapFromWorld ? stage.map : undefined;
          void scene.prefetchStoryEntry(target ?? scene.map.id, script, signal);
        }
      },
      prefetch: async (scripts, signal) => { await worldScene()?.ensureStoryAssets(scripts, signal); },
    });
    app.director = director;
    if (globalThis.storyDiagnostics) installStorySkipDiagnostics(director,
      (kind, details) => globalThis.storyDiagnostics?.record(kind, details, false));
    // 事件播完（世界投影已经结束）写入自动存档；节点中途不写。
    director.onEventCompleted = () => {if(worldScene())hooks.autoSaver()?.request();};
    director.onError = (error, retry) => {
      if (app.director !== director || signal.aborted || app.mode !== 'game') return;
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      const snapshot = worldScene()?.diagnosticSnapshot();
      globalThis.storyDiagnostics?.record('story-error', { message, stack: error instanceof Error ? error.stack : undefined,
        map: snapshot?.map, player: snapshot?.player, storyExecution: error instanceof StoryExecutionBudgetError ? error.details : undefined });
      ui.error(message, () => {
        if(signal.aborted||app.session!==session)return;
        ui.loaded(); void (async () => {
          try {
            // 世界只建了一半时先重建，成功后再接着走剧情游标。
            await worldScene()?.recoverWorld();
            await retry();
          } catch (next) { director.onError?.(next, retry); }
        })();
      });
    };
    const storyJump: GmStoryJumpPort = {
      ready: () => !!worldScene()?.worldReady(),
      capture: (): GmStoryJumpSnapshot => {
        const scene = worldScene();
        if (!scene?.worldReady()) throw new Error('正式地图尚未就绪');
        return { session: session.captureState(), world: scene.captureStoryWorld(), checkpoint: app.checkpoint.peek() };
      },
      begin: () => {
        director.holdTriggers();
        app.storyJumpActive = true;
      },
      releaseTriggers: () => { director.releaseTriggers(); },
      closeMenu: () => { app.storyUI?.close(); },
      travel: async destination => {
        if (app.session !== session || signal.aborted || app.director !== director) throw new Error('会话已经关闭');
        const scene = worldScene();
        if (!scene) throw new Error('不在游戏场景里');
        if (destination.map === session.storyWorld.currentLocation?.map) session.movePlayer(destination);
        else session.applyStoryCommands([{ type: 'travel', destination }]);
        await scene.projectStoryWorld(undefined, signal, destination);
        if (app.session !== session || signal.aborted || app.director !== director) throw new Error('会话已经关闭');
        if (!scene.worldReady() || scene.map?.id !== destination.map) throw new Error('所选阶段的地图尚未就绪');
      },
      play: async accept => {
        app.storyUI?.close();
        if (app.session !== session || signal.aborted || app.director !== director) return false;
        if (accept.eventId) return director.trigger({ id: accept.eventId, script: accept.script });
        return director.script(accept.script);
      },
      settled: async accept => {
        // `play` 在遇到剧情战斗等待时会先返回；等这条 run 真正结束再交接，
        // 避免在战斗前就清掉强制状态或提前恢复自动存档。
        while (app.session === session && !signal.aborted && app.director === director) {
          const active = director.runtime.snapshot().runs.some(run =>
            (run.status === 'running' || run.status === 'waiting') &&
            (accept.eventId ? run.eventId === accept.eventId
              : run.script === accept.script || run.cursor.script === accept.script));
          if (!active) return;
          await new Promise<void>(resolve => setTimeout(resolve, 200));
        }
      },
      restore: async (snapshot: GmStoryJumpSnapshot) => {
        const scene = worldScene();
        if (!scene) throw new Error('不在游戏场景里');
        // 恢复期间任务簿会变化，不能让它顺手触发剧情。
        director.holdTriggers();
        try {
          session.restoreState(snapshot.session);
          await scene.restoreStoryWorld(snapshot.world, signal);
          // await 期间可能已经回标题/读档；身份不对时不能再写全局检查点。
          if (app.session !== session || signal.aborted || app.director !== director) throw new Error('会话已经关闭');
          app.checkpoint.install(snapshot.checkpoint as CheckpointSnapshot<StoryWorldViewSnapshot> | undefined);
          app.storyJumpActive = false;
        } finally { director.releaseTriggers(); }
      },
      checkpoint: () => { worldScene()?.checkpointStoryWorld(); },
      finish: () => {
        app.storyJumpActive = false;
        director.releaseTriggers();
      },
      dispose: () => {
        session.questBook.clearDebugOverrides();
        app.storyJumpActive = false;
        director.releaseTriggers();
      },
    };
    // GM 动作层在会话装配好之后才建（它要 session 与 director）；开关关闭时**不建也不挂**，
    // 这样「默认关闭」是结构上的保证，而不是靠调用方自觉。
    app.gm = gmOn() ? createGmActions({
      session, campaign, director, storyJump,
      requestAutoSave: () => app.autoSave?.(),
      status: () => runtimeDiagnostics(),
      rescue: () => {
        const scene = worldScene();
        if (!scene) return { ok: false, reason: '不在游戏场景里' };
        return scene.rescuePlayer();
      },
      setNoclip: enabled => {
        signal.throwIfAborted();app.gmNoclip = enabled;
        const scene = worldScene();
        if (scene) scene.setNoclip(enabled);
        return { ok: true };
      },
      isNoclip: () => app.gmNoclip,
      setSpeedMultiplier: multiplier => {
        signal.throwIfAborted();app.gmSpeedMultiplier = multiplier;
        const scene = worldScene();
        if (scene) scene.setSpeedMultiplier(multiplier);
        return { ok: true };
      },
      getSpeedMultiplier: () => app.gmSpeedMultiplier ?? 1,
      ui: () => app.storyUI.diagnosticState(),
      combat: {
        setInvincible: (id, enabled) => {
          const scene = worldScene();
          return scene ? scene.setInvincible(id, enabled) : { ok: false, reason: '不在游戏场景里' };
        },
        // 开关存在会话上，换图重建战斗后仍然有效，所以读取不必经过场景。
        isInvincible: id => session.isInvincible(id),
        setOneHitKill: (id, enabled) => {
          const scene = worldScene();
          return scene ? scene.setOneHitKill(id, enabled) : { ok: false, reason: '不在游戏场景里' };
        },
        isOneHitKill: id => session.isOneHitKill(id),
        revive: id => {
          const scene = worldScene();
          return scene ? scene.reviveMember(id) : { ok: false, reason: '不在游戏场景里' };
        },
      },
    }) : undefined;
    if (app.gm) globalThis.gm = app.gm; else delete globalThis.gm;
    app.audio?.enterStory();
    // 会话装好之后再开自动存档：它要绑定这一份会话的任务状态。
    startAutoSave(session);
  }

  function returnToMenu(): void {
    if (!ui.canReturn) return;
    if (app.mode === 'game' && worldScene()?.loadingWorld && !ui.failed) return;
    app.pressureMode = false;
    const returnPage=app.mode==='class-select'?'slots':'home';
    const departedSession = app.session;
    savedGameLoader.cancel();stopCurrentWork();lifetime.current=new AbortController();clearMenuPreparations();
    // 会话已经销毁：把动作层一起摘掉，免得 agent 拿到一个指向已 dispose 导演的句柄。
    app.gm = undefined; delete globalThis.gm;
    const scene = currentScene();
    const releaseSessionAssets = () => { app.releaseSession(departedSession); };
    const stage = app.game?.scene.getScene(SCENE_KEYS.storyStage);
    if (stage && (stage.sys.isActive() || stage.sys.isPaused() || stage.sys.isSleeping())) app.game!.scene.stop(SCENE_KEYS.storyStage);
    if (scene?.sys.isActive() || scene?.sys.isPaused()) {
      // 场景还活着时不能提前删纹理；等 WorldScene/当前场景真正 shutdown 后再释放。
      scene.events.once(Phaser.Scenes.Events.SHUTDOWN, releaseSessionAssets);
      scene.scene.start(SCENE_KEYS.menu,{page:returnPage});
    } else releaseSessionAssets();
    // 初始内容请求失败时菜单场景仍在运行。
    app.mode = 'menu'; ui.lock(false,'game'); ui.setMode('menu');
    recordSceneChange(SCENE_KEYS.menu, { source: 'return' });
    app.audio?.enterMenu();
  }
  return {install:installSession,load:resumeSlot,prepareCandidate,exit:returnToMenu,stopCurrentWork,
    get busy(){return savedGameLoader.busy;}};
}
