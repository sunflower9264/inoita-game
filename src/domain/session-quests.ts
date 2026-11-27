import type { Campaign, CampaignQuest } from './campaign.ts';
import type { QuestRewardReceipt, QuestStatus } from './content.ts';
import type { QuestDropRequirement } from './drops.ts';
import type { QuestBook, QuestFact, QuestGoal, QuestProgress, QuestSettlement } from './quest-book.ts';
import { storyConditionReferences, type StoryConditionContext, type StoryWorldValue } from './story-condition.ts';
import type { StoryWorldState } from './story-world.ts';

export type WaitingGoalEntry = {
  kind: 'talk' | 'interact';
  target: string;
  quest: CampaignQuest;
  goal: QuestGoal;
};

/**
 * 协调会话的任务查询、版本化投影缓存、奖励收据与交付人释放。
 * 与 `Session` 分离以控制单文件职责，内部缓存仍严格按任务簿和背包版本号复用。
 */
export class SessionQuestCoordinator {
  private readonly campaign: Campaign;
  private readonly questsById: ReadonlyMap<string, CampaignQuest>;
  private readonly questGroupKinds: ReadonlyMap<string, 'main' | 'side'>;
  private readonly questConditionInputs: { key: string; read: (context: StoryConditionContext) => StoryWorldValue | undefined }[] = [];
  private readonly receipts = new Map<string, QuestSettlement>();
  private receiptRevisionValue = 0;
  private visitorReleaseRevisionValue = 0;
  private trackedQuest?: string;
  private questProjection?: { questVersion: number; bagVersion: number; owner: string; conditions: (StoryWorldValue | undefined)[] };
  private waitingGoalProjection?: { version: number; entries: readonly WaitingGoalEntry[] };
  private questsProjection?: { questVersion: number; value: ReadonlyMap<string, Readonly<QuestProgress & { count: number }>> };
  private questSlotProjection?: { version: number; values: Map<string, CampaignQuest | undefined> };
  private markerActorProjection?: { version: number; values: Map<string, boolean> };
  private goalMarkerProjection?: { version: number; values: Map<string, boolean> };

  constructor(campaign: Campaign) {
    this.campaign = campaign;
    this.questsById = new Map(campaign.quests.map(quest => [quest.id, quest]));
    this.questGroupKinds = new Map(
      campaign.questGroups.flatMap(group => group.questIds.map(id => [id, group.kind] as const)),
    );
    const inputs = { events: new Set<string>(), choices: new Set<string>(), flags: new Set<string>(), world: new Set<string>() };
    for (const quest of campaign.quests) {
      const references = storyConditionReferences(quest.availableWhen);
      for (const key of Object.keys(inputs) as (keyof typeof inputs)[]) {
        for (const id of references[key]) inputs[key].add(id);
      }
    }
    for (const id of inputs.events) this.questConditionInputs.push({ key: `event:${id}`, read: context => context.eventStatus(id) });
    for (const id of inputs.choices) this.questConditionInputs.push({ key: `choice:${id}`, read: context => context.choice(id) });
    for (const id of inputs.flags) this.questConditionInputs.push({ key: `flag:${id}`, read: context => context.flag(id) });
    for (const key of inputs.world) this.questConditionInputs.push({ key: `world:${key}`, read: context => context.world(key) });
  }

  get receiptRevision(): number { return this.receiptRevisionValue; }
  get visitorReleaseRevision(): number { return this.visitorReleaseRevisionValue; }
  setVisitorReleaseRevision(revision: number): void { this.visitorReleaseRevisionValue = revision; }
  get trackedQuestId(): string | undefined { return this.trackedQuest; }
  setTrackedQuestId(id: string | undefined): void { this.trackedQuest = id; }

  definition(id: string): CampaignQuest | undefined { return this.questsById.get(id); }

  status(questBook: QuestBook | undefined, id: string): QuestStatus {
    return questBook?.status(id) ?? 'locked';
  }

