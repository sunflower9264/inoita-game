import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { parseCampaign, parseWorld } from '../src/application/content-validation.ts';
import { Session } from '../src/domain/session.ts';

const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser'
    ? { shortCircuit: true, url: 'data:text/javascript,export default {GameObjects:{},Textures:{FilterMode:{LINEAR:1}}};' }
    : next(specifier, context);
} });
const { QuestPanel } = await import('../src/ui/phaser/quest-panel.ts');
hook.deregister();

const read = (name: string) => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const campaign = parseCampaign(read('campaign')), world = parseWorld(read('world'));

function surface() {
  const texts: string[] = [];
  const buttons: {action:()=>void;label:string;face:{file:string;load(file:string):void}}[] = [];
  const scrolls: { content: object; guard: () => boolean; setHeight(value: number): void; scrollTop: number;
    visible: boolean; onScroll?: () => void; cancelGesture(): void }[] = [];
  const text = (_value: string) => ({
    height: 20, context: { measureText: (value: string) => value.length * 10 },
    setOrigin() { return this; }, setAlign() { return this; }, destroy() {},
  });
  const view = {
    text(value: string) { texts.push(value); return text(value); },
    border() {}, image() {},
    button(_label:string,_x:number,_y:number,_w:number,_h:number,action:()=>void,options:{image:string}) {
      const row={action,label:'',face:{file:options.image,load(file:string){this.file=file;}}};buttons.push(row);
      return {setData(_key:string,value:string){row.label=value;return this;},getData(key:string){return key==='face'?row.face:undefined;}};
    },
    scroll() {
      const area = { content: {}, guard: () => true, setHeight() {}, scrollTop: 0, visible: true,
        cancelGesture() {} } as typeof scrolls[number];
      scrolls.push(area); return area;
    },
  };
  return { view, texts, scrolls, buttons };
}

test('the quest panel selects the first group and shows its detail on open', () => {
  const session = new Session(campaign);
  assert.equal(session.accept('grafton-mission'), true);
  const { view, scrolls } = surface();
  const panel = new QuestPanel(session, world, { assets: {
    'quest-row': 'row', 'quest-row-selected': 'row-selected', 'quest-row-pressed': 'row-pressed',
    'quest-main': 'main', 'quest-ready': 'ready',
  } } as never, () => {});
  panel.render(view as never);
  assert.equal(scrolls.length, 2, '列表之外还画出第一组的详情');
  const text=() => {
    const specs: {key: string; text: string}[] = [];
    panel.renderText({add: spec => specs.push(spec)});
    return specs;
  };
  assert.match(text().map(spec => spec.text).join(''), /格里普顿伯爵/);
  assert(text().some(spec => spec.key.startsWith('quest-detail-')), '详情文字同样交给 DOM 层');

  // 再次绘制（会话通知）仍保留选中；滚动收起详情后不会因为重画又自动弹出。
  panel.render(view as never);
  assert.equal(scrolls.length, 4);
  scrolls[0]!.onScroll?.();
  panel.render(view as never);
  assert.equal(scrolls.length, 5, '滚动只收起详情');
});


test('selecting a quest reuses the list and detail scroll areas',()=>{
  const progress=(status:'active')=>({status,goals:{},cycle:0,completedCycles:0});
  const session={campaign,questBook:{version:1},quests:new Map([
    ['grafton-mission',progress('active')],['cardinal-summons',progress('active')],
  ])};
  const {view,scrolls,buttons}=surface();let changes=0;
  const panel=new QuestPanel(session as never,world,{assets:{
    'quest-row':'row','quest-row-selected':'row-selected','quest-row-pressed':'pressed',
    'quest-main':'main','quest-ready':'ready',
  }} as never,()=>{changes++;});
  panel.render(view as never);
  assert.equal(buttons.length,2);assert.equal(scrolls.length,2);
  const list=scrolls[0],detail=scrolls[1];
  buttons[1]!.action();
  assert.equal(changes,0);
  assert.equal(scrolls.length,2);
  assert.equal(scrolls[0],list);assert.equal(scrolls[1],detail);
  assert.equal(buttons[0]!.face.file,'row');
  assert.equal(buttons[1]!.face.file,'row-selected');
  const specs:{key:string;text:string}[]=[];panel.renderText({add:spec=>specs.push(spec)});
  assert(specs.some(spec=>spec.key.startsWith('quest-detail-')));
});
