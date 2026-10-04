function isPNG(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
    buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
}
function isJPEG(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 3 &&
    buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}
function isGIF(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 6) return false;
  const sig = buf.slice(0, 6).toString('ascii');
  return sig === 'GIF87a' || sig === 'GIF89a';
}
function isWEBP(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  return buf.slice(0, 4).toString('ascii') === 'RIFF' &&
         buf.slice(8, 12).toString('ascii') === 'WEBP';
}
function isSVG(buf) {
  if (!Buffer.isBuffer(buf)) return false;
  const text = buf.slice(0, 2048).toString('utf8').trim().toLowerCase();
  return text.startsWith('<?xml') || text.startsWith('<svg');
}

function detectImageExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (isPNG(buf)) return 'png';
  if (isJPEG(buf)) return 'jpg';
  if (isGIF(buf)) return 'gif';
  if (isWEBP(buf)) return 'webp';
  if (isSVG(buf)) return 'svg';
  return null;
}

module.exports = { detectImageExt };
