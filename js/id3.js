// ID3v2 (v2.2 / v2.3 / v2.4) タグからタイトル・アーティスト・アルバム・ジャケット画像を読み取る

export async function readTags(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};

  const ver = head[3];
  const flags = head[5];
  const size = syncsafe(head, 6);
  let buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
  if (flags & 0x80 && ver < 4) buf = unsync(buf);

  let pos = 0;
  if (flags & 0x40 && ver >= 3) pos = ver === 4 ? syncsafe(buf, 0) : u32(buf, 0) + 4;

  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  const tags = {};

  while (pos + hdrLen <= buf.length) {
    const id = String.fromCharCode(...buf.subarray(pos, pos + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break; // パディング領域に到達

    const len =
      ver === 2 ? (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5]
      : ver === 4 ? syncsafe(buf, pos + 4)
      : u32(buf, pos + 4);
    let data = buf.subarray(pos + hdrLen, pos + hdrLen + len);
    if (ver === 4) {
      const fmt = buf[pos + 9];
      if (fmt & 0x02) data = unsync(data);
      if (fmt & 0x01) data = data.subarray(4); // データ長インジケータ
    }
    pos += hdrLen + len;

    switch (id) {
      case 'TIT2': case 'TT2': tags.title = readText(data); break;
      case 'TPE1': case 'TP1': tags.artist = readText(data); break;
      case 'TALB': case 'TAL': tags.album = readText(data); break;
      case 'APIC': case 'PIC':
        if (!tags.picture) tags.picture = readPicture(data, ver);
        break;
    }
  }
  return tags;
}

function syncsafe(b, o) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function u32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function unsync(b) {
  const out = new Uint8Array(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) {
    out[j++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function readText(data) {
  if (!data.length) return '';
  // v2.4 では複数値が NUL 区切りで入ることがあるので先頭のみ使う
  return decode(data.subarray(1), data[0]).split('\0')[0].trim();
}

function decode(bytes, enc) {
  switch (enc) {
    case 1:
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
      return new TextDecoder('utf-16le').decode(bytes);
    case 2:
      return new TextDecoder('utf-16be').decode(bytes);
    case 3:
      return new TextDecoder('utf-8').decode(bytes);
    default:
      // 本来は ISO-8859-1 だが、日本語の古いタグは Shift_JIS や UTF-8 で書かれていることが多い
      if (bytes.every((c) => c < 0x80)) return new TextDecoder('ascii').decode(bytes);
      for (const label of ['utf-8', 'shift_jis']) {
        try {
          return new TextDecoder(label, { fatal: true }).decode(bytes);
        } catch { /* 次の候補へ */ }
      }
      return new TextDecoder('windows-1252').decode(bytes);
  }
}

function readPicture(data, ver) {
  const enc = data[0];
  let pos;
  let mime;
  if (ver === 2) {
    const fmt = String.fromCharCode(...data.subarray(1, 4)).toLowerCase();
    mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
    pos = 4;
  } else {
    const end = data.indexOf(0, 1);
    if (end < 0) return null;
    mime = String.fromCharCode(...data.subarray(1, end)).toLowerCase();
    if (mime === '-->') return null; // URL リンク形式は非対応
    if (!mime.includes('/')) mime = 'image/' + (mime === 'png' ? 'png' : 'jpeg');
    if (mime === 'image/jpg') mime = 'image/jpeg';
    pos = end + 1;
  }
  pos += 1; // 画像タイプ
  pos = skipString(data, pos, enc); // 説明文
  if (pos >= data.length) return null;
  return new Blob([data.slice(pos)], { type: mime });
}

function skipString(d, pos, enc) {
  if (enc === 1 || enc === 2) {
    while (pos + 1 < d.length && (d[pos] || d[pos + 1])) pos += 2;
    return pos + 2;
  }
  const end = d.indexOf(0, pos);
  return end < 0 ? d.length : end + 1;
}
