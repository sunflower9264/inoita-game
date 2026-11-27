import type { AssetLease } from '../application/assets.ts';
import type { StoryContext } from '../application/ports.ts';
import type { ActorDefinition } from '../domain/content.ts';
import type { EquipmentSlot } from '../domain/items.ts';
import { learnedSkillIds } from '../domain/skill-configuration.ts';
import { costumeRecipe } from '../domain/wardrobe.ts';
import { partyMemberCombatAssets } from '../rendering/combat-assets.ts';
import type { Outfit, WardrobePrepareOptions } from '../rendering/outfit-pool.ts';
import type { PendingAsset } from '../rendering/scene-assets.ts';
import { acquireCompanionWardrobe, pruneCompanionWardrobes } from '../rendering/wardrobe-cache.ts';

export interface WardrobePort {
  prepare(
    base: ActorDefinition,
    equipment: Partial<Record<EquipmentSlot, string>>,
    classId?: string,
    options?: WardrobePrepareOptions,
  ): Promise<Outfit>;
  activate(outfit: Outfit): void;
  releasePreview(): void;
  destroy(): void;
}

export interface WorldOutfitsHost {
  readonly app: Pick<StoryContext, 'session' | 'wardrobe' | 'items' | 'world' | 'battleCatalog'>;
  readonly destroyed: boolean;
  readonly loadingWorld: boolean;
  readonly map: { readonly townPose?: boolean } | undefined;
  readonly player: { actor: ActorDefinition } | undefined;
  readonly requestToken: AbortSignal;
  createWardrobe(): WardrobePort;
  loadManualAssets(assets: PendingAsset[]): Promise<AssetLease>;
  setPlayerClipIdle(restart: boolean): void;
  refreshPlayerShape(): void;
  onMemberAppearance(memberId: string, actor: ActorDefinition): void;
  onEquipmentUpdated(memberId?: string): void;
  syncControlledCharacter(): void;
}

const sortedSkillSignature = (ids: ReadonlySet<string>): string => [...ids].sort().join('|');

/**
 * 集中管理主角与佣兵衣柜、换装并发令牌、预览 LRU 缓存及剧情投影后的装备刷新，
 * 与具体 Phaser 场景对象通过 `WorldOutfitsHost` 解耦。
 */
export class WorldOutfits {
  private readonly host: WorldOutfitsHost;
  wardrobe?: WardrobePort;
  private readonly companionWardrobes = new Map<string, WardrobePort>();
  private readonly companionAssets = new Map<string, AssetLease>();
  private readonly companionOutfits = new Map<string, { actor: ActorDefinition }>();
  /** 菜单预览单独准备的外观；与世界外观分开持有，互不释放对方的纹理。 */
  private readonly companionPreviews = new Map<string, { actor: ActorDefinition; equipment: string; learned: string }>();
  private readonly companionPreparations = new Map<string, { equipment: string; learned: string; promise: Promise<void> }>();
  /** 已经合成了整套动作的伙伴。 */
  private readonly companionFull = new Set<string>();
  /** 招募时预拼、准备上阵前也要保留的外观；最多留最近两套。 */
  private readonly companionPinned = new Set<string>();
  private readonly companionLearned = new Map<string, string>();
  /** 最近一次为菜单预览准备的成员；LRU 淘汰时要保留它的外观纹理。 */
  private companionPreviewId?: string;
  private readonly projectedMemberEquipment = new Map<string, string>();
  projectedPlayerEquipment = '';
  playerTownPose?: boolean;
  equippedActor?: ActorDefinition;
  outfitRequest = 0;

  constructor(host: WorldOutfitsHost) {
    this.host = host;
  }

  /** init 重置各伙伴记录并递增 `outfitRequest` 作废在途换装。 */
  reset(): void {
    this.companionWardrobes.clear();
    this.companionOutfits.clear();
    this.companionPreviews.clear();
    this.companionPreparations.clear();
    this.companionFull.clear();
    this.companionPinned.clear();
    this.companionLearned.clear();
    for (const lease of this.companionAssets.values()) lease.release();
    this.companionAssets.clear();
    this.companionPreviewId = undefined;
    this.projectedMemberEquipment.clear();
    this.projectedPlayerEquipment = '';
    this.wardrobe = undefined;
    this.equippedActor = undefined;
    this.outfitRequest++;
  }

