import type { MediaField } from '../types';

const firstFrameKeys = new Set(['firstFrame', 'first_frame', 'first_frame_url', 'first_frame_image_url', 'start_image_url']);
const lastFrameKeys = new Set(['lastFrame', 'last_frame', 'last_frame_url', 'last_frame_image_url', 'end_image_url', 'tail_image_url']);

export function frameFieldPair(fields: MediaField[]): [MediaField, MediaField] | null {
  const first = fields.find(field => firstFrameKeys.has(field.key))
    || (fields.some(field => lastFrameKeys.has(field.key)) ? fields.find(field => field.key === 'image_url') : undefined);
  const last = fields.find(field => lastFrameKeys.has(field.key));
  return first && last ? [first, last] : null;
}

export function orderedFileFields(fields: MediaField[]): MediaField[] {
  const pair = frameFieldPair(fields);
  return pair ? [...pair, ...fields.filter(field => field !== pair[0] && field !== pair[1])] : fields;
}
