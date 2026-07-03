/*!
 * qr.js — beroendefri QR-kod-generator (vanilla JS, ingen CDN, inget npm-beroende).
 * Byggd för Vitalisera djupdyk: visa en join-länk som QR på TV/display-vyn.
 *
 * Exponerar window.QR med:
 *   QR.encode(text, {ecLevel})           -> { version, size, mask, ecLevel, modules }
 *   QR.svg(text, {size, margin, dark, light, ecLevel}) -> SVG-sträng
 *
 * Byte-läge (UTF-8), auto-vald version (v1–v10), felkorrigering M (faller till L
 * om längden kräver det). Modulplacering, maskval (ISO-straffpoäng) och
 * format-/versionsinformation följer ISO/IEC 18004 exakt, så matrisen är identisk
 * med referensbibliotek (t.ex. node-qrcode i byte-läge).
 *
 * (c) Vitalisera. Public-safe. Ren, deterministisk kod — samma indata ger samma utdata.
 */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------------
   * Galois-fält GF(256), primitivt polynom 0x11d, generator 2.
   * ------------------------------------------------------------------------- */
  var EXP = new Array(512);
  var LOG = new Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  // Reed–Solomon-generatorpolynom av given grad (koefficienter, hög→låg grad).
  function rsGenPoly(degree) {
    var g = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(g.length + 1);
      for (var k = 0; k < next.length; k++) next[k] = 0;
      for (var j = 0; j < g.length; j++) {
        next[j] ^= g[j];                    // multiplicera med x (skift)
        next[j + 1] ^= gmul(g[j], EXP[i]);  // multiplicera med a^i
      }
      g = next;
    }
    return g;
  }

  // Räkna ut felkorrigerings-kodord för ett datablock (LFSR-polynomdivision).
  function rsEncode(data, ecLen) {
    var gen = rsGenPoly(ecLen);
    var res = new Array(ecLen);
    for (var i = 0; i < ecLen; i++) res[i] = 0;
    for (var d = 0; d < data.length; d++) {
      var factor = data[d] ^ res[0];
      res.shift();
      res.push(0);
      if (factor !== 0) {
        for (var j = 0; j < ecLen; j++) {
          res[j] ^= gmul(gen[j + 1], factor);
        }
      }
    }
    return res;
  }

  /* ---------------------------------------------------------------------------
   * Felkorrigerings-tabell (version 1–10).
   * Per (nivå, version): [ ecKodordPerBlock, [ [antalBlock, dataKodordPerBlock], ... ] ]
   * Index 0 = platshållare (ingen version 0).
   * ------------------------------------------------------------------------- */
  var EC_TABLE = {
    L: [null,
      [7, [[1, 19]]], [10, [[1, 34]]], [15, [[1, 55]]], [20, [[1, 80]]],
      [26, [[1, 108]]], [18, [[2, 68]]], [20, [[2, 78]]], [24, [[2, 97]]],
      [30, [[2, 116]]], [18, [[2, 68], [2, 69]]]],
    M: [null,
      [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]],
      [24, [[2, 43]]], [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]],
      [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]],
    Q: [null,
      [13, [[1, 13]]], [22, [[1, 22]]], [18, [[2, 17]]], [26, [[2, 24]]],
      [18, [[2, 15], [2, 16]]], [24, [[4, 19]]], [18, [[2, 14], [4, 15]]],
      [22, [[4, 18], [2, 19]]], [20, [[4, 16], [4, 17]]], [24, [[6, 19], [2, 20]]]],
    H: [null,
      [17, [[1, 9]]], [28, [[1, 16]]], [22, [[2, 13]]], [16, [[4, 9]]],
      [22, [[2, 11], [2, 12]]], [28, [[4, 15]]], [26, [[4, 13], [1, 14]]],
      [26, [[4, 14], [2, 15]]], [24, [[4, 12], [4, 13]]], [28, [[6, 15], [2, 16]]]]
  };

  // Justeringsmönstrens centrumpositioner per version (v1–v10).
  var ALIGN_POS = [null, [], [6, 18], [6, 22], [6, 26], [6, 30],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // Formatnivåbitar (för BCH-formatinformation).
  var EC_FORMAT_BIT = { L: 1, M: 0, Q: 3, H: 2 };

  var MAX_VERSION = 10;

  /* ---------------------------------------------------------------------------
   * Hjälpare
   * ------------------------------------------------------------------------- */
  function toUtf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff) {
        var hi = code, lo = str.charCodeAt(++i);
        var cp = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f));
      }
    }
    return bytes;
  }

  function charCountBits(version) {
    return version < 10 ? 8 : 16; // byte-läge: 8 bitar för v1–9, 16 för v10+
  }

  function totalDataCodewords(level, version) {
    var groups = EC_TABLE[level][version][1];
    var sum = 0;
    for (var i = 0; i < groups.length; i++) sum += groups[i][0] * groups[i][1];
    return sum;
  }

  // Antal databytes som ryms i byte-läge för en version/nivå.
  function byteCapacity(level, version) {
    var bits = totalDataCodewords(level, version) * 8;
    return Math.floor((bits - 4 - charCountBits(version)) / 8);
  }

  // Välj minsta version som rymmer datan. Föredrar M, faller till L för längd.
  function selectVersion(byteLen, preferLevel) {
    var order = preferLevel === 'M' ? ['M', 'L'] : [preferLevel];
    for (var o = 0; o < order.length; o++) {
      var lvl = order[o];
      for (var v = 1; v <= MAX_VERSION; v++) {
        if (byteLen <= byteCapacity(lvl, v)) return { version: v, level: lvl };
      }
    }
    throw new Error('QR: texten är för lång för version 1–' + MAX_VERSION +
      ' (' + byteLen + ' byte).');
  }

  /* ---------------------------------------------------------------------------
   * Bitbuffert
   * ------------------------------------------------------------------------- */
  function BitBuffer() { this.bits = []; }
  BitBuffer.prototype.put = function (num, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((num >>> i) & 1);
  };
  BitBuffer.prototype.length = function () { return this.bits.length; };

  // Bygg datakodord: header + data + terminator + padding + pad-bytes.
  function createDataCodewords(version, level, bytes) {
    var total = totalDataCodewords(level, version);
    var capBits = total * 8;
    var bb = new BitBuffer();
    bb.put(0x4, 4);                       // byte-läges-indikator
    bb.put(bytes.length, charCountBits(version));
    for (var i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);

    // Terminator (upp till 4 nollor, men inte förbi kapaciteten).
    var remaining = capBits - bb.length();
    bb.put(0, Math.min(4, remaining));

    // Fyll till hel byte.
    while (bb.length() % 8 !== 0) bb.bits.push(0);

    // Bitar -> bytes.
    var data = [];
    for (var b = 0; b < bb.bits.length; b += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | bb.bits[b + k];
      data.push(byte);
    }

    // Pad-bytes 0xEC / 0x11 tills blocket är fullt.
    var pad = [0xec, 0x11], p = 0;
    while (data.length < total) data.push(pad[(p++) % 2]);
    return data;
  }

  // Dela i block, beräkna EC, interleava data + EC (ISO-strukturen).
  function createFinalCodewords(version, level, data) {
    var info = EC_TABLE[level][version];
    var ecLen = info[0];
    var groups = info[1];
    var blocks = [];
    var offset = 0;
    for (var g = 0; g < groups.length; g++) {
      for (var n = 0; n < groups[g][0]; n++) {
        var dcount = groups[g][1];
        var dataBlock = data.slice(offset, offset + dcount);
        offset += dcount;
        blocks.push({ data: dataBlock, ec: rsEncode(dataBlock, ecLen) });
      }
    }
    var result = [];
    var maxData = 0;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].data.length > maxData) maxData = blocks[i].data.length;
    }
    for (var d = 0; d < maxData; d++) {
      for (var bi = 0; bi < blocks.length; bi++) {
        if (d < blocks[bi].data.length) result.push(blocks[bi].data[d]);
      }
    }
    for (var e = 0; e < ecLen; e++) {
      for (var bj = 0; bj < blocks.length; bj++) result.push(blocks[bj].ec[e]);
    }
    return result;
  }

  /* ---------------------------------------------------------------------------
   * BCH-kodning för format- och versionsinformation.
   * ------------------------------------------------------------------------- */
  var G15 = 0x537;        // 10100110111
  var G15_MASK = 0x5412;  // 101010000010010
  var G18 = 0x1f25;       // 1111100100101

  function bchDigit(data) {
    var d = 0;
    while (data !== 0) { d++; data >>>= 1; }
    return d;
  }

  function formatBits(level, mask) {
    var data = (EC_FORMAT_BIT[level] << 3) | mask;
    var d = data << 10;
    while (bchDigit(d) - bchDigit(G15) >= 0) {
      d ^= (G15 << (bchDigit(d) - bchDigit(G15)));
    }
    return ((data << 10) | d) ^ G15_MASK;
  }

  function versionBits(version) {
    var d = version << 12;
    while (bchDigit(d) - bchDigit(G18) >= 0) {
      d ^= (G18 << (bchDigit(d) - bchDigit(G18)));
    }
    return (version << 12) | d;
  }

  /* ---------------------------------------------------------------------------
   * Maskfunktioner (ISO/IEC 18004).
   * ------------------------------------------------------------------------- */
  function maskFn(mask, row, col) {
    switch (mask) {
      case 0: return (row + col) % 2 === 0;
      case 1: return row % 2 === 0;
      case 2: return col % 3 === 0;
      case 3: return (row + col) % 3 === 0;
      case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
      case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
      case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
      case 7: return (((row * col) % 3) + ((row + col) % 2)) % 2 === 0;
    }
    return false;
  }

  /* ---------------------------------------------------------------------------
   * Modulplacering
   * ------------------------------------------------------------------------- */
  function newMatrix(size) {
    var m = new Array(size);
    for (var r = 0; r < size; r++) {
      m[r] = new Array(size);
      for (var c = 0; c < size; c++) m[r][c] = null; // null = ledig datacell
    }
    return m;
  }

  function setupFinder(m, size, row, col) {
    for (var r = -1; r <= 7; r++) {
      if (row + r <= -1 || size <= row + r) continue;
      for (var c = -1; c <= 7; c++) {
        if (col + c <= -1 || size <= col + c) continue;
        var dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m[row + r][col + c] = dark;
      }
    }
  }

  function setupAlignment(m, size, version) {
    var pos = ALIGN_POS[version];
    if (!pos || pos.length === 0) return;
    var last = pos[pos.length - 1];
    for (var i = 0; i < pos.length; i++) {
      for (var j = 0; j < pos.length; j++) {
        var r = pos[i], c = pos[j];
        if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) {
          continue; // sammanfaller med sökmönster
        }
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            m[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          }
        }
      }
    }
  }

  function setupTiming(m, size) {
    for (var i = 8; i < size - 8; i++) {
      var bit = i % 2 === 0;
      if (m[6][i] === null) m[6][i] = bit;
      if (m[i][6] === null) m[i][6] = bit;
    }
  }

  function setupFormat(m, size, level, mask) {
    var bits = formatBits(level, mask);
    for (var i = 0; i < 15; i++) {
      var bit = ((bits >> i) & 1) === 1;
      // vertikal kopia (längs kolumn 8)
      if (i < 6) m[i][8] = bit;
      else if (i < 8) m[i + 1][8] = bit;
      else m[size - 15 + i][8] = bit;
      // horisontell kopia (längs rad 8)
      if (i < 8) m[8][size - i - 1] = bit;
      else if (i < 9) m[8][15 - i - 1 + 1] = bit;
      else m[8][15 - i - 1] = bit;
    }
    m[size - 8][8] = true; // alltid mörk modul
  }

  function setupVersion(m, size, version) {
    var bits = versionBits(version);
    for (var i = 0; i < 18; i++) {
      var bit = ((bits >> i) & 1) === 1;
      var row = Math.floor(i / 3);
      var col = (i % 3) + size - 8 - 3;
      m[row][col] = bit;
      m[col][row] = bit;
    }
  }

  function mapData(m, size, codewords, mask) {
    var inc = -1;
    var row = size - 1;
    var byteIndex = 0;
    var bitIndex = 7;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--; // hoppa över vertikala timingkolumnen
      while (true) {
        for (var c = 0; c < 2; c++) {
          var cc = col - c;
          if (m[row][cc] === null) {
            var dark = false;
            if (byteIndex < codewords.length) {
              dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
            }
            if (maskFn(mask, row, cc)) dark = !dark;
            m[row][cc] = dark;
            bitIndex--;
            if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
      }
    }
  }

  function buildMatrix(version, level, codewords, mask) {
    var size = version * 4 + 17;
    var m = newMatrix(size);
    setupFinder(m, size, 0, 0);
    setupFinder(m, size, size - 7, 0);
    setupFinder(m, size, 0, size - 7);
    setupAlignment(m, size, version);
    setupTiming(m, size);
    setupFormat(m, size, level, mask);
    if (version >= 7) setupVersion(m, size, version);
    mapData(m, size, codewords, mask);
    return m;
  }

  /* ---------------------------------------------------------------------------
   * Maskval via ISO-straffpoäng (identiskt med referensbibliotek).
   * ------------------------------------------------------------------------- */
  function penalty(m, size) {
    var points = 0;
    var i, j, k;

    // Regel 1: 5+ moduler av samma färg i rad/kolumn.
    for (i = 0; i < size; i++) {
      var runRow = 0, lastRow = null, runCol = 0, lastCol = null;
      for (j = 0; j < size; j++) {
        var vr = m[i][j] ? 1 : 0;
        if (vr === lastRow) { runRow++; }
        else { if (runRow >= 5) points += 3 + (runRow - 5); lastRow = vr; runRow = 1; }
        var vc = m[j][i] ? 1 : 0;
        if (vc === lastCol) { runCol++; }
        else { if (runCol >= 5) points += 3 + (runCol - 5); lastCol = vc; runCol = 1; }
      }
      if (runRow >= 5) points += 3 + (runRow - 5);
      if (runCol >= 5) points += 3 + (runCol - 5);
    }

    // Regel 2: 2x2-block av samma färg.
    for (i = 0; i < size - 1; i++) {
      for (j = 0; j < size - 1; j++) {
        var sum = (m[i][j] ? 1 : 0) + (m[i][j + 1] ? 1 : 0) +
          (m[i + 1][j] ? 1 : 0) + (m[i + 1][j + 1] ? 1 : 0);
        if (sum === 0 || sum === 4) points += 3;
      }
    }

    // Regel 3: mönstret 10111010000 / 00001011101 i rad/kolumn.
    for (i = 0; i < size; i++) {
      var bitsRow = 0, bitsCol = 0;
      for (j = 0; j < size; j++) {
        bitsRow = ((bitsRow << 1) & 0x7ff) | (m[i][j] ? 1 : 0);
        if (j >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points += 40;
        bitsCol = ((bitsCol << 1) & 0x7ff) | (m[j][i] ? 1 : 0);
        if (j >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points += 40;
      }
    }

    // Regel 4: andel mörka moduler.
    var dark = 0;
    for (i = 0; i < size; i++) for (j = 0; j < size; j++) if (m[i][j]) dark++;
    k = Math.abs(Math.ceil((dark * 100 / size / size) / 5) - 10);
    points += k * 10;

    return points;
  }

  /* ---------------------------------------------------------------------------
   * Publikt API
   * ------------------------------------------------------------------------- */
  function encode(text, opts) {
    opts = opts || {};
    var prefer = opts.ecLevel || 'M';
    if (!EC_TABLE[prefer]) throw new Error('QR: ogiltig ecLevel "' + prefer + '".');
    var bytes = toUtf8Bytes(String(text));
    var sel = selectVersion(bytes.length, prefer);
    var data = createDataCodewords(sel.version, sel.level, bytes);
    var codewords = createFinalCodewords(sel.version, sel.level, data);
    var size = sel.version * 4 + 17;

    // Välj bästa mask (lägst straffpoäng; jämnt fördelad tie-break mot lägre index).
    var bestMask = 0, bestScore = Infinity, bestMatrix = null;
    for (var mask = 0; mask < 8; mask++) {
      var m = buildMatrix(sel.version, sel.level, codewords, mask);
      var score = penalty(m, size);
      if (score < bestScore) { bestScore = score; bestMask = mask; bestMatrix = m; }
    }

    return {
      version: sel.version,
      ecLevel: sel.level,
      mask: bestMask,
      size: size,
      modules: bestMatrix // 2D-array av boolean (true = mörk)
    };
  }

  function svg(text, opts) {
    opts = opts || {};
    var q = encode(text, { ecLevel: opts.ecLevel });
    var count = q.size;
    var margin = opts.margin == null ? 4 : Math.max(0, opts.margin | 0);
    var dim = count + margin * 2;
    var dark = opts.dark || '#000000';
    var light = opts.light || 'transparent';

    var path = '';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (q.modules[r][c]) {
          path += 'M' + (c + margin) + ' ' + (r + margin) + 'h1v1h-1z';
        }
      }
    }

    var attrs = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim +
      '" shape-rendering="crispEdges" role="img" aria-label="QR-kod"';
    if (opts.size) attrs += ' width="' + opts.size + '" height="' + opts.size + '"';

    var bg = '';
    if (light !== 'transparent' && light !== 'none') {
      bg = '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>';
    }

    return '<svg ' + attrs + '>' + bg +
      '<path fill="' + dark + '" d="' + path + '"/></svg>';
  }

  var QR = { encode: encode, svg: svg, version: '1.0.0' };

  if (typeof module !== 'undefined' && module.exports) module.exports = QR;
  global.QR = QR;
})(typeof window !== 'undefined' ? window : this);