  /** shutdown 时销毁所有衣柜与伙伴纹理租约。 */
  destroy(): void {
    this.wardrobe?.destroy();
    this.wardrobe = undefined;
    for (const wardrobe of this.companionWardrobes.values()) wardrobe.destroy();
    this.companionWardrobes.clear();
    this.companionOutfits.clear();
    this.companionPreviews.clear();
    this.companionPreparations.clear();
    this.companionFull.clear();
    this.companionPinned.clear();
    this.companionLearned.clear();
    this.companionPreviewId = undefined;
    for (const lease of this.companionAssets.values()) lease.release();
    this.companionAssets.clear();
    this.projectedMemberEquipment.clear();
    this.equippedActor = undefined;
  }

  /** 先把当前武器/职业那套人物动作请求发出去；失败不挡进图，Wardrobe 会重试。 */
  warmPlayerPoses(outfits: StoryContext['outfits'], signal: AbortSignal): void {
    const { session, wardrobe, items, battleCatalog } = this.host.app;
    const character = session.character;
    if (!character) return;
    try {
      const recipe = costumeRecipe(
        wardrobe,
        items,
        session.bag.equipmentItems(),
        character.classId,
        character.appearance.id,
        learnedSkillIds(battleCatalog, character.classId, session.skills),
      );
      const missing = [...new Set(Object.values(recipe.poses))]
        .filter((id): id is string => typeof id === 'string' && !wardrobe.poses[id]);
      if (!missing.length) return;
      void outfits?.warmPoses(missing).catch(error => {
        if (!signal.aborted) globalThis.storyDiagnostics?.record('wardrobe-pose-warm-error', { error });
      });
    } catch (error) {
      globalThis.storyDiagnostics?.record('wardrobe-pose-warm-error', { error });
    }
  }

  /** 进图主流程首次装配主角衣柜与已装备外观。 */
  async prepareEntryOutfit(signal: AbortSignal): Promise<ActorDefinition> {
    const { session, battleCatalog } = this.host.app;
    const wardrobe = this.wardrobe = this.host.createWardrobe();
    const character = session.character!;
    const outfit = await wardrobe.prepare(
      character.appearance,
      session.bag.equipmentItems(),
      character.classId,
      {
        townPose: this.playerTownPose ?? this.host.map?.townPose,
        learnedSkills: learnedSkillIds(battleCatalog, character.classId, session.skills),
        signal,
      },
    );
    signal.throwIfAborted();
    wardrobe.activate(outfit);
    this.equippedActor = outfit.actor;
    this.projectedPlayerEquipment = JSON.stringify(session.bag.equipmentItems());
    return outfit.actor;
  }

  /** 恢复场景快照时若主角城镇姿态有变，促使后续刷新重新合成外观。 */
  adoptSceneTownPose(pose: boolean | undefined): void {
    if (pose !== this.playerTownPose) {
      this.playerTownPose = pose;
      this.projectedPlayerEquipment = '';
    }
  }

