/**
 * The **Pen-test finding** issue form (.github/ISSUE_TEMPLATE/pen-test-finding.yml): its
 * headings and labels, read from the form itself, and an issue body in the shape GitHub
 * renders a submitted form (`### <heading>` then the answer). Used to check the form, and to
 * file findings from a script with exactly the shape the form gives.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TEMPLATE = fileURLToPath(
  new URL('../.github/ISSUE_TEMPLATE/pen-test-finding.yml', import.meta.url),
);

export interface FindingForm {
  name: string;
  labels: string[];
  /** The headings of the form's fields, in order. */
  headings: string[];
}

/** Reads the form's name, labels and field headings (only the YAML this form uses). */
export function readFindingForm(text = readFileSync(TEMPLATE, 'utf8')): FindingForm {
  const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  const labelList = /^labels:\s*\[(.*)\]\s*$/m.exec(text)?.[1] ?? '';
  const labels = labelList
    .split(',')
    .map((label) => label.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  // Field headings: `label:` under each body item's attributes (six spaces in).
  const headings = [...text.matchAll(/^ {6}label:\s*(.+)$/gm)].map((m) => m[1]!.trim());
  return { name, labels, headings };
}

/** An issue body as GitHub renders the submitted form; every heading must be answered. */
export function renderFinding(answers: Record<string, string>, form = readFindingForm()): string {
  return form.headings
    .map((heading) => {
      const answer = answers[heading]?.trim();
      if (!answer) throw new Error(`The finding has no answer for "${heading}"`);
      return `### ${heading}\n\n${answer}`;
    })
    .join('\n\n');
}
