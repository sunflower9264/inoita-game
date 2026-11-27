import { UiNode, UiImage } from './dom/node.ts';
import { skillForGrowth, memberSkillGrowth } from '../domain/battle.ts';
import { ShortcutBar, type ShortcutEntry } from '../domain/shortcut-bar.ts';
import type { StoryUIContext } from '../application/ports.ts';
import type { Session } from '../domain/session.ts';
import type { WorldIndex } from '../domain/content.ts';
import type { CompanionMember } from '../domain/party.ts';
import type { SkillLearningProgression } from '../domain/skill-learning.ts';
import type { BattleClass, SkillLoadout } from '../domain/battle.ts';
import { GOLD, UiSurface, type ScrollArea } from './widgets.ts';
import { MenuTextLayer, type MenuTextSpec } from './dom/menu-text.ts';
import { drawDescriptionSeparator } from './panels/description-panel.ts';
import { drawSolidBorder } from './panels/solid-border.ts';
import { MENU_FRAME_MODAL_HEIGHT, MENU_FRAME_MODAL_WIDTH } from './panels/modal-placement.ts';
import { layoutDescriptionTextForSurface } from './panels/description-text.ts';
import { DESCRIPTION_PANEL } from './bag-layout.ts';
import { SKILL_PREVIEW_COLORS, skillDescriptionParts, skillLearningParts, skillNextLevelPreview } from './skill-detail-lines.ts';
import type { DescriptionTextPart } from '../domain/description-text.ts';
import { TEXT_COLORS } from './text-style.ts';

const AI_FREQUENCY_LABELS=['不使用','一般','高'] as const;
const AI_FREQUENCY_ASSETS=['skill-level-none','skill-level-normal','skill-level-high'] as const;
interface SkillsPageHost {
  readonly selectedMemberId:string;
  readonly active:boolean;
  readonly body:UiSurface|undefined;
  readonly modal:UiSurface|undefined;
  readonly menuText:MenuTextLayer|undefined;
  readonly scrollNames:Map<string,ScrollArea>;
  readonly scrollOffsets:Map<string,number>;
  notice:string;
  isBusy():boolean;
  acknowledge():void;
  clearKeyboardFocus():void;
  drawPartyColumn(view:UiSurface):void;
  scroll(name:string,x:number,y:number,width:number,height:number,surface?:UiSurface,bleed?:number):ScrollArea;
  finishScroll(name:string,scroll:ScrollArea,height:number):void;
  beginModal(width:number,height:number):void;
  sync():void;
  openShortcut(kind:ShortcutEntry['kind'],id:string):void;
  clearShortcut(kind:ShortcutEntry['kind'],id:string):void;
}

/** 技能目录、自动使用频率、学习与初始化由固定会话的页面持有。 */
export class SkillsPage {
  private readonly app:Pick<StoryUIContext,'menuPanels'|'battleCatalog'>;
  private readonly session:Session;
  private readonly world:WorldIndex;
  private readonly host:SkillsPageHost;
  private busy=false;
  private skill?:string;
  private skillSection:'directory'|'ai'|'settings'='directory';
  private skillReset=false;
  private skillTextSpecs:MenuTextSpec[]=[];
  private skillResetTextSpecs:MenuTextSpec[]=[];
  private skillContentNodes:UiNode[]=[];
  private skillAsideNodes:UiNode[]=[];
  private skillAsideKeys=new Set<string>();
  private skillCells=new Map<string,{button:UiNode;level:number;marker?:UiImage;levelNodes?:UiImage[]}>();
  private skillTabs=new Map<string,UiNode>();
  constructor(app:Pick<StoryUIContext,'menuPanels'|'battleCatalog'>,session:Session,world:WorldIndex,host:SkillsPageHost){this.app=app;this.session=session;this.world=world;this.host=host;}
  get isBusy():boolean{return this.busy;}
  get confirming():boolean{return this.skillReset;}
  get mounted():boolean{return this.skillTabs.size>0;}
  get textSpecs():readonly MenuTextSpec[]{return this.skillTextSpecs;}
  get confirmationTextSpecs():readonly MenuTextSpec[]{return this.skillResetTextSpecs;}
  resetMember():void{this.skill=undefined;this.skillSection='directory';}
  cancel():void{this.skillReset=false;}
  closeConfirmation():void{this.cancel();this.updateSkillResetModal();}
  destroy():void{this.cancel();this.skillContentNodes=[];this.skillAsideNodes=[];this.skillCells.clear();this.skillTabs.clear();this.skillTextSpecs=[];this.skillResetTextSpecs=[];}
  private get selectedMemberId():string{return this.host.selectedMemberId;}
  private get menuBusy():boolean{return this.busy||this.host.isBusy();}