  async changeEquipment(entry: string | undefined, slot: EquipmentSlot, signal?: AbortSignal, memberId = 'player'): Promise<void> {
    const { app, player, loadingWorld, destroyed, map } = this.host;
    if (!this.wardrobe || !player || loadingWorld || destroyed) throw new Error('请等待地图加载');
    if (memberId !== 'player') {
      const member = app.session.party?.get(memberId);
      if (!member) throw new Error('伙伴不存在');
      const bag = app.session.bag;
      const revision = bag.revision;
      const next = entry ? bag.planEquip(entry, slot, memberId, member.classId, member.level) : bag.planUnequip(slot, memberId);
      const wardrobe = this.companionWardrobe(memberId);
      const base = app.world.actors[member.definition.actor];
      const learned = learnedSkillIds(app.battleCatalog, member.classId, member.skills);
      const learnedSignature = sortedSkillSignature(learned);
      const outfit = await wardrobe.prepare(base, bag.equipmentItems(next), member.classId, {
        townPose: map?.townPose,
        learnedSkills: learned,
        signal,
      });
      signal?.throwIfAborted();
      if (
        this.host.destroyed ||
        app.session.party?.get(memberId) !== member ||
        revision !== bag.revision ||
        learnedSignature !== sortedSkillSignature(learnedSkillIds(app.battleCatalog, member.classId, member.skills))
      ) {
        throw new Error('装备状态已改变，请重新选择');
      }
      if (entry) app.session.bag.equip(entry, slot, memberId, member.classId, member.level);
      else app.session.bag.unequip(slot, memberId);
      member.setHealth(member.player.health);
      member.setMana(member.player.mana);
      const wardrobeChanged = this.companionOutfits.get(memberId)?.actor !== outfit.actor;
      wardrobe.activate(outfit);
      this.companionOutfits.set(memberId, outfit);
      this.companionPreviews.delete(memberId);
      wardrobe.releasePreview();
      this.projectedMemberEquipment.set(memberId, JSON.stringify(bag.equipmentItems(bag.equipmentFor(memberId))));
      this.companionLearned.set(memberId, learnedSignature);
      this.companionFull.add(memberId);
      if (wardrobeChanged) this.host.onMemberAppearance(memberId, outfit.actor);
      if (wardrobeChanged || slot === 'main-hand' || slot === 'off-hand') this.host.onEquipmentUpdated(memberId);
      return;
    }
    const bag = app.session.bag;
    const revision = bag.revision;
    const request = ++this.outfitRequest;
    const skillsVersion = app.session.skills.version;
    const skillsReset = app.session.skills.resetVersion;
    const next = entry ? bag.planEquip(entry, slot) : bag.planUnequip(slot);
    const outfit = await this.wardrobe.prepare(
      app.session.character!.appearance,
      bag.equipmentItems(next),
      app.session.character!.classId,
      {
        townPose: this.playerTownPose ?? map?.townPose,
        learnedSkills: learnedSkillIds(app.battleCatalog, app.session.character!.classId, app.session.skills),
        signal,
      },
    );
    signal?.throwIfAborted();
    if (
      this.host.destroyed ||
      request !== this.outfitRequest ||
      revision !== bag.revision ||
      skillsVersion !== app.session.skills.version ||
      skillsReset !== app.session.skills.resetVersion
    ) {
      throw new Error('装备状态已改变，请重新选择');
    }
    this.wardrobe.activate(outfit);
    this.equippedActor = outfit.actor;
    const wardrobeChanged = player.actor !== outfit.actor;
    if (wardrobeChanged) {
      player.actor = outfit.actor;
      this.host.setPlayerClipIdle(true);
      this.host.refreshPlayerShape();
    }
    if (entry) bag.equip(entry, slot);
    else bag.unequip(slot);
    this.projectedPlayerEquipment = JSON.stringify(bag.equipmentItems());
    if (wardrobeChanged || slot === 'main-hand' || slot === 'off-hand') this.host.onEquipmentUpdated();
  }

  private companionWardrobe(id: string): WardrobePort {
    return acquireCompanionWardrobe(
      this.companionWardrobes,
      id,
      () => this.host.createWardrobe(),
      {
        keep: candidate => this.companionWardrobeInUse(candidate),
        limit: this.activeCompanionCount() + 1,
        onEvict: candidate => this.forgetCompanionWardrobe(candidate),
      },
    );
  }

  private activeCompanionCount(): number {
    return (this.host.app.session.party?.activeIds ?? []).filter(id => id !== 'player').length;
  }

  private forgetCompanionWardrobe(id: string): void {
    this.companionOutfits.delete(id);
    this.companionPreviews.delete(id);
    this.companionPreparations.delete(`${id}|full`);
    this.companionPreparations.delete(`${id}|preview`);
    this.projectedMemberEquipment.delete(id);
    this.companionFull.delete(id);
    this.companionPinned.delete(id);
    this.companionLearned.delete(id);
    this.companionAssets.get(id)?.release();
    this.companionAssets.delete(id);
    if (this.companionPreviewId === id) this.companionPreviewId = undefined;
  }

  private releaseCompanionWardrobe(id: string): void {
    const wardrobe = this.companionWardrobes.get(id);
    if (wardrobe) {
      wardrobe.destroy();
      this.companionWardrobes.delete(id);
    }
    this.forgetCompanionWardrobe(id);
  }

