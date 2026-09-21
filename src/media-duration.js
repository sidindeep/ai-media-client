function safeDuration(value) {
  return Number.isFinite(value) && value > 0 && value <= 86400 ? value : null;
}

function uint64(buffer, offset) {
  const high = buffer.readUInt32BE(offset);
  const low = buffer.readUInt32BE(offset + 4);
  const value = high * 0x100000000 + low;
  return Number.isSafeInteger(value) ? value : null;
}

function mp4Boxes(buffer, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) { size = uint64(buffer, offset + 8); header = 16; }
    else if (size === 0) size = end - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > end) break;
    boxes.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  return boxes;
}

function mp4HeaderDuration(buffer, header) {
  if (!header || header.start + 20 > header.end) return null;
  const version = buffer[header.start];
  const timescaleOffset = header.start + (version === 1 ? 20 : 12);
  const durationOffset = timescaleOffset + 4;
  const durationBytes = version === 1 ? 8 : 4;
  if (![0, 1].includes(version) || durationOffset + durationBytes > header.end) return null;
  const timescale = buffer.readUInt32BE(timescaleOffset);
  const duration = version === 1 ? uint64(buffer, durationOffset) : buffer.readUInt32BE(durationOffset);
  return timescale && duration !== null ? safeDuration(duration / timescale) : null;
}

function mp4Duration(buffer) {
  const moov = mp4Boxes(buffer, 0, buffer.length).find(box => box.type === 'moov');
  if (!moov) return null;
  const children = mp4Boxes(buffer, moov.start, moov.end);
  const durations = [mp4HeaderDuration(buffer, children.find(box => box.type === 'mvhd'))];
  for (const trak of children.filter(box => box.type === 'trak')) {
    const mdia = mp4Boxes(buffer, trak.start, trak.end).find(box => box.type === 'mdia');
    if (!mdia) continue;
    durations.push(mp4HeaderDuration(buffer, mp4Boxes(buffer, mdia.start, mdia.end).find(box => box.type === 'mdhd')));
  }
  const valid = durations.filter(duration => duration !== null);
  return valid.length ? Math.max(...valid) : null;
}

function ebmlSize(buffer, offset) {
  if (offset >= buffer.length) return null;
  const first = buffer[offset];
  let length = 1, marker = 0x80;
  while (length <= 8 && !(first & marker)) { marker >>= 1; length++; }
  if (length > 8 || offset + length > buffer.length) return null;
  let value = first & (marker - 1);
  for (let index = 1; index < length; index++) value = value * 256 + buffer[offset + index];
  return Number.isSafeInteger(value) ? { value, length } : null;
}

function findEbmlValue(buffer, id) {
  const offset = buffer.indexOf(id);
  if (offset < 0) return null;
  const size = ebmlSize(buffer, offset + id.length);
  if (!size || size.value < 1 || size.value > 8) return null;
  const start = offset + id.length + size.length;
  return start + size.value <= buffer.length ? buffer.subarray(start, start + size.value) : null;
}

function webmDuration(buffer) {
  const scaleBytes = findEbmlValue(buffer, Buffer.from([0x2a, 0xd7, 0xb1]));
  const durationBytes = findEbmlValue(buffer, Buffer.from([0x44, 0x89]));
  if (!durationBytes || ![4, 8].includes(durationBytes.length)) return null;
  let scale = 1000000;
  if (scaleBytes) {
    scale = 0;
    for (const byte of scaleBytes) scale = scale * 256 + byte;
  }
  const duration = durationBytes.length === 4 ? durationBytes.readFloatBE(0) : durationBytes.readDoubleBE(0);
  return safeDuration(duration * scale / 1000000000);
}

function mediaDurationSeconds(bytes, type = '') {
  const buffer = Buffer.from(bytes);
  if (/^video\/(?:mp4|quicktime)$/i.test(type) || buffer.toString('ascii', 4, 8) === 'ftyp') return mp4Duration(buffer);
  if (/^video\/(?:webm|x-matroska)$/i.test(type) || buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return webmDuration(buffer);
  return null;
}

module.exports = { mediaDurationSeconds, mp4Duration, webmDuration };
