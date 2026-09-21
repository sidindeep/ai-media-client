const test = require('node:test');
const assert = require('node:assert/strict');
const { mediaDurationSeconds } = require('../src/media-duration');

function box(type, payload) {
  const result = Buffer.alloc(8 + payload.length);
  result.writeUInt32BE(result.length, 0); result.write(type, 4, 4, 'ascii'); payload.copy(result, 8);
  return result;
}

function durationHeader(seconds, timescale) {
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(Math.round(seconds * timescale), 16);
  return payload;
}

function mp4(seconds, timescale = 8000, trackSeconds = null, trackTimescale = 24000) {
  const children = [box('mvhd', durationHeader(seconds, timescale))];
  if (trackSeconds !== null) children.push(box('trak', box('mdia', box('mdhd', durationHeader(trackSeconds, trackTimescale)))));
  return Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', Buffer.concat(children))]);
}

test('server reads ISO media duration without trusting browser metadata', () => {
  assert.equal(mediaDurationSeconds(mp4(18.143125), 'video/mp4'), 18.143125);
  assert.equal(mediaDurationSeconds(mp4(18.141666, 24000, 18.143125), 'video/mp4'), 18.143125);
  assert.equal(mediaDurationSeconds(mp4(10), 'video/quicktime'), 10);
  assert.equal(mediaDurationSeconds(Buffer.from('not media'), 'video/mp4'), null);
});
