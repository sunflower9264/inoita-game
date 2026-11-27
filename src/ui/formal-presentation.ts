import type { GameUI } from './game-ui.ts';

type PresentationState=Pick<GameUI,'mode'|'ready'|'suspended'|'worldRebuildCover'|'skipBackdrop'|'loadingState'|'defeatState'|'defeated'|'choices'|'quest'|'dialogueLine'>;
export type FormalPanel='portrait'|'loading'|'defeat'|'choice'|'dialogue'|'none';

/** 只选择显示内容，不修改剧情状态，也不完成任何等待中的剧情动作。 */
export function formalPresentation(ui:PresentationState,portrait:boolean,directorCanSkip:boolean){
  const cover=ui.worldRebuildCover;
  const panel:FormalPanel=portrait?'portrait':ui.loadingState?'loading':ui.defeatState?'defeat':
    cover?'none':ui.quest?'none':ui.choices?'choice':ui.dialogueLine?'dialogue':'none';
  const occluded=portrait||!!ui.loadingState||!!ui.defeatState||cover||ui.suspended;
  const modal=portrait||!!ui.loadingState||!!ui.defeatState||cover;
  return{
    panel,occluded,
    quest:ui.mode==='game'&&!portrait&&!cover&&!ui.loadingState&&!ui.defeated?ui.quest:undefined,
    showSkip:ui.mode==='game'&&ui.ready&&!ui.suspended&&!portrait&&!cover&&!ui.loadingState&&!ui.defeated&&!ui.choices&&!ui.quest&&directorCanSkip,
    backgroundVisible:modal||ui.skipBackdrop,
    backgroundAlpha:ui.skipBackdrop?1:!!ui.defeatState&&!portrait&&!ui.loadingState&&!cover ? .65 : 1,
    blockInput:modal||ui.skipBackdrop||!!ui.quest||!!ui.dialogueLine||!!ui.choices,
  };
}
