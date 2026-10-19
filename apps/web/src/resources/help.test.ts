import { describe, expect, it } from 'vitest';
import { browserFamily, endConsequences, feedbackReport } from './help.tsx';

describe('task guidance and private feedback', () => {
  it('describes only the resources that actually end with the session', () => {
    expect(endConsequences([{ id: 'receive' }])).toContain(
      'Files already confirmed',
    );
    expect(endConsequences([{ id: 'receive' }])).not.toContain(
      'terminal process',
    );
    const all = endConsequences([
      { id: 'cli' },
      { id: 'web' },
      { id: 'receive' },
    ]);
    expect(all).toContain('terminal process started by this session ends');
    expect(all).toContain('existing web server keeps running');
    expect(all).toContain('stay on the host');
  });
  it.each([
    ['Edg/150 Chrome/150', 'Edge'],
    ['Firefox/150', 'Firefox'],
    ['Chrome/150', 'Chrome / Chromium'],
    ['Version/19 Safari/600', 'Safari'],
    ['', 'Other'],
  ])(
    'identifies a coarse browser family without retaining the agent string',
    (agent, family) => {
      expect(browserFamily(agent)).toBe(family);
    },
  );
  it('never includes arbitrary stage text, URLs, agent extensions or invitation material', () => {
    const secret = 'synthetic-secret-project/#tm=synthetic-private-address';
    const report = feedbackReport(secret, `Chrome/154 ${secret}`);
    expect(report).toContain('Stage: unknown');
    expect(report).toContain('Browser: Chrome / Chromium');
    expect(report).not.toContain(secret);
    expect(report.split('\n')).toHaveLength(6);
    expect(feedbackReport('waiting', '')).toContain('Stage: waiting');
  });
});