  private addSkillText(key:string,text:string,x:number,y:number,size:number,color=GOLD,anchorX=0,anchorY=0,
    style:Partial<MenuTextSpec['style']>={},extras:Pick<MenuTextSpec,'scroll'|'clip'>={}):void{
    this.skillTextSpecs.push({key,text,x,y,style:{size,color,anchorX,anchorY,...style},...extras});
  }
  private addDescriptionText(keyPrefix:string,layout:{lines:{runs:{text:string;color?:string;x:number}[]}[];lineHeight:number},
    x:number,top:number,width:number,size:number,scroll:string,clip:{top:number;bottom:number},baseY=0):void{
    this.pushDescriptionText(this.skillTextSpecs,keyPrefix,layout,x,top,width,size,scroll,clip,baseY);
  }
  private pushDescriptionText(target:MenuTextSpec[],keyPrefix:string,
    layout:{lines:{runs:{text:string;color?:string;x:number}[]}[];lineHeight:number},
    x:number,top:number,width:number,size:number,scroll:string,clip:{top:number;bottom:number},baseY=0):void{
    layout.lines.forEach((line,lineIndex)=>line.runs.forEach((run,runIndex)=>{
      target.push({key:`${keyPrefix}-${lineIndex}-${runIndex}`,text:run.text,
        x:x+run.x,y:top+baseY+lineIndex*layout.lineHeight,
        style:{size,color:run.color??TEXT_COLORS.white,width,
          lineHeight:layout.lineHeight,wrap:'word'},scroll,clip});
    }));
  }
  private descriptionLayout(view:UiSurface,parts:readonly DescriptionTextPart[],width:number,size:number):
    {lines:{runs:{text:string;color?:string;x:number}[]}[];lineHeight:number;height:number}{
    return layoutDescriptionTextForSurface(view,parts,width,size);
  }
  renderSkills():void{
    this.skillTextSpecs=[];this.skillTabs.clear();this.skillCells.clear();
    const v=this.host.body!,panels=this.app.menuPanels;
    // 原版技能页也只调 `UI_DrawBorderRect`（`UISkill_Draw @0x163e6c`），左栏与右栏的标题条、
    // 内容区各是一块图框；面板里露出的是黑色 65% 遮罩下的世界画面。
    v.border(panels.assets,85,0,409,431);drawSolidBorder(v,panels.assets,537,0,409,53);v.border(panels.assets,537,53,409,378);
    this.host.drawPartyColumn(v);
    (['directory','ai','settings'] as const).forEach((section,index)=>{const button=v.button('',486,38+index*118,46,118,()=>{if(this.skillSection===section)return;this.skillSection=section;const detail=this.host.scrollNames.get('description');if(detail)detail.scrollTop=0;this.host.scrollOffsets.delete('skills:description');this.updateSkillsMember();},{image:panels.assets[`skill-tab-${section}`],disabled:section!=='directory'&&(!this.session!.party||(section==='settings'&&!this.skillProgression()))}).setData('label',{directory:'技能目录',ai:'AI 设置',settings:'设置'}[section]);this.skillTabs.set(section,button);});
    this.renderSkillContent();
  }
  private renderSkillContent():void{
    const v=this.host.body!,before=new Set(v.root.list),member=this.member()!,panels=this.app.menuPanels,configuration=this.configuration(),character=this.app.battleCatalog.classes.find(value=>value.id===member.classId)!;
    if(this.skillSection==='settings'&&!this.skillProgression())this.skillSection='directory';
    this.skill??=character.skills[0];if(!character.skills.includes(this.skill))this.skill=character.skills[0];
    const draft=configuration.draft(this.app.battleCatalog,member.classId),progression=this.skillProgression();
    if(this.skillSection==='directory')this.renderSkillDirectory(character,draft);
    else if(this.skillSection==='ai')this.renderSkillAi(character,draft);
    else this.renderSkillSettings();
    this.addSkillText('skills-header',progression?`${panels.character.labels.skillPoints} ${progression.points()}`
      :'伙伴技能',561,14,19,GOLD,0,0,
      {width:350,wrap:'word',lineHeight:24});
    const beforeAside=new Set(v.root.list),textStart=this.skillTextSpecs.length;
    this.renderSkillAside(draft,progression);
    this.skillAsideNodes=v.root.list.filter(node=>!beforeAside.has(node));
    this.skillAsideKeys=new Set(this.skillTextSpecs.slice(textStart).map(spec=>spec.key));
    this.skillContentNodes=v.root.list.filter(node=>!before.has(node));
  }
  private renderSkillDirectory(character:BattleClass,draft:SkillLoadout):void{
    const v=this.host.body!,panels=this.app.menuPanels;
    // 选中框画在格内 (-14,-14) 并要与格子一起滚动，所以留它一条 16 像素的裁剪外扩，
    // 否则第一列与第一行的圆环会被滚动区切成缺边的「C」形。
    // 可视区收进左框内沿：原版滚动区是 (21,18,374,394)，内容组再左内缩 10。这里把滚动原点
    // 移到 (116,24)（相对原可视区右移 10、下移 6），再用 16 的裁剪外扩；下沿正好停在底框上沿，
    // 内容不会盖住列标题和底框。
    const tree=this.host.scroll('directory',116,24,364,367,this.host.body!,16);
    // 列标题原来是 72×17 的烘焙文字图，改成 DOM 后不再发虚。
    panels.skillColumns.forEach((column,index)=>this.skillTextSpecs.push({
      key:`skill-column-${index}`,text:column.label,x:116+1+index*91+36,y:24+8.5,
      style:{size:14,color:'#9a9a9a',anchorX:.5,anchorY:.5},scroll:'directory',clip:{top:24,bottom:391}
    }));
    character.skills.forEach((id,index)=>{
      const entry=this.app.battleCatalog.skills[id],position=panels.skillPositions[index]!,level=draft.levels[id]??0;
      const button=v.button('',position.column*91,20+position.row*89,75,75,()=>this.selectSkill(id),{image:entry.icon,parent:tree.content,guard:tree.guard}).setData('label',entry.name);
      button.addAt(v.image(panels.assets['skill-slot'],-9,-9,93,93,button),0);
      // 未学习：原版在图标之上叠一张 75×75 的黑色半透明椭圆（图组 17 索引 11，已导出为
      // `skill-locked`），既没有等级底图也没有数字；已学习才画 17/15 的底图与图组 15 的等级数字
      // （`UISkill_SkillDrawIcon @0x162a2c`：底图在格内 +(57,51)、数字在 +(63,57)）。
      const levelNodes:UiImage[]=[];
      if(!level)levelNodes.push(v.image(panels.assets['skill-locked'],0,0,75,75,button));
      else levelNodes.push(v.image(panels.assets['skill-rank'],57,51,24,25,button),v.image(panels.assets[`skill-rank-${level}`],63,57,10,13,button));
      // 选中框有两张：图组 17 索引 17 在大圆环之外还包住右下角的等级圈，索引 20 只有干净的大圆环。
      // 原版 `UISkill_DrawSkillGrid @0x1628e8` 按格子状态二选一，且与 `UISkill_SkillDrawIcon
      // @0x162c0c` 画等级底图读的是同一个动作记录位，所以两张图永远与格子一致——没有等级圈的
      // 格子用带角标的那张，右下角就会凭空多出一团亮斑。
      const marker=id===this.skill?v.image(panels.assets[level?'skill-selected':'skill-selected-ai'],-14,-14,106,102,button):undefined;
      this.skillCells.set(id,{button,level,marker,levelNodes});
    });
    this.host.finishScroll('directory',tree,Math.max(...panels.skillPositions.map(p=>20+p.row*89+75)));
  }
  private renderSkillAi(character:BattleClass,draft:SkillLoadout):void{
    const v=this.host.body!,panels=this.app.menuPanels,party=this.session!.party!;
    const list=this.host.scroll('ai',116,24,364,367,this.host.body!,16);
    // AI 页只有两列主动技能；第三张是目录页的「被动技能」标题，原版这里只画前两个。
    panels.skillColumns.slice(0,2).forEach((column,index)=>this.skillTextSpecs.push({
      key:`skill-ai-column-${index}`,text:column.label,x:116+1+index*182+36,y:24+8.5,
      style:{size:14,color:'#9a9a9a',anchorX:.5,anchorY:.5},scroll:'ai',clip:{top:24,bottom:391}
    }));
    // 两列之间与右列外侧的压暗分隔条。颜色与原版压暗带相同（RGB 111,111,111），但**不是**
    // `panels/round-band.ts` 那条：这里是没有圆角件的 37 宽直条，不透明度也直接按 0–255 给
    // （30/255），而 `drawRoundBand` 的强度是 0–100 且带四角图。别把它们当成同一元件合并。
    v.rect(19,39,37,487,0x6f6f6f,30/255,list.content);v.rect(201,39,37,397,0x6f6f6f,30/255,list.content);
    character.skills.slice(0,9).forEach((id,index)=>{
      const position=panels.skillPositions[index]!,entry=this.app.battleCatalog.skills[id]!,level=draft.levels[id]??0;
      const x=position.column*182,y=20+position.row*89;
      const cell=v.button('',x,y,75,75,()=>this.selectSkill(id),{image:level?entry.icon:panels.assets['skill-locked'],parent:list.content,guard:list.guard}).setData('label',entry.name);
      cell.addAt(v.image(panels.assets['skill-slot'],-9,-9,93,93,cell),0);
      const marker=id===this.skill?v.image(panels.assets['skill-selected-ai'],-14,-14,106,102,cell):undefined;
      this.skillCells.set(id,{button:cell,level,marker});
      if(!level)return;
      const frequency=party.aiFrequency(this.selectedMemberId).get(id)??1;
      const frequencyButton=v.button('',x+85,y+16,82,42,()=>{
        if(this.menuBusy)return;
        const current=party.aiFrequency(this.selectedMemberId).get(id)??1;
        const next=(current+1)%AI_FREQUENCY_LABELS.length;
        this.busy=true;
        try{party.setAiFrequency(this.selectedMemberId,id,next);}
        catch(error){this.host.notice=(error as Error).message;this.host.menuText?.renderPage('skills');return;}
        finally{this.busy=false;}
        (frequencyButton.getData('face') as UiImage|undefined)?.load(panels.assets[AI_FREQUENCY_ASSETS[next]!]);
        frequencyButton.setData('label',`${entry.name}自动使用频率 ${AI_FREQUENCY_LABELS[next]}`);
        this.host.acknowledge();
      },{image:panels.assets[AI_FREQUENCY_ASSETS[frequency]!],pressed:panels.assets['skill-level-pressed'],native:true,parent:list.content,guard:list.guard})
        .setData('label',`${entry.name}自动使用频率 ${AI_FREQUENCY_LABELS[frequency]}`);
    });
    this.host.finishScroll('ai',list,Math.max(20+5*89+75,20+2*178+75));
  }
  private renderSkillSettings():void{
    const v=this.host.body!,labels=this.app.menuPanels.skillPanel.labels,x=85+(409-257)/2,y=(431-63)/2;
    v.button('',x,y,257,63,()=>{this.skillReset=true;this.updateSkillResetModal();}).setData('label',labels.resetButton);
    this.addSkillText('skills-reset',labels.resetButton,x+257/2,y+63/2,22,GOLD,.5,.5);
  }
  private renderSkillAside(draft:SkillLoadout,progression:SkillLearningProgression|undefined):void{
    if(this.skillSection==='settings')return;
    const v=this.host.body!,panels=this.app.menuPanels,
      skill=skillForGrowth(this.app.battleCatalog.skills[this.skill!]!,memberSkillGrowth(this.selectedMemberId)),
      level=draft.levels[skill.id]??0,
      companion=this.selectedMemberId==='player'?undefined:this.session!.party?.get(this.selectedMemberId),
      mercenary=companion?.source==='mercenary',
      naturalCap=companion&&!mercenary?companion.snapshot().skillCaps[skill.id]:undefined,
      unlocked=companion?companion.skills.unlockedState()[skill.id]!==undefined:false,
      maximum=companion?(mercenary?companion.skills.normalMaximum(skill.id,this.app.battleCatalog):unlocked?skill.ranks.length:Math.max(naturalCap??0,level)):skill.normalMaxLevel;
    // AI 页未掌握的格子只保留选中状态，右侧说明区清空（原版 UISkill_AIMainExe 调 UIDesc_SetOff）。
    if(this.skillSection==='ai'&&level===0)return;
    const detailHeight=this.skillSection==='ai'?342:279;
    const detail=this.host.scroll('description',565,71,353,detailHeight);
    const clip={top:71,bottom:71+detailHeight};
    // 说明正文按现有断行结果落字；滚动时 DOM 层按 `description` 的偏移重算位置。
    const descriptionParts=skillDescriptionParts(skill,level,mercenary?(maximum?skill.ranks.length:undefined):companion?maximum:undefined,
      mercenary&&maximum?maximum:undefined);
    if(mercenary&&!maximum)descriptionParts.splice(1,0,{text:'该佣兵未开放此技能\n'});
    const description=this.descriptionLayout(v,descriptionParts,353,22);
    this.addDescriptionText('skill-desc',description,565,71,353,22,'description',clip);
    let y=description.height;
    if(this.skillSection==='ai'){this.host.finishScroll('description',detail,y);return;}
    if(level<maximum&&skill.ranks[level]){
      drawDescriptionSeparator(v,0,y+5,353,detail.content);y+=20;
      const learning=this.descriptionLayout(v,skillLearningParts(skill.name,level,progression?.learningRequirements(skill.id),
        companion&&!progression?companion.skills.nextAutomaticLevel(skill.id):undefined),353,22);
      this.addDescriptionText('skill-learn',learning,565,71,353,22,'description',clip,y);
      y+=learning.height+12;
      skillNextLevelPreview(skill.ranks,level,skill.kind,maximum,skill.display).forEach((row,index)=>{
        const center=353/2,labelColor=row.kind==='mana'?SKILL_PREVIEW_COLORS.mana:TEXT_COLORS.white,valueColor=row.kind==='mana'?SKILL_PREVIEW_COLORS.mana:SKILL_PREVIEW_COLORS.changed;
        this.addSkillText(`skill-preview-${index}-label`,row.label,565+center,71+y,19,labelColor,.5,0,{}, {scroll:'description',clip});
        const valuesY=71+y+26;
        this.addSkillText(`skill-preview-${index}-from`,row.from,565+center-12,valuesY,19,valueColor,1,0,{}, {scroll:'description',clip});
        v.image(panels.assets['skill-compare-arrow'],center-10.5,y+25,21,24,detail.content);
        this.addSkillText(`skill-preview-${index}-to`,row.to,565+center+12,valuesY,19,valueColor,0,0,{}, {scroll:'description',clip});
        y+=52;
      });
    }
    this.host.finishScroll('description',detail,y);
    // 底部两枚按钮按原版：学习（学习就是升级，立即扣点，条件不足时禁用）与快捷键（主动技能才有，
    // 已学习才可用，已在当前快捷组里时换成「取消快捷键」）。三张图是 `UISkill_SetDescMenu @0x164488`
    // 的 subID 16／17／18，字已经印在图里，所以按钮不画文字，标签只留给键盘与调试。
    const menu=DESCRIPTION_PANEL.menu,rowX=537+menu.x,rowY=menu.y;
    const buttons:{image:string;label:string;disabled?:boolean;run:()=>void}[]=[];
    if(progression){
      const cost=progression.learningRequirements(skill.id).cost,problem=progression.learningProblem(skill.id);
      buttons.push({image:panels.assets['skill-learn'],label:cost?`学习 ${cost}`:'学习',disabled:!!problem,
        run:()=>this.learnSkill(progression,skill.id)});
    }
    // 「快捷键」进登记那一屏，「取消快捷键」直接把这门技能从两组里清掉——原版也是两枚按钮两个回调
    // （`UISkill_ButtonShortcutExe 0x164660` 与 `UISkill_ButtonRemoveShortcutExe 0x1645f8`）。
    if(skill.kind==='active'){
      const assigned=level>0&&this.shortcutBar().assigned('skill',skill.id);
      buttons.push({image:panels.assets[assigned?'skill-shortcut-cancel':'skill-shortcut'],
        label:assigned?'取消快捷键':'快捷键',disabled:level===0,
        run:()=>assigned?this.host.clearShortcut('skill',skill.id):this.host.openShortcut('skill',skill.id)});
    }
    const start=menu.offsets[Math.min(buttons.length,3)]??0;
    buttons.forEach((button,index)=>{
      // 命中区是 125×55，但原图是 149×75、按原版落在 (x−12, y−9) 且不缩放，所以自己摆：
      // 常态图垫在最下面，按下层用 `pressedRect` 落到同一处。
      const hit=v.button('',rowX+start+index*menu.button.stride,rowY,menu.button.width,menu.button.height,button.run,
        {bare:true,pressed:panels.assets['skill-button-pressed'],pressedRect:{x:-12,y:-9,width:149,height:75},disabled:button.disabled}).setData('label',button.label);
      hit.addAt(v.image(button.image,-12,-9,149,75,hit),0);
    });
  }
  private updateSkillResetModal():void{
    if(!this.host.modal||!this.host.active)return;
    this.host.modal.clear();
    if(this.skillReset)this.renderSkillResetConfirmation();
    this.host.menuText?.renderPage('skills');
    this.host.sync();
  }
  renderSkillResetConfirmation():void{
    const v=this.host.modal!,panels=this.app.menuPanels,memberId=this.selectedMemberId,progression=this.skillProgression();
    if(!progression)return;
    this.skillResetTextSpecs=[];
    const add=(key:string,text:string,x:number,y:number,size:number,width:number):void=>{
      this.skillResetTextSpecs.push({key,text,x,y,style:{size,color:GOLD,width,wrap:'word'}});
    };
    const button=(key:string,text:string,x:number,y:number,width:number,height:number):void=>{
      this.skillResetTextSpecs.push({key,text,x:x+width/2,y:y+height/2,
        style:{size:Math.min(22,height*.42),color:GOLD,anchorX:.5,anchorY:.5}});
    };
    this.host.beginModal(MENU_FRAME_MODAL_WIDTH,MENU_FRAME_MODAL_HEIGHT);v.visible(true);v.frame(panels.assets,0,0,MENU_FRAME_MODAL_WIDTH,MENU_FRAME_MODAL_HEIGHT,1);
    add('skill-reset-title',`确定为${this.actor().name}初始化技能点？`,35,30,26,648);
    add('skill-reset-description',memberId==='player'?'清空已学技能与快捷栏，返还正常加点的技能点。':
      '清空已学技能与快捷栏，返还正常加点的技能点。技能书提升会清除，解锁资格保留。',35,91,22,648);
    v.button('',270,350,170,48,()=>{this.skillReset=false;this.updateSkillResetModal();}).setData('label','取消');
    button('skill-reset-cancel','取消',270,350,170,48);
    v.button('',480,350,190,48,()=>{
      if(this.menuBusy)return;
      if(this.selectedMemberId!==memberId||this.skillProgression()!==progression){this.skillReset=false;this.updateSkillResetModal();return;}
      this.busy=true;
      try{this.session!.batchNotifications(()=>progression.reset());this.skillReset=false;}
      catch(error){this.host.notice=(error as Error).message;}
      finally{this.busy=false;}
      const header=this.skillTextSpecs.find(spec=>spec.key==='skills-header');
      if(header)header.text=`${panels.character.labels.skillPoints} ${progression.points()}`;
      this.host.acknowledge();this.updateSkillResetModal();
    }).setData('label','确定');
    button('skill-reset-confirm','确定',480,350,190,48);
  }
  private learnSkill(progression:SkillLearningProgression,id:string):void{
    if(this.menuBusy)return;this.busy=true;
    try{progression.learn(id);}catch(error){this.host.notice=(error as Error).message;}
    finally{this.busy=false;}
    const cell=this.skillCells.get(id),level=progression.level(id),v=this.host.body!;
    if(cell&&cell.level!==level&&cell.levelNodes){
      cell.levelNodes.forEach(node=>node.destroy());cell.levelNodes=[];cell.level=level;
      const assets=this.app.menuPanels.assets;
      if(!level)cell.levelNodes.push(v.image(assets['skill-locked'],0,0,75,75,cell.button));
      else cell.levelNodes.push(v.image(assets['skill-rank'],57,51,24,25,cell.button),v.image(assets[`skill-rank-${level}`],63,57,10,13,cell.button));
      cell.marker?.destroy();cell.marker=v.image(assets[level?'skill-selected':'skill-selected-ai'],-14,-14,106,102,cell.button);
    }
    const header=this.skillTextSpecs.find(spec=>spec.key==='skills-header');
    if(header)header.text=`${this.app.menuPanels.character.labels.skillPoints} ${progression.points()}`;
    this.host.acknowledge();this.refreshSkillAside(false);
  }
  private selectSkill(id:string):void{
    if(this.skill===id)return;
    const previous=this.skill?this.skillCells.get(this.skill):undefined;
    previous?.marker?.destroy();
    if(previous)previous.marker=undefined;
    this.skill=id;
    const current=this.skillCells.get(id),v=this.host.body!;
    if(current){
      const asset=this.skillSection==='ai'||!current.level?'skill-selected-ai':'skill-selected';
      current.marker=v.image(this.app.menuPanels.assets[asset],-14,-14,106,102,current.button);
    }
    this.refreshSkillAside(true);
  }
  refreshSkillAside(resetScroll:boolean):void{
    const v=this.host.body!;
    for(const node of this.skillAsideNodes)node.destroy();
    const detail=this.host.scrollNames.get('description');
    if(detail){
      if(!resetScroll)this.host.scrollOffsets.set('skills:description',detail.scrollTop);
      detail.destroy();this.host.scrollNames.delete('description');
      const index=v.scrolls.indexOf(detail);if(index>=0)v.scrolls.splice(index,1);
    }
    if(resetScroll)this.host.scrollOffsets.delete('skills:description');
    this.skillTextSpecs=this.skillTextSpecs.filter(spec=>!this.skillAsideKeys.has(spec.key));
    const before=new Set(v.root.list),textStart=this.skillTextSpecs.length,member=this.member()!;
    const draft=this.configuration().draft(this.app.battleCatalog,member.classId);
    this.renderSkillAside(draft,this.skillProgression());
    this.skillAsideNodes=v.root.list.filter(node=>!before.has(node));
    this.skillAsideKeys=new Set(this.skillTextSpecs.slice(textStart).map(spec=>spec.key));
    this.skillContentNodes=this.skillContentNodes.filter(node=>node.active).concat(this.skillAsideNodes);
    v.pruneDestroyed();this.host.menuText?.renderPage('skills');
  }
  updateSkillsMember():void{
    const v=this.host.body!;
    this.skillCells.clear();
    for(const node of this.skillContentNodes)node.destroy();this.skillContentNodes=[];
    for(const [name,scroll] of this.host.scrollNames){
      this.host.scrollOffsets.set(`skills:${name}`,scroll.scrollTop);scroll.destroy();
      const index=v.scrolls.indexOf(scroll);if(index>=0)v.scrolls.splice(index,1);
    }
    this.host.scrollNames.clear();v.pruneDestroyed();this.host.clearKeyboardFocus();this.skillTextSpecs=[];
    for(const [section,button] of this.skillTabs)button.getData('setEnabled')?.(section==='directory'||!!this.session!.party&&(section!=='settings'||!!this.skillProgression()));
    this.renderSkillContent();this.host.menuText?.renderPage('skills');
  }
  private shortcutBar():ShortcutBar {
    const bag=this.session.bag;
    return ShortcutBar.for(bag,this.selectedMemberId,this.configuration().activeSkills(this.app.battleCatalog,this.member()!.classId),this.selectedMemberId==='player'?bag.catalog.startingShortcut:undefined);
  }
  private member(){return this.selectedMemberId==='player'?this.session!.hero:this.session!.party?.get(this.selectedMemberId);}
  private actor(){const member=this.member();return this.world!.actors[this.selectedMemberId==='player'?this.session!.campaign.start.actor:(member as CompanionMember).definition.actor];}
  private configuration(){return this.selectedMemberId==='player'?this.session!.skills:(this.member() as CompanionMember).skills;}
  private skillProgression():SkillLearningProgression|undefined {
    if(this.selectedMemberId==='player')return this.session!.skills;
    const member=this.session!.party?.get(this.selectedMemberId);
    return member?.source==='mercenary'?member.skills:undefined;
  }
}