  invalidateProjections(): void {
    this.questProjection = undefined;
    this.questsProjection = undefined;
  }

  invalidateQuestProjection(): void {
    this.questProjection = undefined;
  }

  quests(questBook: QuestBook): ReadonlyMap<string, Readonly<QuestProgress & { count: number }>> {
    const questVersion = questBook.version, cached = this.questsProjection;
    if (cached?.questVersion === questVersion) return cached.value;
    const value = new Map(
      questBook.captureState().quests.map(([id, state]) => [
        id,
        Object.freeze({ ...state, count: Object.values(state.goals).reduce((sum, count) => sum + count, 0) }),
      ]),
    );
    this.questsProjection = { questVersion, value };
    return value;
  }

  private readConditions(getContext: () => StoryConditionContext): (StoryWorldValue | undefined)[] {
    const context = this.questConditionInputs.length ? getContext() : undefined;
    return this.questConditionInputs.map(input => input.read(context!));
  }

  recordProjection(questBook: QuestBook, bagVersion: number, owner: string, getContext: () => StoryConditionContext): void {
    this.questProjection = {
      questVersion: questBook.version,
      bagVersion,
      owner,
      conditions: this.readConditions(getContext),
    };
  }

  refresh(
    questBook: QuestBook | undefined,
    bagVersion: number,
    owner: string,
    getContext: () => StoryConditionContext,
    hooks: { onMutateQuestBook: () => void; storyWorld: StoryWorldState; onBeforeReleaseVisitors: () => void },
  ): void {
    if (!questBook) return;
    const questVersion = questBook.version;
    const conditions = this.readConditions(getContext);
    const previous = this.questProjection;
    if (
      previous && previous.questVersion === questVersion && previous.bagVersion === bagVersion && previous.owner === owner
      && conditions.every((value, index) => Object.is(value, previous.conditions[index]))
    ) {
      return;
    }
    if (!previous) {
      hooks.onMutateQuestBook();
      questBook.commit(questBook.plan({ type: 'refresh' }));
    } else {
      const keys: string[] = [];
      for (const [index, input] of this.questConditionInputs.entries()) {
        if (!Object.is(conditions[index], previous.conditions[index])) keys.push(input.key);
      }
      const bagChanged = previous.bagVersion !== bagVersion;
      const ownerChanged = previous.owner !== owner;
      if (keys.length || bagChanged || ownerChanged) {
        hooks.onMutateQuestBook();
        questBook.refreshChanges({ keys, bagChanged, ownerChanged });
      }
    }
    if (questBook.version !== questVersion) {
      this.releaseReadyActors(questBook, hooks.storyWorld, hooks.onBeforeReleaseVisitors);
    }
    this.recordProjection(questBook, bagVersion, owner, getContext);
  }

  /**
   * 任务已经待交付时，发布者/交付人不能被本次进图的临时剧情缺席挡住。
   * 只清访问级缺席（原版 0x28 leave）；永久清除名单（原版 0x26）仍按剧情保持隐藏。
   */
  releaseReadyActors(questBook: QuestBook, storyWorld: StoryWorldState, onBeforeRelease: () => void): void {
    if (!storyWorld.hasVisitAbsences) return;
    onBeforeRelease();
    const placements = this.campaign.placements;
    let released = false;
    for (const id of questBook.runningQuestIds) {
      if (questBook.status(id) !== 'ready') continue;
      const quest = this.definition(id);
      if (!quest) continue;
      for (const [actor, characterId] of [[quest.giver, quest.giverCharacterId], [quest.delivery, quest.deliveryCharacterId]] as const) {
        if (!characterId) continue;
        for (const placement of placements) {
          if (placement.characterId === characterId) {
            released = storyWorld.clearVisitAbsence(placement.map, actor ?? characterId, characterId) || released;
          }
        }
      }
    }
    if (released) this.visitorReleaseRevisionValue++;
  }

  rewardReceiptFor(id: string): QuestRewardReceipt | undefined {
    const receipt = this.receipts.get(id);
    return receipt ? structuredClone(receipt.reward) : undefined;
  }

