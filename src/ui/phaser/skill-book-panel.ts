import type { BattleCatalog } from '../../domain/battle.ts';
import type { Bag } from '../../domain/bag.ts';
import type { DescriptionTextPart } from '../../domain/description-text.ts';
import type { MenuPanels } from '../../domain/menu-panels.ts';
import type { StorySkillProgression } from '../../domain/story-skills.ts';
import { layoutDescriptionText } from '../description-text-layout.ts';
import type { MenuTextSpec, MenuTextWriter } from '../dom/menu-text.ts';
import type { UiImage, UiNode } from '../dom/node.ts';
import { SKILL_PREVIEW_COLORS, skillDescriptionParts, skillNextLevelPreview } from '../skill-detail-lines.ts';
import { SKILL_BOOK, skillBookCell } from '../skill-book-layout.ts';
import { TEXT_COLORS } from '../text-style.ts';
import { GOLD, type ScrollArea, type UiSurface } from './widgets.ts';

type DescriptionLines = ReturnType<typeof layoutDescriptionText>;
interface DescriptionLayout { lines: DescriptionLines; lineHeight: number; height: number }
/** 面板借宿主的滚动区登记位置，滚动时 DOM 文字才能跟着内容一起移动。 */
type ScrollFactory = (view: UiSurface, name: string, x: number, y: number, width: number, height: number) => ScrollArea;

/**
 * 技能书页面：从背包点「使用」进入的独立菜单页，和强化台同级。
 *
 * 左框只列当前能升级的技能图标，右框显示所选技能当前等级、使用后的等级变化和下一级数值预览。
 * 确认后才真正消耗技能书，结算走 `Bag.use`，和背包弹层用的是同一条领域路径。
 * 文字统一交给菜单 DOM 层；图框、图标、滚动和按钮底图仍由 Phaser 画。
 */
export class SkillBookPanel {
  readonly bag: Bag;
  readonly skills: StorySkillProgression;
  readonly catalog: BattleCatalog;
  readonly panels: MenuPanels;
  readonly entryId: string;
  private readonly changed: () => void;
  private readonly sound: () => void;
  private readonly close: (message?: string) => void;
  private readonly scrollArea: ScrollFactory;
  private readonly refreshText: () => void;
  private selected?: string;
  private message = '';
  private scroll?: ScrollArea;
  private offset = 0;
  /** 这一轮绘制要显示的文字；页面重绘时按 key 复用 DOM 标签。 */
  private textSpecs: MenuTextSpec[] = [];
  private surface?:UiSurface;
  private cells=new Map<string,{button:UiNode;marker?:UiImage;rank:number;rankNodes:UiImage[]}>();
  private detailNodes:UiNode[]=[];
  private detailKeys=new Set<string>();
  private readonly updatePage?:()=>void;
  private readonly removeScroll?:(scroll:ScrollArea)=>void;

  constructor(bag: Bag, skills: StorySkillProgression, catalog: BattleCatalog, panels: MenuPanels,
    entryId: string, changed: () => void, sound: () => void, close: (message?: string) => void,
    scrollArea?: ScrollFactory, refreshText: () => void = () => {}, updatePage?:()=>void, removeScroll?:(scroll:ScrollArea)=>void) {
    this.bag = bag; this.skills = skills; this.catalog = catalog; this.panels = panels;
    this.entryId = entryId; this.changed = changed; this.sound = sound; this.close = close;
    this.scrollArea = scrollArea ?? ((view, _name, x, y, width, height) => view.scroll(x, y, width, height));
    this.refreshText = refreshText;this.updatePage=updatePage;this.removeScroll=removeScroll;
  }

  get skillIds(): string[] {
    return this.catalog.classes.find(entry => entry.id === this.bag.classId)?.skills ?? [];
  }

  /** 技能书页自己的显式状态，供页面签名使用。 */
  get viewModel(): { entryId: string; selected?: string; message: string } {
    return { entryId: this.entryId, selected: this.selected, message: this.message };
  }

  open(): void {
    this.selected = undefined; this.message = ''; this.offset = 0;
    // 绑定了具体技能的书只看那一门；普通技能书默认停在第一个可升级的技能上。
    const bound = this.bag.get(this.entryId)?.skill;
    this.selected = bound && !this.problemFor(bound) ? bound : this.nextEligible();
  }

