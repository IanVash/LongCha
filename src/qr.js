const QR_SPECS = {
  1: { dataCodewords: 19, eccCodewords: 7, capacity: 17, align: [] },
  2: { dataCodewords: 34, eccCodewords: 10, capacity: 32, align: [6, 18] },
  3: { dataCodewords: 55, eccCodewords: 15, capacity: 53, align: [6, 22] },
  4: { dataCodewords: 80, eccCodewords: 20, capacity: 78, align: [6, 26] },
  5: { dataCodewords: 108, eccCodewords: 26, capacity: 106, align: [6, 30] }
};

const EXP = new Array(512);
const LOG = new Array(256);
let gf = 1;
for (let i = 0; i < 255; i += 1) {
  EXP[i] = gf;
  LOG[gf] = i;
  gf <<= 1;
  if (gf & 0x100) gf ^= 0x11d;
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];

function gfMul(a, b) {
  return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}

function generatorPolynomial(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data, degree) {
  const gen = generatorPolynomial(degree);
  const result = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i += 1) {
      result[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return result;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

function chooseVersion(bytes) {
  for (const [version, spec] of Object.entries(QR_SPECS)) {
    if (bytes.length <= spec.capacity) return Number(version);
  }
  throw new Error('El texto es demasiado largo para el generador QR local del MVP.');
}

function createCodewords(text) {
  const bytes = [...Buffer.from(text, 'utf8')];
  const version = chooseVersion(bytes);
  const spec = QR_SPECS[version];
  const bits = [];

  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);
  appendBits(bits, 0, Math.min(4, spec.dataCodewords * 8 - bits.length));
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(Number.parseInt(bits.slice(i, i + 8).join(''), 2));
  }
  for (let pad = 0; data.length < spec.dataCodewords; pad += 1) {
    data.push(pad % 2 === 0 ? 0xec : 0x11);
  }

  return {
    version,
    codewords: [...data, ...reedSolomon(data, spec.eccCodewords)]
  };
}

function blankMatrix(size) {
  return {
    modules: Array.from({ length: size }, () => Array(size).fill(false)),
    reserved: Array.from({ length: size }, () => Array(size).fill(false))
  };
}

function makeSetter(matrix) {
  return (row, col, value, reserve = true) => {
    if (row < 0 || col < 0 || row >= matrix.modules.length || col >= matrix.modules.length) return;
    matrix.modules[row][col] = Boolean(value);
    if (reserve) matrix.reserved[row][col] = true;
  };
}

function drawFinder(matrix, row, col) {
  const set = makeSetter(matrix);
  for (let dr = -1; dr <= 7; dr += 1) {
    for (let dc = -1; dc <= 7; dc += 1) {
      const r = row + dr;
      const c = col + dc;
      const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const black = inside && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      set(r, c, black);
    }
  }
}

function drawAlignment(matrix, centerRow, centerCol) {
  if (matrix.reserved[centerRow]?.[centerCol]) return;
  const set = makeSetter(matrix);
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const black = Math.max(Math.abs(dr), Math.abs(dc)) === 2 || (dr === 0 && dc === 0);
      set(centerRow + dr, centerCol + dc, black);
    }
  }
}

function reserveFormat(matrix) {
  const size = matrix.modules.length;
  const set = makeSetter(matrix);
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      set(8, i, false);
      set(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }
}

function drawFunctionPatterns(matrix, version) {
  const size = matrix.modules.length;
  const set = makeSetter(matrix);
  drawFinder(matrix, 0, 0);
  drawFinder(matrix, 0, size - 7);
  drawFinder(matrix, size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    if (!matrix.reserved[6][i]) set(6, i, i % 2 === 0);
    if (!matrix.reserved[i][6]) set(i, 6, i % 2 === 0);
  }

  for (const row of QR_SPECS[version].align) {
    for (const col of QR_SPECS[version].align) drawAlignment(matrix, row, col);
  }

  set(4 * version + 9, 8, true);
  reserveFormat(matrix);
}

function getFormatBits(mask) {
  const data = (0b01 << 3) | mask;
  let bits = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((bits >>> i) & 1) bits ^= 0x537 << (i - 10);
  }
  return ((data << 10) | bits) ^ 0x5412;
}

function drawFormatBits(matrix, mask) {
  const size = matrix.modules.length;
  const bits = getFormatBits(mask);
  const set = makeSetter(matrix);
  const bit = (i) => ((bits >>> i) & 1) === 1;

  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));

  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
  set(size - 8, 8, true);
}

function placeData(matrix, codewords, mask) {
  const bits = [];
  for (const codeword of codewords) appendBits(bits, codeword, 8);

  const size = matrix.modules.length;
  const set = makeSetter(matrix);
  let bitIndex = 0;
  let upward = true;
  const maskFn = (row, col) => mask === 0 && (row + col) % 2 === 0;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let c = col; c >= col - 1; c -= 1) {
        if (!matrix.reserved[row][c]) {
          let value = bits[bitIndex] === 1;
          bitIndex += 1;
          if (maskFn(row, c)) value = !value;
          set(row, c, value);
        }
      }
    }
    upward = !upward;
  }
}

export function qrSvg(text, { scale = 8, margin = 4 } = {}) {
  const { version, codewords } = createCodewords(text);
  const size = 21 + (version - 1) * 4;
  const matrix = blankMatrix(size);
  const mask = 0;
  drawFunctionPatterns(matrix, version);
  placeData(matrix, codewords, mask);
  drawFormatBits(matrix, mask);

  const moduleCount = size + margin * 2;
  const rects = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (matrix.modules[row][col]) {
        rects.push(`<rect x="${col + margin}" y="${row + margin}" width="1" height="1"/>`);
      }
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${moduleCount * scale}" height="${moduleCount * scale}" viewBox="0 0 ${moduleCount} ${moduleCount}" shape-rendering="crispEdges">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <g fill="#111111">${rects.join('')}</g>
</svg>`;
}