  captureReceipts(): QuestSettlement[] {
    return [...this.receipts.values()].map(receipt => structuredClone(receipt));
  }

  captureBaselineReceipts(): [string, QuestSettlement][] {
    return [...this.receipts].map(([key, receipt]) => [key, structuredClone(receipt)]);
  }

  /** 收据表按任务保存一张；正常写入已经按周期覆盖。 */
  restoreReceipts(receipts: Iterable<QuestSettlement>): void {
    this.receipts.clear();
    for (const receipt of receipts) this.receipts.set(receipt.quest, structuredClone(receipt));
    this.receiptRevisionValue++;
  }

  /** 登记任务交付收据；先检查周期防重，再发放经验/金币，最后写入收据确保失败不残留。 */
  recordReceipt(
    receipt: QuestSettlement,
    grantReward: { addExperience(amount: number): void; gainMoney(amount: number): void },
  ): void {
    const existing = this.receipts.get(receipt.quest);
    if (existing && receipt.cycle <= existing.cycle) throw new Error('任务奖励已结算');
    if (receipt.reward.experience) grantReward.addExperience(receipt.reward.experience);
    if (receipt.reward.money) grantReward.gainMoney(receipt.reward.money);
    this.receipts.set(receipt.quest, structuredClone(receipt));
    this.receiptRevisionValue++;
  }

  /** 回到所选剧情阶段时，已领取的资产继续归玩家，后续任务重新取得正式交付资格。 */
  retainSettlements(delivered: ReadonlySet<string>): void {
    for (const id of this.receipts.keys()) {
      if (!delivered.has(id)) {
        this.receipts.delete(id);
        this.receiptRevisionValue++;
      }
    }
  }

  private itemGoal(questBook: QuestBook, quest: string, item: string): QuestGoal | undefined {
    const definition = this.definition(quest);
    if (!definition || this.status(questBook, quest) !== 'active') return undefined;
    return definition.goals.find(goal => goal.kind === 'item' && goal.target === item);
  }

  questDropRequirements(
    questBook: QuestBook,
    itemCount: (id: string) => number,
    pending: ReadonlyMap<string, number>,
  ): readonly (readonly QuestDropRequirement[])[] {
    return questBook.runningQuestIds.flatMap(id => {
      const quest = this.definition(id)!;
      if (questBook.status(id) !== 'active' || quest.completion !== 'all') return [];
      const goals = quest.goals.filter(goal => goal.kind === 'item')
        .map(goal => ({ item: goal.target, quantity: goal.quantity, owned: itemCount(goal.target) + (pending.get(goal.target) ?? 0) }));
      return goals.length ? [goals] : [];
    });
  }

  questItemRemaining(
    questBook: QuestBook,
    quest: string,
    item: string,
    itemCount: (id: string) => number,
    pendingCount: number,
  ): number {
    const goal = this.itemGoal(questBook, quest, item);
    return goal ? Math.max(0, goal.quantity - itemCount(item) - pendingCount) : 0;
  }

  questItemPickupRemaining(questBook: QuestBook, item: string, held: number): number | undefined {
    let needed = false, remaining = 0;
    for (const quest of questBook.runningQuestIds) {
      const goal = this.itemGoal(questBook, quest, item);
      if (!goal) continue;
      needed = true;
      remaining = Math.max(remaining, goal.quantity - held);
    }
    return needed ? remaining : undefined;
  }

  private waitingGoalIndex(questBook: QuestBook): readonly WaitingGoalEntry[] {
    const version = questBook.version, cached = this.waitingGoalProjection;
    if (cached?.version === version) return cached.entries;
    const entries: WaitingGoalEntry[] = [];
    for (const quest of this.campaign.quests) {
      if (this.status(questBook, quest.id) !== 'active') continue;
      const progress = questBook.state(quest.id)?.goals;
      for (const goal of quest.goals) {
        if (goal.kind !== 'talk' && goal.kind !== 'interact') continue;
        if ((progress?.[goal.id] ?? 0) >= goal.quantity) continue;
        entries.push({ kind: goal.kind, target: goal.target, quest, goal });
      }
    }
    this.waitingGoalProjection = { version, entries };
    return entries;
  }

