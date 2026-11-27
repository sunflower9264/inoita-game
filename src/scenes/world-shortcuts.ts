import type { StoryContext } from '../application/ports.ts';
import type { Cooldown } from '../domain/combat.ts';
import type { ItemResult } from '../domain/items.ts';
import type { CompanionMember } from '../domain/party.ts';
import type { RecoveryResult } from '../domain/recovery-items.ts';
import { ShortcutBar, type ShortcutEntry } from '../domain/shortcut-bar.ts';
import { type SkillConfiguration } from '../domain/skill-configuration.ts';
import type { ShortcutSlot } from '../ui/hud/action-controls.ts';

export interface WorldShortcutCombatPort {
  readonly controlledId: string;
  readonly controlledMember?: {
    readonly classId: string;
    readonly player: { readonly mana: number };
    readonly skills?: SkillConfiguration;
  };
  readonly cooldowns: Readonly<Record<string, Cooldown>>;
  skillShortcutState(id: string, level: number): { cost: number; enabled: boolean } | undefined;
  attack(skillId?: string): void;
  useRecoveryItem(entryId: string, memberId?: string): RecoveryResult;
}

export interface WorldShortcutHost {
  readonly app: Pick<StoryContext, 'session' | 'battleCatalog' | 'items' | 'ui'>;
  readonly canControl: boolean;
  readonly hudReady: boolean;
  setShortcutPage(slots: readonly ShortcutSlot[]): void;
  combat(): WorldShortcutCombatPort | undefined;
  revivePartyMember(id: string, item: string): ItemResult;
}

interface ShortcutPageCache {
  configuration: SkillConfiguration;
  version: number;
  bagRevision: number;
  owner: string;
  classId: string;
  page: number;
  entries: (ShortcutEntry | null)[];
  levels: Record<string, number>;
  slotsSignature?: string;
}

/**
 * 统一管理世界快捷栏的页码缓存、签名去重、按键释放与消耗品触发，
 * 保证触摸轮盘与键盘技能行在同一逻辑帧只读取一次冷却与背包快照。
 */
export class WorldShortcutController {
  private readonly host: WorldShortcutHost;
  private pageCache?: ShortcutPageCache;
  private lastTick?: number;

  constructor(host: WorldShortcutHost) {
    this.host = host;
  }

  reset(): void {
    this.pageCache = undefined;
    this.lastTick = undefined;
  }

  /** 当前操控者、它的技能配置与当前技能组。快捷栏与 HUD 都按这一份读。 */
  private controlledContext() {
    const session = this.host.app.session;
    const combat = this.host.combat();
    const member = combat?.controlledMember ?? session?.hero;
    if (!session || !member) return undefined;
    const owner = combat?.controlledId ?? 'player';
    const configuration = owner === 'player' ? session.skills : (member as CompanionMember).skills;
    return { member, owner, configuration, page: configuration.shortcutPage(member.classId) };
  }

  /** 某位成员的十二格快捷栏。技能与物品共用同一排槽，见 `domain/shortcut-bar.ts`。 */
  private shortcutBar(owner: string, classId: string, configuration: SkillConfiguration): ShortcutBar {
    const bag = this.host.app.session.bag;
    return ShortcutBar.for(
      bag,
      owner,
      configuration.activeSkills(this.host.app.battleCatalog, classId),
      owner === 'player' ? bag.catalog.startingShortcut : undefined,
    );
  }

  /** 一格快捷位要画什么：技能看图标、起手条件与冷却，物品看图标、数量与恢复冷却。 */
  private shortcutSlot(
    entry: ShortcutEntry | null,
    mana: number,
    level: number,
    cooldowns: Readonly<Record<string, Cooldown>>,
  ): ShortcutSlot {
    const app = this.host.app;
    if (!entry) return { entry: null, quantity: 0, enabled: false };
    const combat = this.host.combat();
    if (entry.kind === 'skill') {
      const state = combat?.skillShortcutState(entry.id, level);
      return {
        entry,
        icon: app.battleCatalog.skills[entry.id]?.icon,
        quantity: 0,
        enabled: !!state?.enabled && mana >= (state?.cost ?? 0),
        cooldown: cooldowns[entry.id],
      };
    }
    const item = app.items.items[entry.id];
    const quantity = app.session.bag.count(entry.id);
    return {
      entry,
      icon: item?.icon,
      quantity,
      enabled: quantity > 0,
      cooldown: item?.use?.kind === 'recover-health' ? app.session.recovery.cooldown : undefined,
    };
  }

