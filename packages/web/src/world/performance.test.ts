import { describe, expect, it } from 'vitest';

import { SustainedFrameRateMonitor } from './performance';

describe('world renderer frame-rate monitor', () => {
  it('offers degradation only after consecutive active low-fps samples', () => {
    const monitor = new SustainedFrameRateMonitor({
      thresholdFps: 50,
      consecutiveSamples: 3,
      minimumRedrawnFrames: 10,
    });

    expect(monitor.observe({ fps: 42, framesRedrawn: 60 })).toBe(false);
    expect(monitor.observe({ fps: 41, framesRedrawn: 60 })).toBe(false);
    expect(monitor.observe({ fps: 40, framesRedrawn: 60 })).toBe(true);
  });

  it('ignores idle samples and resets the streak after recovery', () => {
    const monitor = new SustainedFrameRateMonitor({
      thresholdFps: 50,
      consecutiveSamples: 2,
      minimumRedrawnFrames: 10,
    });

    expect(monitor.observe({ fps: 0, framesRedrawn: 0 })).toBe(false);
    expect(monitor.observe({ fps: 40, framesRedrawn: 60 })).toBe(false);
    expect(monitor.observe({ fps: 58, framesRedrawn: 60 })).toBe(false);
    expect(monitor.observe({ fps: 40, framesRedrawn: 60 })).toBe(false);
    expect(monitor.observe({ fps: 39, framesRedrawn: 60 })).toBe(true);
  });

  it('can be reset when the projection changes', () => {
    const monitor = new SustainedFrameRateMonitor({
      thresholdFps: 50,
      consecutiveSamples: 2,
      minimumRedrawnFrames: 10,
    });
    expect(monitor.observe({ fps: 40, framesRedrawn: 60 })).toBe(false);
    monitor.reset();
    expect(monitor.observe({ fps: 40, framesRedrawn: 60 })).toBe(false);
  });
});