  captureScroll(): void {
    this.offset = this.scroll?.scrollTop ?? this.offset;
  }

  /** 页面文字交给菜单 DOM 层。 */
  renderText(writer: MenuTextWriter): void {
    for (const spec of this.textSpecs) writer.add(spec);
  }

  render(v: UiSurface): void {
    const layout = SKILL_BOOK;
    this.textSpecs = [];this.surface=v;this.cells.clear();
    v.staticLayer('skill-book',()=>{
      v.border(this.panels.assets,layout.leftFrame.x,layout.leftFrame.y,layout.leftFrame.width,layout.leftFrame.height,v.staticRoot);
      v.border(this.panels.assets,layout.rightFrame.x,layout.rightFrame.y,layout.rightFrame.width,layout.rightFrame.height,v.staticRoot);
    });
    this.scroll = undefined;
    this.renderGrid(v);this.updateMarkers(v);
    this.drawDetails(v);
  }

  /** 当前能升级的技能；页面只列这些，不能升级的不出现在图标格里。 */
  private get upgradable(): string[] {
    return this.skillIds.filter(id => !this.problemFor(id));
  }

  private renderGrid(v: UiSurface): void {
    const layout=SKILL_BOOK,assets=this.panels.assets,skills=this.upgradable,old=new Map(this.cells);
    this.textSpecs=this.textSpecs.filter(spec=>spec.key!=='book-empty');
    if(!skills.length)this.textSpecs.push({key:'book-empty',text:'暂无可升级技能',x:layout.empty.x,y:layout.empty.y,
      style:{size:layout.empty.size,color:GOLD,anchorX:.5,anchorY:.5}});
    skills.forEach((id,index)=>{
      const skill=this.catalog.skills[id];if(!skill)return;
      const cellAt=skillBookCell(index),rank=this.skills.level(id);let cell=old.get(id);old.delete(id);
      if(!cell){
        const button=v.button('',cellAt.x,cellAt.y,layout.grid.size,layout.grid.size,()=>this.select(id),{image:skill.icon}).setData('label',skill.name);
        button.addAt(v.image(assets['skill-slot'],layout.slotFrame.x,layout.slotFrame.y,layout.slotFrame.width,layout.slotFrame.height,button),0);
        cell={button,rank:-1,rankNodes:[]};this.cells.set(id,cell);
      }
      cell.button.setPosition(cellAt.x,cellAt.y);
      if(cell.rank!==rank){
        cell.rankNodes.forEach(node=>node.destroy());cell.rankNodes=[];cell.rank=rank;
        if(!rank)cell.rankNodes.push(v.image(assets['skill-locked'],0,0,layout.grid.size,layout.grid.size,cell.button));
        else cell.rankNodes.push(v.image(assets['skill-rank'],layout.rank.x,layout.rank.y,layout.rank.width,layout.rank.height,cell.button),
          v.image(assets[`skill-rank-${rank}`],layout.rankDigit.x,layout.rankDigit.y,layout.rankDigit.width,layout.rankDigit.height,cell.button));
        if(cell.marker){cell.marker.destroy();cell.marker=undefined;}
      }
    });
    for(const [id,cell] of old){cell.button.destroy();this.cells.delete(id);}v.pruneDestroyed();
  }
  private drawDetails(v:UiSurface):void{
    const before=new Set(v.root.list),textStart=this.textSpecs.length;
    this.renderDetails(v);this.detailNodes=v.root.list.filter(node=>!before.has(node));
    this.detailKeys=new Set(this.textSpecs.slice(textStart).map(spec=>spec.key));
  }
  private updateMarkers(v:UiSurface):void{
    const layout=SKILL_BOOK,assets=this.panels.assets;
    for(const [id,cell] of this.cells){
      if(id===this.selected&&!cell.marker){const rank=this.skills.level(id);cell.marker=v.image(assets[rank?'skill-selected':'skill-selected-ai'],layout.selection.x,layout.selection.y,layout.selection.width,layout.selection.height,cell.button);}
      else if(id!==this.selected&&cell.marker){cell.marker.destroy();cell.marker=undefined;}
    }
  }
  private updateDetails():void{
    const v=this.surface;if(!v||!this.updatePage){this.changed();return;}
    this.updateMarkers(v);
    if(this.scroll){this.removeScroll?.(this.scroll);this.scroll.destroy();const index=v.scrolls.indexOf(this.scroll);if(index>=0)v.scrolls.splice(index,1);this.scroll=undefined;}
    for(const node of this.detailNodes)node.destroy();
    this.textSpecs=this.textSpecs.filter(spec=>!this.detailKeys.has(spec.key));
    v.pruneDestroyed();this.drawDetails(v);this.updatePage();
  }
  private renderDetails(v: UiSurface): void {
    const layout = SKILL_BOOK, skill = this.selected ? this.catalog.skills[this.selected] : undefined;
    if (!skill) {
      if (this.message) this.textSpecs.push({key: 'book-message', text: this.message,
        x: layout.title.x, y: layout.title.y,
        style: {size: 20, color: GOLD, width: layout.title.width, lineHeight: 25, wrap: 'word'}});
      this.renderButtons(v, false);
      return;
    }
    const rank = this.skills.level(skill.id), problem = this.problemFor(skill.id), entry = this.bag.get(this.entryId);
    this.textSpecs.push({key: 'book-title', text: skill.name, x: layout.title.x, y: layout.title.y,
      style: {size: layout.title.size, color: GOLD}});
    this.textSpecs.push({key: 'book-level', text: `当前等级 LV ${rank}　持有技能书 ${entry?.quantity ?? 0} 本`,
      x: layout.level.x, y: layout.level.y,
      style: {size: layout.level.size, color: TEXT_COLORS.primary, width: layout.level.width,
        lineHeight: layout.level.size + 5, wrap: 'word'}});
    this.textSpecs.push({key: 'book-status', text: problem ?? `使用技能书：LV ${rank} → ${rank + 1}`,
      x: layout.status.x, y: layout.status.y,
      style: {size: layout.status.size, color: problem ? TEXT_COLORS.danger : '#ffd75e',
        width: layout.status.width, lineHeight: layout.status.size + 5, wrap: 'word'}});
    if (this.message) this.textSpecs.push({key: 'book-message', text: this.message,
      x: layout.message.x, y: layout.message.y,
      style: {size: layout.message.size, color: '#ffd75e', width: layout.message.width,
        lineHeight: layout.message.size + 5, wrap: 'word'}});

    const scrollName = 'skill-book-description';
    const detail = this.scrollArea(v, scrollName, layout.scroll.x, layout.scroll.y,
      layout.scroll.width, layout.scroll.height);
    const clip = {top: layout.scroll.y, bottom: layout.scroll.y + layout.scroll.height};
    const description = this.descriptionLayout(v, skillDescriptionParts(skill, rank), layout.scroll.width, 20);
    this.addDescriptionText('book-desc', description, layout.scroll.x, layout.scroll.y,
      layout.scroll.width, 20, scrollName, clip);
    let y = description.height;
    if (!problem) {
      if (y) y += 8;
      const center = layout.scroll.width / 2;
      skillNextLevelPreview(skill.ranks, rank, skill.kind, skill.ranks.length, skill.display)
        .forEach((row, index) => {
          const labelColor = row.kind === 'mana' ? SKILL_PREVIEW_COLORS.mana : TEXT_COLORS.white,
            valueColor = row.kind === 'mana' ? SKILL_PREVIEW_COLORS.mana : SKILL_PREVIEW_COLORS.changed;
          this.textSpecs.push({key: `book-preview-${index}-label`, text: row.label,
            x: layout.scroll.x + center, y: layout.scroll.y + y,
            style: {size: 17, color: labelColor, anchorX: .5, anchorY: 0}, scroll: scrollName, clip});
          const valuesY = y + 24;
          this.textSpecs.push({key: `book-preview-${index}-from`, text: row.from,
            x: layout.scroll.x + center - 12, y: layout.scroll.y + valuesY,
            style: {size: 17, color: valueColor, anchorX: 1, anchorY: 0}, scroll: scrollName, clip});
          v.image(this.panels.assets['skill-compare-arrow'], center - 10.5, valuesY - 1, 21, 24, detail.content);
          this.textSpecs.push({key: `book-preview-${index}-to`, text: row.to,
            x: layout.scroll.x + center + 12, y: layout.scroll.y + valuesY,
            style: {size: 17, color: valueColor, anchorX: 0, anchorY: 0}, scroll: scrollName, clip});
          y += 48;
        });
    }
    detail.setHeight(Math.max(layout.scroll.height, y));
    detail.scrollTop = this.offset;
    detail.onScroll = () => { this.offset = detail.scrollTop; this.refreshText(); };
    this.scroll = detail;
    this.renderButtons(v, !problem && !!entry);
  }

