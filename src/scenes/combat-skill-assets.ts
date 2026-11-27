import type Phaser from 'phaser';
import type { AssetLease } from '../application/assets.ts';
import type { BattleCatalog } from '../domain/battle.ts';
import type { BattleCharacter } from '../domain/character-stats.ts';
import type { ActorDefinition } from '../domain/content.ts';
import type { ItemCatalog } from '../domain/items.ts';
import type { CompanionMember, PartyRoster } from '../domain/party.ts';
import { learnedSkillIds } from '../domain/skill-configuration.ts';
import type { StorySkillProgression } from '../domain/story-skills.ts';
import type { WardrobeCatalog } from '../domain/wardrobe.ts';
import { partyMemberCombatAssets, playerCombatAssets } from '../rendering/combat-assets.ts';
import { loadSceneAssets } from '../rendering/scene-assets.ts';

/** 技能素材补载失败后的指数退避：1 秒起，最多 30 秒，最多 5 次。 */
export const SKILL_ASSET_MAX_ATTEMPTS = 5;
const SKILL_ASSET_RETRY_BASE_MS = 1000;
const SKILL_ASSET_RETRY_MAX_MS = 30_000;

export interface SkillAssetHost {
  readonly phaserScene: Phaser.Scene;
  readonly now: number;
  readonly battleCatalog: BattleCatalog;
  readonly wardrobe: WardrobeCatalog;
  readonly items: ItemCatalog;
  readonly hero: BattleCharacter;
  readonly skills: StorySkillProgression;
  party(): PartyRoster | undefined;
  activeParty(): readonly string[];
  playerActor(): ActorDefinition | undefined;
  actorForMember(id: string, member: CompanionMember): ActorDefinition | undefined;
  isClosed(): boolean;
  preparePlayerAppearance(): Promise<void>;
  preparePartyMember(id: string, signal?: AbortSignal, options?: { full?: boolean; pin?: boolean }): Promise<void>;
  onBeforeRefresh(): void;
  onReleaseAllyVisualLease(id: string): void;
  scheduleDelayed(delayMs: number, callback: () => void): { remove(dispatch?: boolean): void };
}

export interface AllyRefreshTarget {
  id: string;
  member: CompanionMember;
  signature: string;
  gate: string;
}

/**
 * 战斗技能增量素材的签名门控、加载租约与指数退避重试状态机。
 * 进图后学新技能或换武器时按需补载新增特效/动作/召唤物，并防止迟到结果覆盖最新配置。
 */
export class CombatSkillAssetManager {
  private readonly host: SkillAssetHost;
  private readonly extraSkillLeases = new Map<string, AssetLease[]>();
  private readonly preparedSkillIds = new Map<string, ReadonlySet<string>>();
  private playerSkillSignature = '';
  private playerSkillGate = '';
  private readonly allySkillSignatures = new Map<string, string>();
  private readonly allySkillGates = new Map<string, string>();
  private readonly skillAssetFailures = new Map<string, { attempts: number; nextAt: number; signature: string }>();
  private skillAssetRetryTimer?: { remove(dispatch?: boolean): void };
  private skillAssetRefreshRunning = false;
  private skillAssetRefreshQueued = false;

  constructor(host: SkillAssetHost) {
    this.host = host;
  }

  preparedSkillsFor(id: string): ReadonlySet<string> | undefined {
    return this.preparedSkillIds.get(id);
  }

  hasLease(owner: string): boolean {
    return this.extraSkillLeases.has(owner);
  }

  playerSkillSignatureNow(): string {
    const actor = this.host.playerActor();
    const learned = [...learnedSkillIds(this.host.battleCatalog, this.host.hero.classId, this.host.skills)].sort();
    const equipment = this.host.hero.bag.equipmentItems(this.host.hero.bag.equipmentFor('player'));
    return `${this.host.hero.classId}|${actor?.id ?? ''}|${learned.join(',')}|${JSON.stringify([equipment['main-hand'], equipment['off-hand']])}`;
  }

