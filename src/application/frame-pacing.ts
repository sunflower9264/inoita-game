/**
 * 帧率上限换算：玩家选的是「想要的帧率」，Phaser 要的是「限帧阈值」。
 *
 * Phaser 的限帧器只在累计时间越过 1000 / 上限 毫秒时才交付一帧，并把不足一帧的
 * 余量直接丢掉。阈值等于屏幕刷新率时，单帧耗时只要比 16.7 毫秒慢一点点，累积时间
 * 就反复差一丁点过不去，画面会成规律地跳到一半（实测刷新 54 次只交付 34 帧）。
 * 所以选的帧率够得着屏幕时，不再把阈值设成和屏幕一样：60 档改用 90 的数值上限，
 * 比 60Hz 高，保证每个 rAF 都能过阈值；30 档仍交给屏幕节拍（limit 0）。
 *
 * 这个判断依赖刷新率量得准。高刷屏在启动初期可能仍按 60Hz 回调，量到的值会偏低，
 * 把 120Hz 屏上的 60 上限误判成「90 上限」；所以游戏跑起来后要补测，并且只采纳
 * 样本足够且更高的结果。
 */

/** 与屏幕刷新率的距离小于这个值时，说明玩家选的值已经贴近屏幕节拍。 */
const NEAR_VSYNC_HZ = 2;
/** 60 档贴近屏幕时用的数值上限：高于 60Hz，每个屏幕节拍都能过限帧阈值。 */
const SIXTY_NEAR_VSYNC_LIMIT = 90;
export const DEFAULT_REFRESH_HZ = 60;
const SAMPLE_COUNT = 24;
const MAX_SAMPLE_MS = 700;
const FALLBACK_WAIT_MS = 1200;
/** 少于这个数量的采样不足以判断刷新率。 */
const MIN_SAMPLES = 6;
/** 刷新率的合理范围；超出说明采样被加载卡顿或前后台切换污染，丢弃不用。 */
const MIN_PLAUSIBLE_REFRESH_HZ = 20;
const MAX_PLAUSIBLE_REFRESH_HZ = 300;

/**
 * 把玩家选的帧率换算成 Phaser 的 `fps.limit`；0 表示跟随屏幕刷新率。
 *
 * `refreshHz` 必须是屏幕实际生效的刷新率，不是玩家请求的帧率：实际值只用来决定
 * 「用高一档的数值上限」还是「按数值限帧」。请求 30 时如果误传 30 而不是实际的 60，
 * 这里会返回 0，页面反而按 60 跑；请求 60 时误传 60 而不是实际的 120，会返回 90，
 * 页面跑到 90 左右。
 *
 * 60 档贴近屏幕时返回 90 而不是 0：60Hz 屏上 90 高于屏幕节拍，每个 rAF 都能过
 * 阈值，画面仍是 60 帧，同时保留一个明确的上限。
 */
export function resolveFrameLimit(chosen: number, refreshHz: number): number {
  if (chosen + NEAR_VSYNC_HZ < refreshHz) return chosen;
  return chosen === 60 ? SIXTY_NEAR_VSYNC_LIMIT : 0;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function refreshFromIntervals(intervals: number[]): number {
  const hz = 1000 / median(intervals);
  if (!Number.isFinite(hz) || hz < MIN_PLAUSIBLE_REFRESH_HZ || hz > MAX_PLAUSIBLE_REFRESH_HZ) return DEFAULT_REFRESH_HZ;
  return Math.round(hz * 2) / 2;
}

interface RefreshMeasurement {
  hz: number;
  samples: number;
}

/**
 * 量屏幕刷新率：连续记录 rAF 间隔，取中位数。最多等约 0.7 秒；页面不可见或
 * 浏览器不给 rAF 时按 60 处理。中位数能避开加载期间偶发的一两拍长间隔。
 */
function measureRefreshRateSample(
  schedule: (callback: (time: number) => void) => void,
): Promise<RefreshMeasurement> {
  return new Promise(resolve => {
    const intervals: number[] = [];
    let first = 0, last = 0, done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        hz: intervals.length >= MIN_SAMPLES ? refreshFromIntervals(intervals) : DEFAULT_REFRESH_HZ,
        samples: intervals.length,
      });
    };
    const timer = setTimeout(finish, FALLBACK_WAIT_MS);
    const tick = (time: number): void => {
      if (done) return;
      if (!first) first = time;
      if (last) intervals.push(time - last);
      last = time;
      if (intervals.length >= SAMPLE_COUNT || time - first >= MAX_SAMPLE_MS) finish();
      else schedule(tick);
    };
    // 第一拍只用来取起点；启动时的 rAF 时间戳不一定从 0 开始。
    schedule(time => {
      if (done) return;
      first = last = time;
      schedule(tick);
    });
  });
}

/** 只取刷新率数值，采样细节留给需要判断可信度的调用方。 */
export function measureRefreshRate(
  schedule: (callback: (time: number) => void) => void = callback => { requestAnimationFrame(callback); },
): Promise<number> {
  return measureRefreshRateSample(schedule).then(measurement => measurement.hz);
}

let measuredRefreshHz = DEFAULT_REFRESH_HZ;
let measuredSamples = 0;

/**
 * 合并一次测量：样本足够时才采纳，并且只接受更高的值。
 * 高刷屏启动初期可能按 60Hz 回调，后来量到 120Hz 要能覆盖；
 * 省电模式或后台重测可能给出更低值，不能反过来把已确认的高刷降下来。
 */
export function mergeRefreshRate(current: number, measured: number, samples: number): number {
  return samples >= MIN_SAMPLES ? Math.max(current, measured) : current;
}

/** 补测刷新率；样本不足的结果不覆盖已有值。量完之前按 60Hz 处理。 */
export async function detectRefreshRate(): Promise<number> {
  const measurement = await measureRefreshRateSample(callback => { requestAnimationFrame(callback); });
  if (measurement.samples >= MIN_SAMPLES) measuredSamples = measurement.samples;
  measuredRefreshHz = mergeRefreshRate(measuredRefreshHz, measurement.hz, measurement.samples);
  return measuredRefreshHz;
}

/** 样本够多才算真的量到了；页面启动时在后台会让 rAF 不跑，需要在恢复可见后补测。 */
export function refreshRateKnown(): boolean {
  return measuredSamples >= MIN_SAMPLES;
}

/** 最近一次测到的刷新率；没测过是 60。 */
export function currentRefreshRate(): number {
  return measuredRefreshHz;
}

/**
 * 壳选好显示模式后直接告诉页面屏幕刷新率，比页面自己重测更可靠。
 * 从 120Hz 切到 60Hz 时如果还按旧的 120 换算，60 上限会踩进限帧器临界区。
 */
export function setRefreshRate(hz: number): void {
  if (!Number.isFinite(hz) || hz < MIN_PLAUSIBLE_REFRESH_HZ || hz > MAX_PLAUSIBLE_REFRESH_HZ) return;
  measuredRefreshHz = Math.round(hz * 2) / 2;
  measuredSamples = SAMPLE_COUNT;
}