  private renderButtons(v: UiSurface, canUse: boolean): void {
    const layout = SKILL_BOOK;
    v.button('', layout.primary.x, layout.primary.y, layout.primary.width, layout.primary.height,
      () => this.use(), { disabled: !canUse }).setData('label', '使用技能书');
    this.textSpecs.push({key: 'book-use', text: '使用技能书',
      x: layout.primary.x + layout.primary.width / 2, y: layout.primary.y + layout.primary.height / 2,
      style: {size: 20, color: GOLD, anchorX: .5, anchorY: .5}});
  }

  /** 断行和行高沿用 Phaser 版；测量用的文字当场销毁，不参与显示。 */
  private descriptionLayout(view: UiSurface, parts: readonly DescriptionTextPart[], width: number, size: number):
    DescriptionLayout {
    if (!parts.length) return {lines: [], lineHeight: 0, height: 0};
    const probe = view.text('测', 0, 0, 0, size, TEXT_COLORS.white);
    const lines = layoutDescriptionText(parts, width, text => probe.context.measureText(text).width);
    const lineHeight = probe.height + 5;
    probe.destroy();
    return {lines, lineHeight, height: Math.max(0, lines.length * lineHeight - 5)};
  }

  private addDescriptionText(prefix: string, layout: DescriptionLayout, x: number, top: number,
    width: number, size: number, scroll: string, clip: {top: number; bottom: number}): void {
    layout.lines.forEach((line, lineIndex) => line.runs.forEach((run, runIndex) => {
      this.textSpecs.push({key: `${prefix}-${lineIndex}-${runIndex}`, text: run.text,
        x: x + run.x, y: top + lineIndex * layout.lineHeight,
        style: {size, color: run.color ?? TEXT_COLORS.white, width,
          lineHeight: layout.lineHeight, wrap: 'word'}, scroll, clip});
    }));
  }

