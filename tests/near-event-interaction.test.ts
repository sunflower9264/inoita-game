import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseStoryInterface } from '../src/application/content-validation.ts';
import { interactionCandidateRank, pickNearestInteractionTarget } from '../src/domain/interaction.ts';
import { StoryDirector } from '../src/domain/story-director.ts';
import { QuestPanel } from '../src/ui/panels/quest-panel.ts';
import { headlessContent, playthrough } from './helpers/story-playthrough.ts';
import { buildTestWorldScene, loadWorldSceneClass } from './support/world-scene-fixture.ts';

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const storyInterface = parseStoryInterface(read('story-interface'));
const WorldScene = await loadWorldSceneClass();

test('边境关口迎宾员选暂不付钱后保留头顶对话气泡、小地图标记与原地按键重触发，空任务页显示居中提示且不误报未接主线', async () => {
  const h = playthrough();
  const { session, director } = h;
  const { campaign, world } = headlessContent;
  try {
    session.gainMoney(106_980);

    // 1. 复现污染神殿大厅确认推进（清空旧支线 + 接取《前往人类领地》）-> 进边境关口完成《前往人类领地》 -> 迎宾员首次问答选第 2 项
    session.accept('quest-130');
    h.choices(['option-0']);
    session.applyStoryCommands([{ type: 'choice', choice: 'choice-5', value: 'option-0' }]);
    await h.idle();
    assert.equal(session.status('quest-129'), 'active');

    h.choices(['option-1']);
    session.applyStoryCommands([
      { type: 'travel', destination: { map: 'noxious-sanctum-chapel-0f48cdaf', x: 184, y: 24, facing: 'north' } },
    ]);
    await director.enterRegion('event-121', 'noxious-sanctum-chapel-0f48cdaf');
    await h.idle();

    // 此时《前往人类领地》已完成、旧支线已清空、迎宾员第 1 次选了 option-1：尚未接取《潘德利村的贝恩》
    assert.equal(session.status('quest-129'), 'completed');
    assert.equal(session.status('quest-75'), 'available');
    assert.equal(session.questBook.runningQuestIds.length, 0);
    assert.equal(session.currentQuest(), undefined, '未接取的 quest-75 不能被当成 currentQuest');

    // 2. 空任务面板在左栏中心渲染「暂无进行中的任务」兜底文字
    const panelSpecs: { key: string; text: string }[] = [];
    const panelView = {
      text: () => ({ height: 20, context: { measureText: (v: string) => v.length * 10 }, setOrigin() { return this; }, setAlign() { return this; }, destroy() {} }),
      border() {},
      image() {},
      button() { throw new Error('空列表不应渲染任务行按钮'); },
      scroll: () => ({ content: {}, guard: () => true, setHeight() {}, scrollTop: 0, visible: true, cancelGesture() {} }),
    };
    const panel = new QuestPanel(session, world, { assets: {} } as never, () => {});
    panel.render(panelView as never);
    panel.renderText({ add: spec => panelSpecs.push({ key: spec.key, text: spec.text }) });
    assert.deepEqual(panelSpecs, [{ key: 'quest-empty', text: '暂无进行中的任务' }]);

    // 3. 迎宾员（npc-240）在边境关口就绪 near 事件：头顶挂 talk.png、小地图标交互圆环、站在 18px 处可直接选中并反复按键对话
    const borderMap = { id: 'border-gateway-67e044a2', tileSize: 16, columns: 40, rows: 30 };
    const projected = session.storyWorld.projectEntities('border-gateway-67e044a2', [], campaign.placements);
    const toutEntity = projected.find(entity => entity.characterId === 'npc-240');
    assert.ok(toutEntity, '迎宾员在边境关口可见');
    const toutActor = world.actors[toutEntity.actor]!;

    assert.equal(session.nearEvent(toutEntity, borderMap.id)?.id, 'event-128');
    assert.equal(interactionCandidateRank(toutEntity, toutActor, session, false, borderMap.id), 1);

    const toutCandidate = {
      entity: toutEntity,
      actor: toutActor,
      container: {
        x: toutEntity.x,
        y: toutEntity.y,
        visible: true,
        alpha: 1,
        setVisible(v: boolean) {
          this.visible = v;
          return this;
        },
      },
      marker: undefined as { setFile(f?: string): void; position(): void; setAlpha(): void; setVisible(): void } | undefined,
    };
    const playerFoot = { x: 215, y: 170 };
    const picked = pickNearestInteractionTarget(playerFoot, [toutCandidate], session, { mapId: borderMap.id });
    assert.equal(picked?.entity.characterId, 'npc-240', '站在迎宾员身旁 18px 处可直接选中为交互目标');

    let minimapInteractions: { id: string }[] = [];
    let markerFile: string | undefined;
    const host = buildTestWorldScene(WorldScene, {
      map: borderMap,
      characters: [toutCandidate],
      worldHud: {
        minimap: {
          updatePlayer() {},
          updateTasks() {},
          updateInteractions(list: { id: string }[]) { minimapInteractions = list; },
        },
      },
      app: {
        session,
        storyInterface,
        shops: { shops: {} },
        ui: { showInstant() {} },
      },
      sceneOverrides: {
        refreshLoadout() {},
        createQuestMarker(character: typeof toutCandidate) {
          character.marker = {
            setFile(f?: string) { markerFile = f; },
            position() {},
            setAlpha() {},
            setVisible() {},
          };
        },
        syncQuestMarker() {},
      },
    });
    const unsubscribeScene = session.subscribe(() => host.refreshState());
    host.refreshState();
    assert.equal(markerFile, 'assets/ui/minimap/talk.png', '迎宾员头顶显示原版对话气泡图标');
    assert.deepEqual(minimapInteractions.map(item => item.id), [toutEntity.id], '小地图标出迎宾员交互圆环');

    // 4. 玩家无需退开 25px，站在原地按交互键即可连续选 option-1（重复运行期间气泡隐藏、结束后立即恢复），再按一次选 option-0 付 5 银币接取《潘德利村的贝恩》
    const moneyBefore = session.money;
    h.choices(['option-1']);
    await director.interact(toutEntity, toutActor);
    await h.idle();
    assert.equal(session.status('quest-75'), 'available', '再次选第 2 项仍留在原地可继续对话');
    assert.equal(session.hasNearEvent(toutEntity, borderMap.id), true);
    assert.equal(markerFile, 'assets/ui/minimap/talk.png', '第 1 次拒绝后气泡正常保留');

    h.choices(['option-1']);
    await director.interact(toutEntity, toutActor);
    await h.idle();
    assert.equal(markerFile, 'assets/ui/minimap/talk.png', '第 2 次拒绝（completedEvents 长度未变、尾节点零命令）后气泡仍由 runtimeRevision 驱动恢复');

    h.choices(['option-0']);
    await director.interact(toutEntity, toutActor);
    await h.idle();
    assert.equal(session.money, moneyBefore - 500, '付给迎宾员 5 个银币（500 铜）');
    assert.equal(session.status('quest-75'), 'ready', '成功接取对话型主线《潘德利村的贝恩》（无目标项即刻进入待与贝恩对话状态）');
    assert.equal(session.currentQuest()?.id, 'quest-75');
    assert.equal(markerFile, undefined, '接取任务后迎宾员近身事件不再就绪，头顶气泡自动消失');
    unsubscribeScene();

    // 5. 零命令一次性近身事件（哥布林根据地3 牢笼 event-41）完成后通过会话通知立即收起头顶气泡
    const prison = playthrough();
    try {
      prison.session.applyStoryCommands([
        { type: 'travel', destination: { map: 'goblin-s-lair-3-c6e77244', x: 136, y: 196, facing: 'north' } },
      ]);
      const goblinMap = read<{ entities?: typeof campaign.placements }>('maps/goblin-s-lair-3-c6e77244');
      const prisonEntities = prison.session.storyWorld.projectEntities(
        'goblin-s-lair-3-c6e77244',
        goblinMap.entities ?? [],
        campaign.placements,
      );
      const cellTarget = prisonEntities.find(entity => prison.session.nearEvent(entity, 'goblin-s-lair-3-c6e77244')?.id === 'event-41');
      assert.ok(cellTarget, '哥布林根据地3 存在 event-41 牢笼实体');
      const cellActor = world.actors[cellTarget.actor]!;
      let cellMarker: string | undefined;
      const cellCandidate = {
        entity: cellTarget,
        actor: cellActor,
        container: {
          x: cellTarget.x,
          y: cellTarget.y,
          visible: true,
          alpha: 1,
          setVisible(v: boolean) { this.visible = v; return this; },
        },
        marker: {
          setFile(f?: string) { cellMarker = f; },
          position() {},
          setAlpha() {},
          setVisible() {},
        },
      };
      const prisonHost = buildTestWorldScene(WorldScene, {
        map: { id: 'goblin-s-lair-3-c6e77244', tileSize: 16, columns: 30, rows: 30 },
        characters: [cellCandidate],
        app: {
          session: prison.session,
          storyInterface,
          shops: { shops: {} },
          ui: { showInstant() {} },
        },
        sceneOverrides: {
          refreshLoadout() {},
          syncQuestMarker() {},
        },
      });
      const unsubPrison = prison.session.subscribe(() => prisonHost.refreshState());
      prisonHost.refreshState();
      assert.equal(cellMarker, 'assets/ui/minimap/talk.png');
      await prison.director.interact(cellTarget, cellActor);
      await prison.idle();
      assert.equal(cellMarker, undefined, '零命令近身事件完成后头顶对话气泡立即消失');
      unsubPrison();
    } finally {
      prison.director.dispose();
    }
  } finally {
    director.dispose();
  }
});

