import type { QuestStatus, StoryCondition, StoryEventConditionStatus, StoryWorldValue } from './content.ts';

export type { StoryCondition, StoryEventConditionStatus, StoryWorldValue } from './content.ts';

export interface StoryConditionContext {
  questStatus(id: string): QuestStatus;
  questCompletedCycles?(id: string): number;
  eventStatus(id: string): StoryEventConditionStatus;
  choice(id: string): string | undefined;
  flag(id: string): boolean;
  world(key: string): StoryWorldValue | undefined;
}

export function evaluateStoryCondition(condition: StoryCondition | undefined, context: StoryConditionContext): boolean {
  if (!condition) return true;
  switch (condition.type) {
    case 'always': return condition.value;
    case 'all': return condition.conditions.every(value => evaluateStoryCondition(value, context));
    case 'any': return condition.conditions.some(value => evaluateStoryCondition(value, context));
    case 'not': return !evaluateStoryCondition(condition.condition, context);
    case 'quest': {
      const status = context.questStatus(condition.quest);
      if (condition.status === 'accepted') return status === 'active' || status === 'ready' || status === 'completed';
      if (condition.status === 'settled') return status === 'completed' || (context.questCompletedCycles?.(condition.quest) ?? 0) > 0;
      return status === condition.status;
    }
    case 'event': return context.eventStatus(condition.event) === condition.status;
    case 'choice': return context.choice(condition.choice) === condition.value;
    case 'flag': return context.flag(condition.flag) === (condition.value ?? true);
    case 'world': return context.world(condition.key) === condition.value;
  }
}

interface StoryConditionReferences {
  quests: Set<string>;
  events: Set<string>;
  choices: Set<string>;
  flags: Set<string>;
  world: Set<string>;
}

/** Used by content validation and indexing, without evaluating a player's state. */
export function storyConditionReferences(condition: StoryCondition | undefined): StoryConditionReferences {
  const result: StoryConditionReferences = { quests: new Set(), events: new Set(), choices: new Set(), flags: new Set(), world: new Set() };
  const visit = (value: StoryCondition): void => {
    switch (value.type) {
      case 'all': case 'any': value.conditions.forEach(visit); break;
      case 'not': visit(value.condition); break;
      case 'quest': result.quests.add(value.quest); break;
      case 'event': result.events.add(value.event); break;
      case 'choice': result.choices.add(value.choice); break;
      case 'flag': result.flags.add(value.flag); break;
      case 'world': result.world.add(value.key); break;
      case 'always': break;
    }
  };
  if (condition) visit(condition);
  return result;
}