  private select(id: string): void {
    if (id === this.selected) return;
    this.selected = id; this.message = ''; this.offset = 0; this.sound(); this.updateDetails();
  }

  private use(): void {
    const id = this.selected;
    if (!id) { this.message = '请选择技能'; this.updateDetails(); return; }
    const problem = this.problemFor(id);
    if (problem || !this.bag.get(this.entryId)) {
      this.message = problem ?? '技能书已不在背包中'; this.updateDetails(); return;
    }
    try {
      const result = this.bag.use(this.entryId, undefined, id);
      this.message = result.message;
      this.sound();
    } catch (error) {
      this.message = (error as Error).message;
    }
    if (!this.bag.get(this.entryId)) { this.close(this.message); return; }
    // 还有副本就留在本页；升到顶后自动换到下一门可升级的技能，没有就显示空状态。
    if (this.problemFor(id)) this.selected = this.nextEligible();
    this.offset = 0;
    if(this.surface&&this.updatePage){this.renderGrid(this.surface);this.updateDetails();}else this.changed();
  }

  /** 绑定具体技能的书只能提升那一门；和 `Bag.use` 取 `source.skill` 优先的规则一致。 */
  private problemFor(id: string): string | undefined {
    const bound = this.bag.get(this.entryId)?.skill;
    if (bound && bound !== id) return '这本书只能提升指定的技能';
    return this.skills.bookProblem(id);
  }

  private nextEligible(): string | undefined {
    return this.skillIds.find(id => !this.problemFor(id));
  }
}