  allySkillSignatureNow(member: CompanionMember): string {
    const learned = [...learnedSkillIds(this.host.battleCatalog, member.classId, member.skills)].sort();
    const equipment = this.host.hero.bag.equipmentItems(this.host.hero.bag.equipmentFor(member.id));
    return `${member.classId}|${learned.join(',')}|${JSON.stringify([equipment['main-hand'], equipment['off-hand']])}`;
  }

  /** 廉价门控：只比版本号和背包修订号，不克隆技能配置、不序列化装备。 */
  playerSkillGateNow(): string {
    return `${this.host.hero.classId}|${this.host.skills.version}|${this.host.skills.resetVersion}|${this.host.hero.bag.revision}`;
  }

  allySkillGateNow(member: CompanionMember): string {
    return `${member.classId}|${member.definition.actor}|${member.skills.version}|${member.level}|${this.host.hero.bag.revision}`;
  }

  clearFailureForMissingSkill(owner: string): void {
    if ((this.skillAssetFailures.get(owner)?.attempts ?? 0) >= SKILL_ASSET_MAX_ATTEMPTS) {
      this.skillAssetFailures.delete(owner);
    }
  }

  recordPreparedAlly(id: string, learned: ReadonlySet<string>, signature: string, gate: string): void {
    this.preparedSkillIds.set(id, learned);
    this.allySkillSignatures.set(id, signature);
    this.allySkillGates.set(id, gate);
  }

  forgetAllySignature(id: string): void {
    this.allySkillSignatures.delete(id);
  }

  forgetAlly(id: string): void {
    this.allySkillSignatures.delete(id);
    this.allySkillGates.delete(id);
    this.releaseSkillLeases(id);
  }

  releaseSkillLeases(owner: string): void {
    const leases = this.extraSkillLeases.get(owner);
    for (const lease of leases ?? []) lease.release();
    this.extraSkillLeases.delete(owner);
    this.skillAssetFailures.delete(owner);
    this.preparedSkillIds.delete(owner);
  }

  private addSkillLease(owner: string, lease: AssetLease): void {
    const leases = this.extraSkillLeases.get(owner);
    this.extraSkillLeases.set(owner, [lease]);
    for (const previous of leases ?? []) previous.release();
    this.host.onReleaseAllyVisualLease(owner);
  }

  private retryReady(owner: string, signature: string): boolean {
    const failure = this.skillAssetFailures.get(owner);
    if (!failure) return true;
    if (failure.signature !== signature) return true;
    if (failure.attempts >= SKILL_ASSET_MAX_ATTEMPTS) return false;
    return this.host.now >= failure.nextAt;
  }

  private recordSkillAssetFailure(owner: string, signature: string, error: unknown): void {
    if (this.host.isClosed()) return;
    const previous = this.skillAssetFailures.get(owner);
    const attempts = (previous?.signature === signature ? previous.attempts : 0) + 1;
    const delay = Math.min(SKILL_ASSET_RETRY_BASE_MS * 2 ** (attempts - 1), SKILL_ASSET_RETRY_MAX_MS);
    this.skillAssetFailures.set(owner, { attempts, nextAt: this.host.now + delay, signature });
    if (attempts === 1 || attempts === SKILL_ASSET_MAX_ATTEMPTS) {
      const party = this.host.party();
      const member = owner === 'player' ? this.host.hero : party?.get(owner);
      const configuration = owner === 'player' ? this.host.skills : (member as CompanionMember | undefined)?.skills;
      globalThis.storyDiagnostics?.record('skill-asset-refresh-failed', {
        owner,
        classId: member?.classId,
        signature,
        attempts,
        skills: member && configuration ? [...learnedSkillIds(this.host.battleCatalog, member.classId, configuration)] : [],
        error: String(error),
        cause: error instanceof Error ? String(error.cause ?? '') : undefined,
      });
    }
    this.scheduleSkillAssetRetry();
  }