  /**
   * 统一战斗 HUD 绘制入口：一次取好冷却快照和快捷页数据，再分别交给触摸轮盘与键盘技能行。
   */
  refreshCombatHud(cooldowns?: Readonly<Record<string, Cooldown>>): void {
    if (!this.host.hudReady) return;
    const context = this.controlledContext();
    if (!context) return;
    cooldowns ??= this.host.combat()?.cooldowns ?? {};
    const { battleCatalog, session } = this.host.app;
    const { member, owner, configuration, page } = context;
    let cache = this.pageCache;
    if (
      !cache ||
      cache.configuration !== configuration ||
      cache.version !== configuration.version ||
      cache.bagRevision !== session.bag.revision ||
      cache.owner !== owner ||
      cache.classId !== member.classId ||
      cache.page !== page
    ) {
      const entries = this.shortcutBar(owner, member.classId, configuration).page(page);
      const levels = configuration.draft(battleCatalog, member.classId).levels;
      cache = {
        configuration,
        version: configuration.version,
        bagRevision: session.bag.revision,
        owner,
        classId: member.classId,
        page,
        entries,
        levels,
      };
      this.pageCache = cache;
    }
    const slots = cache.entries.map(entry => this.shortcutSlot(entry, member.player.mana, cache.levels[entry?.id ?? ''] ?? 0, cooldowns));
    const slotsSignature = slots
      .map(s => s.entry ? `${s.entry.kind}:${s.entry.id}:${s.quantity}:${s.enabled ? 1 : 0}:${s.cooldown?.remainingMs ?? 0}/${s.cooldown?.durationMs ?? 0}` : '_')
      .join('|');
    if (cache.slotsSignature === slotsSignature) return;
    cache.slotsSignature = slotsSignature;
    this.host.setShortcutPage(slots);
  }

  /** 战斗逻辑帧推进后统一画一次；同一 tick 内重复调用直接跳过。 */
  refreshIfTickChanged(): void {
    const tick = this.host.app.session?.combatTick;
    if (tick === undefined || this.lastTick === tick) return;
    this.lastTick = tick;
    this.refreshCombatHud();
  }

  /** 事件驱动路径：换人、换页、背包或快捷位变化后立即绘制，不等战斗时钟。 */
  refreshLoadout(): void {
    this.refreshCombatHud(this.host.combat()?.cooldowns ?? {});
  }

  /** 数字键放当前轮组的快捷位；格子里是物品就用物品，是技能就放技能。 */
  triggerSlot(slot: number): void {
    if (!this.host.canControl) return;
    const context = this.controlledContext();
    if (!context) return;
    const { member, owner, configuration, page } = context;
    const entry = this.shortcutBar(owner, member.classId, configuration).page(page)[slot - 1];
    if (!entry) return;
    if (entry.kind === 'item') this.useItem(entry.id);
    else this.host.combat()?.attack(entry.id);
  }

  /** 切组按钮与 Q 键共用同一条路径。 */
  cyclePage(): void {
    if (!this.host.canControl) return;
    const context = this.controlledContext();
    if (!context) return;
    const { member, configuration } = context;
    configuration.nextShortcutPage(member.classId);
    this.refreshLoadout();
  }

  /** 点消耗品格：恢复药水走整队恢复，复活卷轴按上阵顺序复活，其它物品走普通使用。 */
  useItem(itemId: string): void {
    if (!this.host.canControl) return;
    const { app } = this.host;
    const bag = app.session.bag;
    const entry = bag.entries.find(value => value.item === itemId);
    if (!entry) return;
    const kind = app.items.items[entry.item].use?.kind;
    if (kind === 'revive') {
      const party = app.session.party;
      if (!party) return;
      if (!party.livingIds.length) {
        app.ui.showInstant('全队阵亡时无法使用复活卷轴，请返回检查点或读取存档。');
        return;
      }
      const target = party.activeIds.find(id => !party.alive(id));
      if (!target) {
        app.ui.showInstant('当前没有阵亡的出战队员');
        return;
      }
      try {
        this.host.revivePartyMember(target, entry.id);
      } catch (error) {
        app.ui.showInstant((error as Error).message);
      }
      return;
    }
    if (kind === 'recover-health' || kind === 'regenerate') {
      this.host.combat()?.useRecoveryItem(entry.id);
      return;
    }
    try {
      bag.use(entry.id);
    } catch (error) {
      app.ui.showInstant((error as Error).message);
    }
  }
}
