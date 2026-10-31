import type { ChoiceAction, ScriptAction } from '../../src/domain/content.ts';
import type { StoryCommand, StoryNode, StoryNodeRef, StoryScript } from '../../src/domain/story-graph.ts';
import { storyExitTargets } from '../../src/domain/story-graph.ts';
import { textRuns } from '../../src/domain/text-markup.ts';

interface CampaignScripts { scripts: Record<string, StoryScript> }

/**
 * 把作者写的动作序列编成稳定节点图：连续的表现动作合成一个节点，选择与队伍变化各自占一个节点。
 * 节点 id 按编译顺序编号，所以同一份输入总是编出同一个图。
 */
export function compileScript(name: string, actions: readonly ScriptAction[]): StoryScript {
  const nodes: StoryNode[] = [];
  let serial = 0;
  const create = (presentation: StoryNode['presentation'], commands: StoryCommand[], exit: StoryNode['exit']): StoryNode => {
    const node = { id: `scene-${++serial}`, presentation, commands, exit };
    nodes.push(node); return node;
  };
  const ref = (node: string): StoryNodeRef => ({ script: name, node });
  const compile = (list: readonly ScriptAction[], tail?: StoryNodeRef): StoryNodeRef => {
    const terminal = tail ?? ref(create([], [], { type: 'end' }).id);
    let next = terminal, buffer: StoryNode['presentation'] = [];
    const flush = () => { if (buffer.length) { next = ref(create(buffer.reverse(), [], { type: 'next', target: next }).id); buffer = []; } };
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const action = list[index];
      if (action.type === 'choice') {
        flush();
        const choice = action as ChoiceAction, cases: Record<string, StoryNodeRef> = {};
        for (const option of choice.options) {
          const mark = create([], [{ type: 'flag', flag: `choice:${name}:${option.value}` }], { type: 'next', target: next });
          cases[option.value] = compile((option.lines ?? []).map(line => ({ type: 'dialogue', ...line })), ref(mark.id));
        }
        const node = create(
          [{ ...choice, options: choice.options.map(({ lines: _, ...option }) => option) }], [],
          { type: 'choice', choice: `${name}:response-${serial + 1}`, cases });
        next = ref(node.id);
      } else if (action.type === 'party-join' || action.type === 'party-leave') {
        flush(); next = ref(create([], [action], { type: 'next', target: next }).id);
      } else buffer.push(action);
    }
    flush(); return next;
  };
  const entry = compile(structuredClone(actions));
  return { entry: entry.node, nodes };
}

/** Traverses declared control flow once, preserving the first route's presentation order. */
export function storyScriptActions(campaign: Pick<CampaignScripts, 'scripts'>, name: string): StoryNode['presentation'] {
  const result: StoryNode['presentation'] = [], seen = new Set<string>();
  const visit = (reference: StoryNodeRef): void => {
    const key = JSON.stringify(reference); if (seen.has(key)) return; seen.add(key);
    const node = campaign.scripts[reference.script]?.nodes.find(n => n.id === reference.node);
    if (!node) throw new Error('剧情节点缺失：' + key);
    result.push(...node.presentation); storyExitTargets(node.exit).forEach(visit);
  };
  const script = campaign.scripts[name]; if (!script) throw new Error('剧情缺失：' + name);
  visit({ script: name, node: script.entry }); return result;
}

/** 去掉控制码之后真正显示出来的文本。 */
export function plainText(value: string): string {
  return textRuns(value).map(run => run.text).join('');
}