  waitingGoalEntries(questBook: QuestBook, target: string, characterId?: string): WaitingGoalEntry[] {
    const goals: WaitingGoalEntry[] = [];
    for (const entry of this.waitingGoalIndex(questBook)) {
      if (characterId !== undefined && entry.goal.characterId !== undefined ? entry.goal.characterId === characterId : entry.target === target) {
        goals.push(entry);
      }
    }
    return goals;
  }

  canInteract(questBook: QuestBook, target: string, characterId?: string): boolean {
    return this.waitingGoalEntries(questBook, target, characterId).length > 0;
  }

  findWeakenTarget(questBook: QuestBook, enemyId: string): { quest: CampaignQuest; change: NonNullable<CampaignQuest['targetChanges']>[number] } | undefined {
    return this.campaign.quests.flatMap(quest => this.status(questBook, quest.id) === 'active'
      ? (quest.targetChanges ?? []).filter(change => change.enemyId === enemyId
          && (questBook.state(quest.id)?.goals[change.goal] ?? 0) < (quest.goals.find(goal => goal.id === change.goal)?.quantity ?? 0))
        .map(change => ({ quest, change }))
      : [])[0];
  }

  shouldRemoveCapturedAfterInteract(questBook: QuestBook, target: string): boolean {
    return this.campaign.quests.some(quest => this.status(questBook, quest.id) === 'active'
      && quest.targetChanges?.some(change => change.actor === target && change.removeAfterInteraction));
  }

  shouldRecordStoryDefeat(questBook: QuestBook, enemyId: string): boolean {
    for (const id of questBook.runningQuestIds) {
      if (this.status(questBook, id) !== 'active') continue;
      const quest = questBook.definition(id);
      if (quest?.completion !== 'all') continue;
      if (quest.goals.some(goal => goal.kind === 'defeat' && goal.target === enemyId)) return true;
    }
    return false;
  }

  nextQuestFact(questBook: QuestBook, kind: QuestFact['kind'], target: string, source: string = kind): QuestFact {
    const prior = questBook.factSequence(source);
    return { kind, target, occurrence: { source, sequence: prior + 1 } };
  }

  private matchesQuestActor(quest: CampaignQuest, actor: string, characterId: string | undefined, delivery: boolean): boolean {
    const expectedActor = delivery ? (quest.delivery ?? quest.giver) : quest.giver;
    const expectedCharacter = delivery ? (quest.deliveryCharacterId ?? quest.giverCharacterId) : quest.giverCharacterId;
    return characterId !== undefined && expectedCharacter !== undefined ? characterId === expectedCharacter : actor === expectedActor;
  }

  forActor(questBook: QuestBook, actor: string, characterId?: string): CampaignQuest[] {
    const priority: Record<QuestStatus, number> = { ready: 0, available: 1, active: 2, locked: 3, completed: 4 };
    return this.campaign.quests.filter(quest =>
      this.matchesQuestActor(quest, actor, characterId, this.status(questBook, quest.id) !== 'available')
      && questBook.journalVisible(quest.id) && ['ready', 'available', 'active'].includes(this.status(questBook, quest.id)))
      .sort((a, b) => priority[this.status(questBook, a.id)] - priority[this.status(questBook, b.id)]);
  }

  npcQuestSlot(questBook: QuestBook, actor: string, characterId?: string): CampaignQuest | undefined {
    const version = questBook.version, cached = this.questSlotProjection;
    if (!cached || cached.version !== version) this.questSlotProjection = { version, values: new Map() };
    const values = this.questSlotProjection!.values, key = actor + '\0' + (characterId ?? '');
    if (!values.has(key)) values.set(key, this.computeQuestSlot(questBook, actor, characterId));
    return values.get(key);
  }

