export type Scene = { id: string; kind: 'title' | 'image' | 'video'; src?: string; title: string; seconds: number; name?: string };
export const FPS: number;
export const MAX_SCENES: number;
export const MAX_SECONDS: number;
export const FORMATS: Record<'landscape' | 'portrait' | 'square', [number, number]>;
export function timeline(scenes: Scene[]): { scenes: Array<Scene & { from: number; durationInFrames: number }>; durationInFrames: number };
