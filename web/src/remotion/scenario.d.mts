import type { Scene } from './model.mjs';
export function scenarioPrompt(script: string, scenes: Scene[]): string;
export function parseScenario(output: string, sources: Scene[], makeId?: () => string): Scene[];