  private computeQuestSlot(questBook: QuestBook, actor: string, characterId?: string): CampaignQuest | undefined {
    for (const id of questBook.runningQuestIds) {
      if (this.status(questBook, id) !== 'ready') continue;
      const quest = this.definition(id);
      if (quest && this.matchesQuestActor(quest, actor, characterId, true)) return quest;
    }
    const available = this.campaign.quests.filter(quest => this.status(questBook, quest.id) === 'available'
      && this.matchesQuestActor(quest, actor, characterId, false));
    const main = available.find(quest => this.questGroupKinds.get(quest.id) === 'main');
    if (main) return main;
    if (available.length) return available[0];
    for (const id of questBook.runningQuestIds) {
      if (this.status(questBook, id) !== 'active') continue;
      const quest = this.definition(id);
      if (quest && this.matchesQuestActor(quest, actor, characterId, true)) return quest;
    }
    return undefined;
  }

  deliverablesFor(questBook: QuestBook, actor: string): CampaignQuest[] {
    return this.campaign.quests.filter(quest =>
      this.status(questBook, quest.id) === 'ready'
      && this.matchesQuestActor(quest, actor, undefined, true)
      && !questBook.journalVisible(quest.id));
  }

  marker(questBook: QuestBook, actor: string, characterId?: string): QuestStatus | null {
    const quest = this.npcQuestSlot(questBook, actor, characterId);
    return quest ? this.status(questBook, quest.id) : (this.activeGoalMarker(questBook, actor, characterId) ? 'active' : null);
  }

  markerActor(questBook: QuestBook, actor: string, characterId?: string): boolean {
    const version = questBook.version, cached = this.markerActorProjection;
    if (!cached || cached.version !== version) this.markerActorProjection = { version, values: new Map() };
    const values = this.markerActorProjection!.values, key = actor + '\0' + (characterId ?? '');
    if (!values.has(key)) {
      values.set(key, this.campaign.quests.some(quest => {
        const status = this.status(questBook, quest.id);
        if (!['available', 'active', 'ready'].includes(status)) return false;
        return this.matchesQuestActor(quest, actor, characterId, status !== 'available');
      }));
    }
    return values.get(key)! || this.activeGoalMarker(questBook, actor, characterId);
  }

  private activeGoalMarker(questBook: QuestBook, actor: string, characterId?: string): boolean {
    const version = questBook.version, cached = this.goalMarkerProjection;
    if (!cached || cached.version !== version) this.goalMarkerProjection = { version, values: new Map() };
    const values = this.goalMarkerProjection!.values, key = actor + '\0' + (characterId ?? '');
    if (!values.has(key)) {
      values.set(key, this.campaign.quests.some(quest => {
        if (this.status(questBook, quest.id) !== 'active') return false;
        const progress = questBook.state(quest.id)?.goals;
        return quest.goals.some(goal => (goal.kind === 'talk' || goal.kind === 'interact')
          && (characterId !== undefined && goal.characterId !== undefined ? goal.characterId === characterId : goal.target === actor)
          && (progress?.[goal.id] ?? 0) < goal.quantity);
      }));
    }
    return values.get(key)!;
  }

  currentQuest(questBook: QuestBook): CampaignQuest | undefined {
    if (this.trackedQuest && questBook.journalVisible(this.trackedQuest) && ['active', 'ready'].includes(this.status(questBook, this.trackedQuest))) {
      return this.definition(this.trackedQuest);
    }
    return this.campaign.quests.find(quest => questBook.journalVisible(quest.id) && ['active', 'ready'].includes(this.status(questBook, quest.id)))
      ?? this.campaign.quests.find(quest => questBook.journalVisible(quest.id) && this.status(questBook, quest.id) === 'available');
  }

  trackQuest(questBook: QuestBook, id: string): boolean {
    if (!questBook.journalVisible(id) || !['active', 'ready'].includes(this.status(questBook, id))) return false;
    this.trackedQuest = id;
    return true;
  }
}
