import { describe, expect, it } from 'vitest';
import { isSafeAnimationSourcePath } from '../../src/hoi4_agent_tools/gui/animation-manifest.js';
import { defaultPreviewScenario } from '../../src/hoi4_agent_tools/gui/scenario.js';

describe('GUI input path safety', () => {
  it('accepts only clean workspace-relative animation paths', () => {
    expect(isSafeAnimationSourcePath('hoi4_agent/animation_sources/frame-01.png')).toBe(true);
    for (const unsafe of [
      '',
      'frame\0.png',
      'frames\\frame.png',
      '/absolute/frame.png',
      'C:/absolute/frame.png',
      'frames/*.png',
      'frames//frame.png',
      'frames/../frame.png',
    ]) {
      expect(isSafeAnimationSourcePath(unsafe), unsafe).toBe(false);
    }
  });

  it('builds the complete default preview scenario', () => {
    expect(defaultPreviewScenario()).toMatchObject({
      id: 'default',
      resolution: { width: 1920, height: 1080 },
      state: 'normal',
      language: 'l_english',
    });
  });
});