  releasePartyPreview(): void {
    this.companionPreviewId = undefined;
    for (const wardrobe of this.companionWardrobes.values()) wardrobe.releasePreview();
    this.companionPreviews.clear();
    pruneCompanionWardrobes(
      this.companionWardrobes,
      id => this.companionWardrobeInUse(id),
      id => this.forgetCompanionWardrobe(id),
    );
  }

  private companionWardrobeInUse(id: string): boolean {
    if (!this.host.app.session.party?.get(id)) return false;
    return (
      id === this.companionPreviewId ||
      this.companionPreparations.has(`${id}|full`) ||
      this.companionPreparations.has(`${id}|preview`) ||
      this.companionPinned.has(id) ||
      this.host.app.session.party?.activeIds.includes(id) === true
    );
  }

  previewAppearance(id: string): ActorDefinition | undefined {
    if (id === 'player') return this.host.player?.actor;
    const preview = this.companionPreviews.get(id);
    if (preview) {
      const bag = this.host.app.session.bag;
      if (preview.equipment === JSON.stringify(bag.equipmentItems(bag.equipmentFor(id)))) return preview.actor;
    }
    return this.companionOutfits.get(id)?.actor;
  }

  equipmentAppearance(id: string): ActorDefinition | undefined {
    return id === 'player' ? this.host.player?.actor : this.companionOutfits.get(id)?.actor;
  }

  async preparePartyMember(id: string, signal?: AbortSignal, options?: { full?: boolean; pin?: boolean }): Promise<void> {
    if (id === 'player') return;
    const { app, map } = this.host;
    const member = app.session.party?.get(id);
    if (!member || this.host.destroyed) throw new Error('伙伴不存在');
    const full = options?.full === true;
    const pin = full && options?.pin === true;
    if (!full) this.companionPreviewId = id;
    const bag = app.session.bag;
    const equipment = bag.equipmentItems(bag.equipmentFor(id));
    const signature = JSON.stringify(equipment);
    const learned = learnedSkillIds(app.battleCatalog, member.classId, member.skills);
    const learnedSignature = sortedSkillSignature(learned);
    if (this.projectedMemberEquipment.get(id) !== signature || this.companionLearned.get(id) !== learnedSignature) {
      this.companionFull.delete(id);
    }
    const previewed = this.companionPreviews.get(id);
    const ready = full
      ? this.companionOutfits.has(id) &&
        this.projectedMemberEquipment.get(id) === signature &&
        this.companionFull.has(id) &&
        this.companionLearned.get(id) === learnedSignature
      : !!previewed && previewed.equipment === signature && previewed.learned === learnedSignature;
    if (ready) {
      if (pin) this.pinCompanion(id);
      return;
    }
    const wardrobe = this.companionWardrobe(id);
    const preparationKey = `${id}|${full ? 'full' : 'preview'}`;
    let preparation = this.companionPreparations.get(preparationKey);
    if (!preparation || preparation.equipment !== signature || preparation.learned !== learnedSignature) {
      const owner = this.host.requestToken;
      const changed = () =>
        this.host.destroyed ||
        owner !== this.host.requestToken ||
        owner.aborted ||
        signature !== JSON.stringify(bag.equipmentItems(bag.equipmentFor(id))) ||
        app.session.party?.get(id) !== member;
      const promise = (async () => {
        if (full) {
          const actor = app.world.actors[member.definition.actor];
          if (actor) {
            const assets = partyMemberCombatAssets(app.battleCatalog, app.wardrobe, member.classId, actor, learned, {
              items: app.items,
              equipment,
            });
            const lease = await this.host.loadManualAssets(assets);
            try {
              signal?.throwIfAborted();
              if (changed()) throw new Error('伙伴状态已改变');
              const previous = this.companionAssets.get(id);
              this.companionAssets.set(id, lease);
              previous?.release();
            } catch (error) {
              lease.release();
              throw error;
            }
          }
        }
        return wardrobe.prepare(
          app.world.actors[member.definition.actor],
          equipment,
          member.classId,
          full ? { townPose: map?.townPose, learnedSkills: learned } : { clipNames: ['idle-south'], preview: true },
        );
      })().then(outfit => {
        signal?.throwIfAborted();
        if (changed()) throw new Error('伙伴状态已改变');
        if (sortedSkillSignature(learnedSkillIds(app.battleCatalog, member.classId, member.skills)) !== learnedSignature) {
          throw new Error('伙伴技能已改变');
        }
        if (!full) {
          this.companionPreviews.set(id, { actor: outfit.actor, equipment: signature, learned: learnedSignature });
          return;
        }
        wardrobe.activate(outfit);
        this.companionOutfits.set(id, outfit);
        this.companionFull.add(id);
        this.host.onMemberAppearance(id, outfit.actor);
        this.projectedMemberEquipment.set(id, signature);
        this.companionLearned.set(id, learnedSignature);
        this.host.onEquipmentUpdated(id);
        if (pin) this.pinCompanion(id);
      });
      preparation = { equipment: signature, learned: learnedSignature, promise };
      this.companionPreparations.set(preparationKey, preparation);
    }
    try {
      await preparation.promise;
      signal?.throwIfAborted();
    } finally {
      if (this.companionPreparations.get(preparationKey) === preparation) {
        this.companionPreparations.delete(preparationKey);
      }
      if (!this.companionWardrobeInUse(id)) this.releaseCompanionWardrobe(id);
    }
  }