  private scheduleSkillAssetRetry(): void {
    if (this.host.isClosed() || this.skillAssetRetryTimer) return;
    let next = Infinity;
    const party = this.host.party();
    for (const [owner, failure] of this.skillAssetFailures) {
      if (owner !== 'player' && !party?.activeIds.includes(owner)) {
        this.skillAssetFailures.delete(owner);
        continue;
      }
      if (failure.attempts < SKILL_ASSET_MAX_ATTEMPTS) next = Math.min(next, failure.nextAt);
    }
    if (!Number.isFinite(next)) return;
    const delay = Math.max(0, next - this.host.now);
    this.skillAssetRetryTimer = this.host.scheduleDelayed(delay, () => {
      this.skillAssetRetryTimer = undefined;
      this.scheduleRefresh();
    });
  }

  scheduleRefresh(): void {
    if (this.host.isClosed() || !this.host.hero || !this.host.playerActor() || !this.host.skills) return;
    const playerGate = this.playerSkillGateNow();
    const playerGateChanged = playerGate !== this.playerSkillGate;
    const playerSignature = playerGateChanged ? this.playerSkillSignatureNow() : this.playerSkillSignature;
    let playerChanged = playerGateChanged && playerSignature !== this.playerSkillSignature;
    // 只是拾取/数量变化这类不改变装备签名的门控变化：直接推进门控，不补载。
    if (playerGateChanged && !playerChanged) this.playerSkillGate = playerGate;
    if (playerChanged && !this.retryReady('player', playerSignature)) playerChanged = false;

    const allyTargets: AllyRefreshTarget[] = [];
    const party = this.host.party();
    for (const id of this.host.activeParty()) {
      if (id === 'player') continue;
      const member = party?.get(id);
      if (!member) continue;
      const gate = this.allySkillGateNow(member);
      if (gate === this.allySkillGates.get(id)) continue;
      const signature = this.allySkillSignatureNow(member);
      if (signature === this.allySkillSignatures.get(id)) {
        this.allySkillGates.set(id, gate);
        continue;
      }
      if (!this.retryReady(id, signature)) continue;
      allyTargets.push({ id, member, signature, gate });
    }
    if (!playerChanged && !allyTargets.length) {
      this.scheduleSkillAssetRetry();
      return;
    }
    if (this.skillAssetRefreshRunning) {
      this.skillAssetRefreshQueued = true;
      return;
    }
    this.host.onBeforeRefresh();
    this.skillAssetRefreshRunning = true;
    void this.refreshSkillAssets(playerChanged ? playerSignature : undefined, playerGate, allyTargets).finally(() => {
      this.skillAssetRefreshRunning = false;
      if (this.skillAssetRefreshQueued) {
        this.skillAssetRefreshQueued = false;
        this.scheduleRefresh();
      }
    });
  }

  async prepareInitialPlayer(): Promise<void> {
    await this.refreshSkillAssets(this.playerSkillSignatureNow(), this.playerSkillGateNow(), []);
  }

  async prepareRestoredSkills(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const activeParty = this.host.activeParty();
    const partyStamp = activeParty.join('|');
    const party = this.host.party();
    const signature = this.playerSkillSignatureNow();
    const gate = this.playerSkillGateNow();
    const allies = activeParty
      .filter(id => id !== 'player')
      .map(id => {
        const member = party!.get(id)!;
        return { id, member, signature: this.allySkillSignatureNow(member), gate: this.allySkillGateNow(member) };
      });
    await this.refreshSkillAssets(signature, gate, allies);
    signal?.throwIfAborted();
    if (this.host.isClosed()) throw new Error('战斗场景已关闭');
    const currentParty = this.host.party();
    if (
      this.host.activeParty().join('|') !== partyStamp ||
      this.playerSkillSignatureNow() !== signature ||
      this.playerSkillSignature !== signature ||
      !this.extraSkillLeases.has('player') ||
      allies.some(
        value =>
          currentParty?.get(value.id) !== value.member ||
          this.allySkillSignatureNow(value.member) !== value.signature ||
          this.allySkillSignatures.get(value.id) !== value.signature ||
          !this.extraSkillLeases.has(value.id),
      )
    ) {
      throw new Error('恢复技能素材失败或队伍已改变，请重试');
    }
  }

