import type { SessionState } from '../domain/session.ts';

/** 调试标记的存储格式版本；旧标记只在版本一致时恢复。 */
export const DEBUG_MARK_VERSION = 1;

export interface DebugMarkSummary {
  name: string;
  savedAt: number;
  classId?: string;
  map?: string;
}
export interface DebugMark {
  version: typeof DEBUG_MARK_VERSION;
  summary: DebugMarkSummary;
  session: SessionState;
  world?: unknown;
  taskReturn?: { quest: string; session: SessionState; world?: unknown };
}
/** 摘要分页不读取现场正文；覆盖须将两者放在同一事务。 */
export interface DebugMarkStore {
  put(mark: DebugMark): Promise<void>;
  get(name: string): Promise<DebugMark | undefined>;
  list(offset?: number, limit?: number): Promise<DebugMarkSummary[]>;
  delete(name: string): Promise<void>;
}