  private pinCompanion(id: string): void {
    this.companionPinned.delete(id);
    this.companionPinned.add(id);
    while (this.companionPinned.size > 2) {
      const oldest = this.companionPinned.values().next().value;
      if (oldest === undefined) break;
      this.companionPinned.delete(oldest);
      if (!this.companionWardrobeInUse(oldest)) this.releaseCompanionWardrobe(oldest);
    }
  }

  async preparePlayerAppearance(): Promise<void> {
    const signal = this.host.requestToken;
    const { session, battleCatalog } = this.host.app;
    const character = session.character;
    if (!character || !this.wardrobe || !this.host.player) return;
    const revision = session.bag.revision;
    const skills = session.skills.version;
    const reset = session.skills.resetVersion;
    const request = ++this.outfitRequest;
    const outfit = await this.wardrobe.prepare(
      character.appearance,
      session.bag.equipmentItems(),
      character.classId,
      {
        townPose: this.playerTownPose ?? this.host.map?.townPose,
        learnedSkills: learnedSkillIds(battleCatalog, character.classId, session.skills),
        signal,
      },
    );
    signal.throwIfAborted();
    if (
      this.host.destroyed ||
      this.host.app.session !== session ||
      request !== this.outfitRequest ||
      revision !== session.bag.revision ||
      skills !== session.skills.version ||
      reset !== session.skills.resetVersion
    ) {
      throw new Error('人物状态已改变');
    }
    this.wardrobe.activate(outfit);
    this.equippedActor = outfit.actor;
    if (this.host.player.actor !== outfit.actor) {
      this.host.player.actor = outfit.actor;
      this.host.setPlayerClipIdle(false);
      this.host.refreshPlayerShape();
      this.host.onEquipmentUpdated();
    }
  }

  async projectEquipment(signal: AbortSignal): Promise<void> {
    if (!this.wardrobe || !this.host.player) return;
    const { session, battleCatalog } = this.host.app;
    const character = session.character;
    if (!character) return;
    const equipment = session.bag.equipmentItems();
    const signature = JSON.stringify(equipment);
    if (signature !== this.projectedPlayerEquipment) {
      const request = ++this.outfitRequest;
      const outfit = await this.wardrobe.prepare(
        character.appearance,
        equipment,
        character.classId,
        {
          townPose: this.playerTownPose ?? this.host.map?.townPose,
          learnedSkills: learnedSkillIds(battleCatalog, character.classId, session.skills),
          signal,
        },
      );
      signal.throwIfAborted();
      if (this.host.destroyed || request !== this.outfitRequest || signature !== JSON.stringify(session.bag.equipmentItems())) {
        throw new Error('剧情装备状态已改变');
      }
      this.wardrobe.activate(outfit);
      this.equippedActor = outfit.actor;
      this.host.player.actor = outfit.actor;
      this.host.setPlayerClipIdle(false);
      this.host.refreshPlayerShape();
      this.host.onEquipmentUpdated();
      this.projectedPlayerEquipment = signature;
    }
    for (const id of session.party?.activeIds ?? []) {
      if (id !== 'player') await this.preparePartyMember(id, signal, { full: true });
    }
    signal.throwIfAborted();
    this.host.syncControlledCharacter();
  }
}
