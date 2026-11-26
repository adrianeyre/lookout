/**
 * The parts of the Stageshow kit (vendored, unmodified, in ../stageshow/kit) that the demo
 * uses, imported module by module rather than through the kit's index, so only these are
 * bundled and nothing else the kit ships (its brand artwork, its icon set) reaches the page.
 */
export { Stage } from '../stageshow/kit/stage';
export { Window } from '../stageshow/kit/window';
export { useReducedMotion } from '../stageshow/kit/reduced-motion';
export type { Act } from '../stageshow/kit/act';
export type { Layout, Theme } from '../stageshow/kit/looks';