  async refreshSkillAssets(
    playerSignature: string | undefined,
    playerGate: string,
    allies: readonly AllyRefreshTarget[],
  ): Promise<void> {
    const catalog = this.host.battleCatalog;
    if (playerSignature !== undefined) {
      try {
        const actor = this.host.playerActor();
        if (actor) {
          const learned = learnedSkillIds(catalog, this.host.hero.classId, this.host.skills);
          const plan = playerCombatAssets({
            catalog,
            wardrobe: this.host.wardrobe,
            items: this.host.items,
            hero: this.host.hero,
            actor,
            learnedSkills: learned,
          });
          const lease = await loadSceneAssets(this.host.phaserScene, plan, {});
          try {
            await this.host.preparePlayerAppearance();
          } catch (error) {
            lease.release();
            throw error;
          }
          if (this.host.isClosed()) {
            lease.release();
            return;
          }
          if (this.playerSkillSignatureNow() === playerSignature) {
            this.addSkillLease('player', lease);
            this.preparedSkillIds.set('player', learned);
            this.playerSkillSignature = playerSignature;
            this.playerSkillGate = playerGate;
            this.skillAssetFailures.delete('player');
          } else {
            lease.release();
            this.skillAssetRefreshQueued = true;
          }
        }
      } catch (error) {
        if (!this.host.isClosed() && this.playerSkillSignatureNow() === playerSignature) {
          this.recordSkillAssetFailure('player', playerSignature, error);
        }
      }
    }
    for (const { id, member, signature, gate } of allies) {
      try {
        if (this.host.isClosed()) return;
        const party = this.host.party();
        if (party?.get(id) !== member || !party?.activeIds.includes(id)) continue;
        const actor = this.host.actorForMember(id, member);
        if (!actor) continue;
        const learned = learnedSkillIds(catalog, member.classId, member.skills);
        const plan = partyMemberCombatAssets(catalog, this.host.wardrobe, member.classId, actor, learned, {
          items: this.host.items,
          equipment: this.host.hero.bag.equipmentItems(this.host.hero.bag.equipmentFor(id)),
        });
        const lease = await loadSceneAssets(this.host.phaserScene, plan, {});
        if (this.host.isClosed()) {
          lease.release();
          return;
        }
        const liveParty = this.host.party();
        if (liveParty?.get(id) !== member || !liveParty?.activeIds.includes(id)) {
          lease.release();
          continue;
        }
        if (this.allySkillSignatureNow(member) === signature) {
          try {
            await this.host.preparePartyMember(id, undefined, { full: true });
          } catch (error) {
            lease.release();
            throw error;
          }
          if (this.host.isClosed()) {
            lease.release();
            return;
          }
          const latestParty = this.host.party();
          if (
            latestParty?.get(id) !== member ||
            !latestParty?.activeIds.includes(id) ||
            this.allySkillSignatureNow(member) !== signature
          ) {
            lease.release();
            this.skillAssetRefreshQueued = true;
            continue;
          }
          this.addSkillLease(id, lease);
          this.recordPreparedAlly(id, learned, signature, gate);
          this.skillAssetFailures.delete(id);
        } else {
          lease.release();
          this.skillAssetRefreshQueued = true;
        }
      } catch (error) {
        const currentParty = this.host.party();
        if (
          !this.host.isClosed() &&
          currentParty?.get(id) === member &&
          currentParty.activeIds.includes(id) &&
          this.allySkillSignatureNow(member) === signature
        ) {
          this.recordSkillAssetFailure(id, signature, error);
        }
      }
    }
  }

  dispose(): void {
    for (const leases of this.extraSkillLeases.values()) {
      for (const lease of leases) lease.release();
    }
    this.extraSkillLeases.clear();
    this.preparedSkillIds.clear();
    this.skillAssetRetryTimer?.remove(false);
    this.skillAssetRetryTimer = undefined;
    this.playerSkillSignature = '';
    this.playerSkillGate = '';
    this.allySkillSignatures.clear();
    this.allySkillGates.clear();
    this.skillAssetFailures.clear();
  }
}