test('StoryDirector.interact 执行近身事件时，等舞台释放且 busy 解锁后才按顺序执行友军收拢与检查点抓取', async () => {
  const base = playthrough();
  base.director.dispose();
  const { session } = base;
  const { campaign, world } = headlessContent;
  session.applyStoryCommands([
    { type: 'travel', destination: { map: 'goblin-s-lair-3-c6e77244', x: 136, y: 196, facing: 'north' } },
  ]);
  const goblinMap = read<{ entities?: typeof campaign.placements }>('maps/goblin-s-lair-3-c6e77244');
  const cellTarget = session.storyWorld
    .projectEntities('goblin-s-lair-3-c6e77244', goblinMap.entities ?? [], campaign.placements)
    .find(entity => session.nearEvent(entity, 'goblin-s-lair-3-c6e77244')?.id === 'event-41')!;
  assert.ok(cellTarget);

  const callLog: string[] = [];
  let stageActive = false;
  let director!: StoryDirector;
  director = new StoryDirector(
    campaign,
    session,
    {
      async dialogue() {},
      async choice(_p, options) { return options[0]!; },
      async questPopup() {},
      closeDialogue() {},
      skipDialogue() {},
    },
    () => {},
    {
      begin() { stageActive = true; },
      async execute() {},
      async finish() {},
      async release() { stageActive = false; callLog.push('release'); },
    },
    {
      capture: () => undefined,
      async restore() {},
      async project() {},
      settle() {
        callLog.push(`settle:busy=${director.busy}:stage=${stageActive}`);
      },
      checkpoint() {
        callLog.push(`checkpoint:busy=${director.busy}:stage=${stageActive}`);
      },
    },
  );
  try {
    await director.interact(cellTarget, world.actors[cellTarget.actor]!);
    assert.deepEqual(callLog, [
      'release',
      'settle:busy=false:stage=false',
      'checkpoint:busy=false:stage=false',
    ]);
  } finally {
    director.dispose();
  }
});
