export interface FrameRateSample {
  fps: number;
  framesRedrawn: number;
}

export interface FrameRatePolicy {
  thresholdFps: number;
  consecutiveSamples: number;
  minimumRedrawnFrames: number;
}

export const DEFAULT_FRAME_RATE_POLICY: FrameRatePolicy = {
  thresholdFps: 50,
  consecutiveSamples: 4,
  minimumRedrawnFrames: 15,
};

/**
 * Turns deck.gl's one-second metrics into a sustained-performance decision.
 * Idle samples do not count: a static globe that needed no redraw is not a slow
 * globe, and treating its zero frames as one would offer degradation at rest.
 */
export class SustainedFrameRateMonitor {
  private lowSamples = 0;

  public constructor(private readonly policy = DEFAULT_FRAME_RATE_POLICY) {}

  public observe({ fps, framesRedrawn }: FrameRateSample): boolean {
    if (!Number.isFinite(fps) || framesRedrawn < this.policy.minimumRedrawnFrames) return false;

    if (fps >= this.policy.thresholdFps) {
      this.lowSamples = 0;
      return false;
    }

    this.lowSamples += 1;
    return this.lowSamples >= this.policy.consecutiveSamples;
  }

  public reset(): void {
    this.lowSamples = 0;
  }
}
