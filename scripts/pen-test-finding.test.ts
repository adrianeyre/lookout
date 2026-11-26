import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TEMPLATE, readFindingForm, renderFinding } from './pen-test-finding.ts';

describe('the Pen-test finding issue form (E5)', () => {
  it('is called "Pen-test finding" and adds prd:pen-test', () => {
    const form = readFindingForm();
    expect(form.name).toBe('Pen-test finding');
    expect(form.labels).toEqual(['prd:pen-test']);
  });

  it('asks for every heading, in the PRD order', () => {
    expect(readFindingForm().headings).toEqual([
      'Scope issue',
      'H entry',
      'Configuration',
      'Rule broken (PRD requirement and ADR)',
      'Steps to reproduce',
      'Observed',
      'Expected',
      'Impact',
      'Test that would have caught it',
    ]);
  });

  it('requires every field', () => {
    const text = readFileSync(TEMPLATE, 'utf8');
    expect(text.match(/required: true/g)).toHaveLength(readFindingForm().headings.length);
  });

  it('renders a body with every heading, and refuses one with a heading missing', () => {
    const headings = readFindingForm().headings;
    const answers = Object.fromEntries(headings.map((h) => [h, `answer for ${h}`]));
    const body = renderFinding(answers);
    for (const heading of headings)
      expect(body).toContain(`### ${heading}\n\nanswer for ${heading}`);
    expect(() => renderFinding({ ...answers, Impact: '' })).toThrow('Impact');
  });
});
