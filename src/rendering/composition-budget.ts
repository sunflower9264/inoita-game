/** 只累计实际工作时间；等待浏览器绘制的时间不占下一段预算。 */
export class CompositionBudget {
  private started: number;
  longestMs = 0;
  constructor(privateClock: () => number = () => performance.now()) {
    this.clock = privateClock; this.started = this.clock();
  }
  private readonly clock: () => number;
  get due(): boolean { return this.clock() - this.started >= 4; }
  finish(): void { this.longestMs = Math.max(this.longestMs, this.clock() - this.started); }
  async pause(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.finish();
    await new Promise<void>((resolve, reject) => {
      const raf = typeof requestAnimationFrame === 'function';
      const done = () => { signal.removeEventListener('abort', cancel); resolve(); };
      const timer = raf ? requestAnimationFrame(done) : setTimeout(done, 0);
      const cancel = () => {
        if (raf) cancelAnimationFrame(timer as number); else clearTimeout(timer);
        signal.removeEventListener('abort', cancel); reject(signal.reason);
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
    signal.throwIfAborted(); this.started = this.clock();
  }
}
