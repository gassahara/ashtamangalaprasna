import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ============ BEACON FETCHER ============

async function fetchBeaconFromURL(url: string, timeout = 10000): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json, application/xml, text/plain",
        "User-Agent": "disperse-beacon-fetcher/1.0",
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const content = await response.text();
    return extractBeaconFromContent(content);
  } catch (error) {
    throw new Error(`Failed to fetch beacon: ${error.message}`);
  }
}

function extractBeaconFromContent(content: string): string {
  content = content.trim();
  
  // Try JSON format
  if (content.startsWith("{") || content.startsWith("[")) {
    try {
      const data = JSON.parse(content);
      // Try common field names
      const fields = ["pulse", "outputValue", "value", "beacon", "seed", "random", "data"];
      for (const field of fields) {
        if (typeof data === "object" && data[field]) {
          const value = typeof data[field] === "string" 
            ? data[field] 
            : data[field]?.outputValue || data[field]?.value;
          if (value && typeof value === "string") {
            return validateBeaconHex(value);
          }
        }
      }
    } catch {
      // Not valid JSON, continue to other formats
    }
  }
  
  // Try XML format (NIST beacon)
  if (content.startsWith("<") || content.includes("<?xml")) {
    const patterns = [
      /<outputValue>([0-9a-fA-F]+)<\/outputValue>/,
      /<pulseValue>([0-9a-fA-F]+)<\/pulseValue>/,
      /<value>([0-9a-fA-F]+)<\/value>/,
    ];
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        return validateBeaconHex(match[1]);
      }
    }
  }
  
  // Try raw hex
  const cleaned = content.replace(/\s/g, "");
  if (/^[0-9a-fA-F]{128}$/.test(cleaned)) {
    return cleaned.toLowerCase();
  }
  
  throw new Error("Could not extract 512-bit beacon from response");
}

function validateBeaconHex(hex: string): string {
  const cleaned = hex.trim().toLowerCase();
  if (cleaned.length !== 128) {
    throw new Error(`Invalid beacon length: ${cleaned.length} chars (expected 128)`);
  }
  if (!/^[0-9a-f]{128}$/.test(cleaned)) {
    throw new Error("Beacon contains invalid characters");
  }
  return cleaned;
}

async function generateLocalBeacon(): Promise<string> {
  const buffer = new Uint8Array(64);
  crypto.getRandomValues(buffer);
  return Array.from(buffer)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============ RANDOMNESS ============

/**
 * Fast, synchronous PRNG for the simulation loop (SFC32).
 * Seeded via the asynchronous Web Crypto API initially.
 */
class SimulationRNG {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: Uint32Array) {
    this.a = seed[0];
    this.b = seed[1];
    this.c = seed[2];
    this.d = seed[3];
  }

  // SFC32 (Simple Fast Counter) algorithm
  private next(): number {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    let t = (this.a + this.b | 0) + this.d | 0;
    this.d = this.d + 1 | 0;
    this.a = this.b ^ this.b >>> 9;
    this.b = this.c + (this.c << 3) | 0;
    this.c = this.c << 21 | this.c >>> 11;
    this.c = this.c + t | 0;
    return (t >>> 0) / 4294967296;
  }

  getRandomInt(maxVal: number): number {
    if (maxVal <= 0) return 0;
    return Math.floor(this.next() * maxVal);
  }
}

async function createRNG(seedHex?: string): Promise<{ rng: SimulationRNG; usingBeacon: boolean }> {
  let beaconBytes: Uint8Array;
  let usingBeacon = false;
  
  if (seedHex && /^[0-9a-fA-F]+$/.test(seedHex)) {
    // Extend short seeds to 512 bits
    let hex = seedHex.toLowerCase();
    if (hex.length < 128) {
      // Extend using SHA-256
      const seedBytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
      const hash1 = await crypto.subtle.digest("SHA-256", seedBytes);
      const hash2 = await crypto.subtle.digest("SHA-256", new Uint8Array([...seedBytes, 0]));
      beaconBytes = new Uint8Array([...new Uint8Array(hash1), ...new Uint8Array(hash2)]);
    } else if (hex.length === 128) {
      beaconBytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    } else {
      // Truncate to 128 chars
      hex = hex.substring(0, 128);
      beaconBytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    }
    usingBeacon = true;
  } else {
    // Generate 512 bits of local entropy
    beaconBytes = new Uint8Array(64);
    crypto.getRandomValues(beaconBytes);
  }

  // Hash the seed deterministically to derive internal PRNG state
  const hashBuffer = await crypto.subtle.digest("SHA-256", beaconBytes);
  const hashArray = new Uint32Array(hashBuffer);
  
  return { rng: new SimulationRNG(hashArray.slice(0, 4)), usingBeacon };
}

// ============ TYPES & CONSTRAINTS ============

interface Point {
  x: number;
  y: number;
}

class GridConstraints {
  s_grid: number;
  v_lines: number[];
  h_lines: number[];
  holes: Set<string>; // Stored as "row,col"
  x_bounds: number[];
  y_bounds: number[];
  num_cols: number;
  num_rows: number;

  constructor(s_grid: number, v_lines: number[], h_lines: number[], holes: number[][]) {
    this.s_grid = s_grid;
    this.v_lines = [...v_lines].sort((a, b) => a - b);
    this.h_lines = [...h_lines].sort((a, b) => a - b);
    this.holes = new Set(holes.map(h => `${h[0]},${h[1]}`));

    this.x_bounds = [0, ...this.v_lines, s_grid];
    this.y_bounds = [0, ...this.h_lines, s_grid];
    this.num_cols = this.x_bounds.length - 1;
    this.num_rows = this.y_bounds.length - 1;
  }

  getCell(x: number, y: number): [number, number] {
    let col = this.num_cols - 1;
    for (let i = 0; i < this.x_bounds.length - 1; i++) {
      if (x >= this.x_bounds[i] && x < this.x_bounds[i + 1]) {
        col = i;
        break;
      }
    }

    let row = this.num_rows - 1;
    for (let i = 0; i < this.y_bounds.length - 1; i++) {
      if (y >= this.y_bounds[i] && y < this.y_bounds[i + 1]) {
        row = i;
        break;
      }
    }
    return [row, col];
  }

  isValid(x: number, y: number, margin: number = 0): boolean {
    const [row, col] = this.getCell(x, y);
    if (this.holes.has(`${row},${col}`)) return false;

    if (margin > 0) {
      const offsets = [-margin, 0, margin];
      for (const dx of offsets) {
        for (const dy of offsets) {
          const cx = x + dx;
          const cy = y + dy;
          if (cx >= 0 && cx < this.s_grid && cy >= 0 && cy < this.s_grid) {
            const [cRow, cCol] = this.getCell(cx, cy);
            if (this.holes.has(`${cRow},${cCol}`)) return false;
          }
        }
      }
    }
    return true;
  }

  bounce(prevX: number, prevY: number, newX: number, newY: number, margin: number): Point {
    if (this.isValid(newX, newY, margin)) {
      return { x: newX, y: newY };
    }

    let bestX = prevX;
    let bestY = prevY;

    for (let i = 1; i <= 20; i++) {
      const t = i / 20.0;
      const testX = Math.trunc(prevX + (newX - prevX) * t);
      const testY = Math.trunc(prevY + (newY - prevY) * t);
      
      if (this.isValid(testX, testY, margin)) {
        bestX = testX;
        bestY = testY;
      }
    }

    return {
      x: Math.max(0, Math.min(this.s_grid - 1, bestX)),
      y: Math.max(0, Math.min(this.s_grid - 1, bestY))
    };
  }

  randomValid(rng: SimulationRNG): Point {
    const validCells: [number, number][] = [];
    for (let r = 0; r < this.num_rows; r++) {
      for (let c = 0; c < this.num_cols; c++) {
        if (!this.holes.has(`${r},${c}`)) validCells.push([r, c]);
      }
    }

    if (validCells.length === 0) {
      return { x: Math.floor(this.s_grid / 2), y: Math.floor(this.s_grid / 2) };
    }

    const idx = rng.getRandomInt(validCells.length);
    const [row, col] = validCells[idx];

    const xMin = this.x_bounds[col];
    const xMax = this.x_bounds[col + 1];
    const yMin = this.y_bounds[row];
    const yMax = this.y_bounds[row + 1];

    return {
      x: xMin + rng.getRandomInt(xMax - xMin),
      y: yMin + rng.getRandomInt(yMax - yMin)
    };
  }
}

// ============ SHAPE ============

class Shape {
  num_sides: number;
  params: number[];
  num_rotations: number;
  enable_mirror: boolean;
  rotation_index: number = 0;
  current_mirror: boolean = false;

  constructor(num_sides: number, params: number[], num_rotations: number = 1, enable_mirror: boolean = false) {
    this.num_sides = num_sides;
    this.params = params;
    this.num_rotations = Math.max(1, num_rotations);
    this.enable_mirror = enable_mirror;
  }

  setOrientation(rotationIndex: number, mirror: boolean = false) {
    if (this.num_rotations > 1) {
      this.rotation_index = rotationIndex % this.num_rotations;
    } else {
      this.rotation_index = 0;
    }
    this.current_mirror = mirror && this.enable_mirror;
  }

  getRotationAngle(): number {
    if (this.num_rotations <= 1) return 0.0;
    return (this.rotation_index * 180.0) / this.num_rotations;
  }

  getEffectiveMirror(): boolean {
    return this.current_mirror && this.enable_mirror;
  }

  private applyRotation(width: number, height: number): [number, number] {
    const angle = this.getRotationAngle();
    if (angle === 0) return [width, height];

    const rad = angle * (Math.PI / 180);
    const cosA = Math.abs(Math.cos(rad));
    const sinA = Math.abs(Math.sin(rad));

    const newWidth = Math.trunc(width * cosA + height * sinA);
    const newHeight = Math.trunc(width * sinA + height * cosA);

    return [Math.max(1, newWidth), Math.max(1, newHeight)];
  }

  getBoundingBox(): [number, number] {
    if (this.num_sides === 0) {
      const r = this.params.length > 0 ? this.params[0] : 1;
      return [2 * r, 2 * r];
    } else if (this.num_sides === 2) {
      const length = this.params.length > 0 ? this.params[0] : 10;
      const thickness = Math.max(1, Math.floor(length / 10));
      return this.applyRotation(length, thickness);
    } else {
      const maxSide = this.params.length > 0 ? Math.max(...this.params) : 10;
      return this.applyRotation(maxSide * 2, maxSide * 2);
    }
  }
}

// ============ SIMULATION ============

function resolveOverlaps(points: Point[], shape: Shape, s_grid: number): Point[] {
  const [boxW, boxH] = shape.getBoundingBox();
  const minSepX = boxW;
  const minSepY = boxH;
  
  let newPoints = points.map(p => ({ ...p }));

  for (let iter = 0; iter < 50; iter++) {
    let moved = false;

    for (let i = 0; i < newPoints.length; i++) {
      for (let j = i + 1; j < newPoints.length; j++) {
        let { x: x1, y: y1 } = newPoints[i];
        let { x: x2, y: y2 } = newPoints[j];

        const dx = Math.abs(x1 - x2);
        const dy = Math.abs(y1 - y2);

        if (dx < minSepX && dy < minSepY) {
          if (dx < minSepX) {
            const overlap = minSepX - dx;
            const shift = Math.floor(overlap / 2) + 1;
            if (x1 < x2) {
              x1 -= shift; x2 += shift;
            } else {
              x1 += shift; x2 -= shift;
            }
          }

          if (dy < minSepY) {
            const overlap = minSepY - dy;
            const shift = Math.floor(overlap / 2) + 1;
            if (y1 < y2) {
              y1 -= shift; y2 += shift;
            } else {
              y1 += shift; y2 -= shift;
            }
          }

          newPoints[i].x = Math.max(0, Math.min(s_grid - 1, x1));
          newPoints[i].y = Math.max(0, Math.min(s_grid - 1, y1));
          newPoints[j].x = Math.max(0, Math.min(s_grid - 1, x2));
          newPoints[j].y = Math.max(0, Math.min(s_grid - 1, y2));
          moved = true;
        }
      }
    }
    
    if (!moved) break;
  }
  return newPoints;
}

function throwStep(
  points: Point[], R_grid: number, stepSize: number, s_grid: number, 
  rng: SimulationRNG, gridConstraints: GridConstraints | null, margin: number
): Point[] {
  let avgX = Math.floor(s_grid / 2);
  let avgY = Math.floor(s_grid / 2);

  if (points.length > 0) {
    avgX = Math.floor(points.reduce((sum, p) => sum + p.x, 0) / points.length);
    avgY = Math.floor(points.reduce((sum, p) => sum + p.y, 0) / points.length);
  }

  let region = Math.max(R_grid * 4, Math.floor(s_grid / 10));
  region = Math.min(region, Math.floor(s_grid / 2));

  let cx = avgX + rng.getRandomInt(2 * region) - region;
  let cy = avgY + rng.getRandomInt(2 * region) - region;
  cx = Math.max(0, Math.min(s_grid - 1, cx));
  cy = Math.max(0, Math.min(s_grid - 1, cy));

  return points.map(p => {
    let { x, y } = p;
    const dx = x - cx;
    const dy = y - cy;

    if (dx * dx + dy * dy <= R_grid * R_grid) {
      x = cx;
      y = cy;
      const angle = (rng.getRandomInt(65536) / 65536) * 2 * Math.PI;
      const dist = (rng.getRandomInt(65536) / 65536) * stepSize;
      
      x += Math.trunc(dist * Math.cos(angle));
      y += Math.trunc(dist * Math.sin(angle));
    }

    x = Math.max(0, Math.min(s_grid - 1, x));
    y = Math.max(0, Math.min(s_grid - 1, y));

    if (gridConstraints && margin > 0) {
      if (!gridConstraints.isValid(x, y, margin)) {
        const bounced = gridConstraints.bounce(p.x, p.y, x, y, margin);
        x = bounced.x;
        y = bounced.y;
      }
    }

    return { x, y };
  });
}

function randomizeOrientation(shape: Shape, rng: SimulationRNG): number {
  let bitsUsed = 0;
  let rotationIndex = 0;

  if (shape.num_rotations > 1) {
    rotationIndex = rng.getRandomInt(shape.num_rotations);
    bitsUsed += Math.ceil(Math.log2(shape.num_rotations));
  }

  let mirror = false;
  if (shape.enable_mirror) {
    mirror = rng.getRandomInt(2) === 1;
    bitsUsed += 1;
  }

  shape.setOrientation(rotationIndex, mirror);
  return bitsUsed;
}

function simulate(
  N: number, steps: number, R_grid: number, s_grid: number,
  shape: Shape, rng: SimulationRNG, gridConstraints: GridConstraints | null,
  perStepOrientation: boolean = true
) {
  let [boxW, boxH] = shape.getBoundingBox();
  let margin = Math.floor(Math.max(boxW, boxH) / 2) + 1;

  let points: Point[] = [];
  const center = Math.floor(s_grid / 2);

  for (let i = 0; i < N; i++) {
    if (gridConstraints) {
      points.push(gridConstraints.randomValid(rng));
    } else {
      let x = center + rng.getRandomInt(256) - 128;
      let y = center + rng.getRandomInt(256) - 128;
      points.push({
        x: Math.max(0, Math.min(s_grid - 1, x)),
        y: Math.max(0, Math.min(s_grid - 1, y))
      });
    }
  }

  points = resolveOverlaps(points, shape, s_grid);
  const stepSize = Math.max(1, Math.floor(s_grid / 4));

  let totalBits = 0;
  const orientationHistory: any[] = [];

  for (let step = 0; step < steps; step++) {
    if (perStepOrientation && (shape.num_rotations > 1 || shape.enable_mirror)) {
      const orientBits = randomizeOrientation(shape, rng);
      totalBits += orientBits;
      orientationHistory.push({
        step: step,
        rotation_index: shape.rotation_index,
        rotation_angle: shape.getRotationAngle(),
        mirror: shape.getEffectiveMirror()
      });

      const [newW, newH] = shape.getBoundingBox();
      margin = Math.floor(Math.max(newW, newH) / 2) + 1;
    }

    const prevPoints = points.map(p => ({ ...p }));
    points = throwStep(points, R_grid, stepSize, s_grid, rng, gridConstraints, margin);
    points = resolveOverlaps(points, shape, s_grid);

    if (gridConstraints) {
      for (let i = 0; i < points.length; i++) {
        const { x, y } = points[i];
        if (!gridConstraints.isValid(x, y, margin)) {
          points[i] = gridConstraints.bounce(prevPoints[i].x, prevPoints[i].y, x, y, margin);
        }
      }
    }
  }

  return { points, totalBits, orientationHistory };
}

// ============ CHACHA20 DERIVER ============

class ChaCha20Deriver {
  private seed: Uint8Array;
  private inputData: Uint8Array;

  constructor(seedHex: string, inputHex: string) {
    // Validate and parse seed (128 hex chars = 512 bits)
    seedHex = seedHex.trim().toLowerCase();
    if (seedHex.length !== 128) {
      throw new Error(`Seed must be 128 hex characters (512 bits), got ${seedHex.length}`);
    }
    if (!/^[0-9a-f]{128}$/.test(seedHex)) {
      throw new Error("Seed must be valid hexadecimal string");
    }
    this.seed = new Uint8Array(seedHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

    // Validate and parse input (64 hex chars = 256 bits)
    inputHex = inputHex.trim().toLowerCase();
    if (inputHex.length !== 64) {
      throw new Error(`Input must be 64 hex characters (256 bits), got ${inputHex.length}`);
    }
    if (!/^[0-9a-f]{64}$/.test(inputHex)) {
      throw new Error("Input must be valid hexadecimal string");
    }
    this.inputData = new Uint8Array(inputHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  }

  private async deriveCounter(blockIdx: number): Promise<Uint8Array> {
    // counter_i = SHA-256(seed || block_idx)
    const idxBytes = new Uint8Array(8);
    new DataView(idxBytes.buffer).setBigUint64(0, BigInt(blockIdx), false);
    const counterInput = new Uint8Array([...this.seed, ...idxBytes]);
    return new Uint8Array(await crypto.subtle.digest("SHA-256", counterInput));
  }

  private async deriveBlock(blockIdx: number): Promise<Uint8Array> {
    // Derive pseudorandom counter for this block
    const counter = await this.deriveCounter(blockIdx);
    
    // Build mixing input: seed || input || counter
    const mixInput = new Uint8Array([...this.seed, ...this.inputData, ...counter]);
    
    // Round 0: Initial hash
    let block = new Uint8Array(await crypto.subtle.digest("SHA-512", mixInput));
    
    // Round 1: Mix with full seed
    const mix1 = new Uint8Array([...block, ...this.seed, ...counter]);
    block = new Uint8Array(await crypto.subtle.digest("SHA-512", mix1));
    
    // Round 2: Mix with input and seed portion
    const mix2 = new Uint8Array([...block, ...this.inputData, ...this.seed.slice(0, 32)]);
    block = new Uint8Array(await crypto.subtle.digest("SHA-512", mix2));
    
    // Round 3: Final mixing
    const mix3 = new Uint8Array([...block, ...counter, ...this.seed.slice(32)]);
    block = new Uint8Array(await crypto.subtle.digest("SHA-512", mix3));
    
    return block;
  }

  async deriveBytes(nBytes: number): Promise<Uint8Array> {
    if (nBytes <= 0) {
      throw new Error("nBytes must be positive");
    }
    if (nBytes > 65536) {
      throw new Error("nBytes cannot exceed 65536 (64KB)");
    }

    const output: number[] = [];
    let blockIdx = 0;
    while (output.length < nBytes) {
      const block = await this.deriveBlock(blockIdx);
      for (const byte of block) {
        output.push(byte);
        if (output.length >= nBytes) break;
      }
      blockIdx++;
    }

    return new Uint8Array(output.slice(0, nBytes));
  }

  async deriveBits(nBits: number): Promise<string> {
    if (nBits <= 0) {
      throw new Error("nBits must be positive");
    }
    if (nBits > 524288) {
      throw new Error("nBits cannot exceed 524288 (64KB)");
    }

    const nBytes = Math.ceil(nBits / 8);
    const bytes = await this.deriveBytes(nBytes);
    
    let hex = Array.from(bytes)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    
    // If nBits is not a multiple of 8, mask the last byte
    const extraBits = (nBytes * 8) - nBits;
    if (extraBits > 0) {
      const lastByte = bytes[bytes.length - 1];
      const mask = (0xFF >> extraBits);
      const lastByteMasked = lastByte & mask;
      hex = hex.slice(0, -2) + lastByteMasked.toString(16).padStart(2, "0");
    }

    return hex;
  }
}

// ============ DISTRIBUTE HANDLER (XY Separation Curves for Temporal Piles) ============

function seedToNumbers(seed: string): number[] {
  const nums: number[] = [];
  for (let i = 0; i < seed.length; i += 4) {
    const chunk = seed.substring(i, i + 4);
    nums.push(parseInt(chunk, 16) || 0);
  }
  return nums;
}

class SFC32 {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number[]) {
    this.a = seed[0] || 0;
    this.b = seed[1] || 0;
    this.c = seed[2] || 0;
    this.d = seed[3] || 0;
    for (let i = 0; i < 12; i++) this.next();
  }

  next(): number {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    let t = (this.a + this.b | 0) + this.d | 0;
    this.d = this.d + 1 | 0;
    this.a = this.b ^ this.b >>> 9;
    this.b = this.c + (this.c << 3) | 0;
    this.c = (this.c << 21 | this.c >>> 11) + t | 0;
    return (t >>> 0) / 4294967296;
  }

  randInt(max: number): number {
    return Math.floor(this.next() * max);
  }

  randRange(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

type CurveType = 'sine' | 'bezier' | 'polyline';

interface SeparationCurve {
  type: CurveType;
  start: [number, number];
  end: [number, number];
  controlPoints: [number, number][];
  equation?: string;
}

function getPileName(num: number): string {
  const names: Record<number, string> = {
    1: "Dhwaja (Victory)",
    2: "Dhumra (Obscurity)",
    3: "Simha (Power)",
    4: "Shwana (Service)",
    5: "Vrushabha (Stability)",
    6: "Khara (Adversity)",
    7: "Gaja (Prosperity)",
    8: "Dhwanksha (Decay)"
  };
  return names[num] || "Unknown";
}

function generateSineCurve(rng: SFC32, yBase: number): SeparationCurve {
  const amplitude = rng.randRange(5, 15);
  const frequency = rng.randRange(0.05, 0.15);
  const phase = rng.randRange(0, Math.PI * 2);
  const vertical = yBase + rng.randRange(-5, 5);
  
  return {
    type: 'sine',
    start: [0, vertical],
    end: [100, vertical + amplitude * Math.sin(frequency * 100 + phase)],
    controlPoints: [[25, vertical + amplitude * Math.sin(frequency * 25 + phase)],
                    [50, vertical + amplitude * Math.sin(frequency * 50 + phase)],
                    [75, vertical + amplitude * Math.sin(frequency * 75 + phase)]],
    equation: `y = ${amplitude.toFixed(2)}*sin(${frequency.toFixed(3)}*x + ${phase.toFixed(2)}) + ${vertical.toFixed(2)}`
  };
}

function generateBezierCurve(rng: SFC32, yBase: number): SeparationCurve {
  const cp1x = rng.randRange(20, 40);
  const cp1y = yBase + rng.randRange(-20, 20);
  const cp2x = rng.randRange(60, 80);
  const cp2y = yBase + rng.randRange(-20, 20);
  const endY = yBase + rng.randRange(-10, 10);
  
  return {
    type: 'bezier',
    start: [0, yBase],
    end: [100, endY],
    controlPoints: [[cp1x, cp1y], [cp2x, cp2y]]
  };
}

function generatePolylineCurve(rng: SFC32, yBase: number): SeparationCurve {
  const points: [number, number][] = [[0, yBase]];
  let currentX = 0;
  let currentY = yBase;
  
  while (currentX < 100) {
    currentX += rng.randRange(10, 25);
    if (currentX > 100) currentX = 100;
    currentY += rng.randRange(-15, 15);
    points.push([currentX, currentY]);
  }
  
  return {
    type: 'polyline',
    start: [0, yBase],
    end: points[points.length - 1],
    controlPoints: points.slice(1, -1)
  };
}

function getCurveYAtX(x: number, curve: SeparationCurve): number {
  if (curve.type === 'sine' && curve.equation) {
    const match = curve.equation.match(/y = ([\d.]+)\*sin\(([\d.]+)\*x \+ ([\d.]+)\) \+ ([\d.]+)/);
    if (match) {
      const A = parseFloat(match[1]);
      const B = parseFloat(match[2]);
      const C = parseFloat(match[3]);
      const D = parseFloat(match[4]);
      return A * Math.sin(B * x + C) + D;
    }
  }
  
  const allPoints = [curve.start, ...curve.controlPoints, curve.end];
  
  for (let i = 0; i < allPoints.length - 1; i++) {
    const p1 = allPoints[i];
    const p2 = allPoints[i + 1];
    if (x >= p1[0] && x <= p2[0]) {
      const t = (x - p1[0]) / (p2[0] - p1[0]);
      return p1[1] + t * (p2[1] - p1[1]);
    }
  }
  
  return curve.start[1];
}

function getPointRegion(
  x: number,
  y: number,
  boundaries: { past_present: SeparationCurve; present_future: SeparationCurve }
): 'past' | 'present' | 'future' {
  const yPastPresent = getCurveYAtX(x, boundaries.past_present);
  const yPresentFuture = getCurveYAtX(x, boundaries.present_future);
  
  if (y < yPastPresent) return 'past';
  if (y >= yPastPresent && y < yPresentFuture) return 'present';
  return 'future';
}

function generateDistribution(
  seed: string,
  kavane: Array<{ house: number; cell: number; up: boolean }>
) {
  const seedNums = seedToNumbers(seed);
  const rng = new SFC32(seedNums);
  
  const startX = rng.randRange(0, 100);
  const startY = rng.randRange(0, 100);
  
  const startHouseCol = Math.floor(startX / 25);
  const startHouseRow = Math.floor(startY / 33.33);
  const startHouse = startHouseRow * 4 + startHouseCol + 1;
  
  const curveType1: CurveType = rng.next() < 0.4 ? 'sine' : (rng.next() < 0.5 ? 'bezier' : 'polyline');
  const pastPresentBoundary = curveType1 === 'sine' 
    ? generateSineCurve(rng, 33)
    : (curveType1 === 'bezier' ? generateBezierCurve(rng, 33) : generatePolylineCurve(rng, 33));
  
  const curveType2: CurveType = rng.next() < 0.4 ? 'sine' : (rng.next() < 0.5 ? 'bezier' : 'polyline');
  const presentFutureBoundary = curveType2 === 'sine'
    ? generateSineCurve(rng, 66)
    : (curveType2 === 'bezier' ? generateBezierCurve(rng, 66) : generatePolylineCurve(rng, 66));
  
  let past = 0, present = 0, future = 0;
  const distributionByHouse: Record<number, number> = {};
  for (let i = 1; i <= 12; i++) distributionByHouse[i] = 0;
  
  for (const k of kavane) {
    const houseCol = (k.house - 1) % 4;
    const houseRow = Math.floor((k.house - 1) / 4);
    const cellX = k.cell % 3;
    const cellY = Math.floor(k.cell / 3);
    
    const x = (houseCol * 25) + (cellX / 3) * 25 + (12.5 / 3);
    const y = (houseRow * 33.33) + (cellY / 4) * 33.33 + (8.33 / 4);
    
    const pile = getPointRegion(x, y, {
      past_present: pastPresentBoundary,
      present_future: presentFutureBoundary
    });
    
    if (pile === 'past') past++;
    else if (pile === 'present') present++;
    else future++;
    
    distributionByHouse[k.house]++;
  }
  
  const reduce = (n: number) => {
    const r = n % 8;
    return r === 0 ? 8 : r;
  };
  
  return {
    piles: {
      past: reduce(past),
      present: reduce(present),
      future: reduce(future)
    },
    pile_names: {
      past: getPileName(reduce(past)),
      present: getPileName(reduce(present)),
      future: getPileName(reduce(future))
    },
    boundaries: {
      past_present: pastPresentBoundary,
      present_future: presentFutureBoundary
    },
    start_point: {
      x: parseFloat(startX.toFixed(2)),
      y: parseFloat(startY.toFixed(2)),
      house: Math.min(Math.max(startHouse, 1), 12)
    },
    distribution_by_house: distributionByHouse,
    temporal_regions: {
      past: [12, 1, 2],
      present: [3, 4, 5, 6],
      future: [7, 8, 9, 10, 11]
    }
  };
}

async function handleDistribute(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const seed = body.seed;
    const kavane = body.kavane;
    
    if (!seed) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required parameter: 'seed'" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    if (!kavane || !Array.isArray(kavane) || kavane.length !== 108) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required parameter: 'kavane' array with 108 items" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    if (!/^[0-9a-fA-F]+$/.test(seed)) {
      return new Response(
        JSON.stringify({ success: false, error: "Seed must be hexadecimal string" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    const result = generateDistribution(seed.toLowerCase(), kavane);
    
    return new Response(JSON.stringify({
      success: true,
      seed: seed.substring(0, 32) + (seed.length > 32 ? "..." : ""),
      start_point: result.start_point,
      piles: result.piles,
      pile_names: result.pile_names,
      boundaries: result.boundaries,
      distribution_by_house: result.distribution_by_house,
      temporal_regions: result.temporal_regions
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
    
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// ============ HANDLERS ============

async function handleBeacon(req: Request): Promise<Response> {
  try {
    // Get beacon URL from environment or use default
    const beaconUrl = Deno.env.get("BEACON_URL") || "https://beacon.nist.gov/beacon/2.0/pulse/last";
    
    let beaconHex: string;
    let source: string;
    
    try {
      beaconHex = await fetchBeaconFromURL(beaconUrl);
      source = "external";
    } catch (e) {
      // Fallback to local entropy
      beaconHex = await generateLocalBeacon();
      source = "generated";
    }
    
    const result = {
      success: true,
      beacon: {
        value: beaconHex,
        hex: beaconHex,
        bits: 512,
        bytes: 64,
        source: source,
        url: source === "external" ? beaconUrl : undefined
      },
      seed: beaconHex,
      usage: {
        endpoint: "/disperse",
        parameter: "seed",
        description: "Pass this seed value to the /disperse endpoint"
      }
    };
    
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
}

async function handleChaCha20Derive(req: Request): Promise<Response> {
  try {
    const body = await req.json();

    const seed = body.seed;
    const input = body.input;
    const nBits = Number(body.n_bits ?? 256);

    // Validation
    if (!seed) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required parameter: 'seed' (128 hex chars = 512 bits)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!input) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required parameter: 'input' (64 hex chars = 256 bits)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (nBits <= 0 || nBits > 65536) {
      return new Response(
        JSON.stringify({ success: false, error: "n_bits must be between 1 and 65536" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create deriver and generate output
    const deriver = new ChaCha20Deriver(seed, input);
    const outputHex = await deriver.deriveBits(nBits);
    const nBytes = Math.ceil(nBits / 8);

    const result = {
      success: true,
      parameters: {
        seed: seed.substring(0, 32) + "...",
        input: input.substring(0, 32) + "...",
        n_bits: nBits,
        n_bytes: nBytes
      },
      output: {
        hex: outputHex,
        bits: nBits,
        bytes: nBytes
      },
      algorithm: {
        name: "ChaCha20Deriver",
        description: "Deterministic bitstring derivation using ChaCha20-like mixing with SHA-512",
        seed_bits: 512,
        input_bits: 256
      }
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    const status = (error as Error).message?.includes("must be") || 
                   (error as Error).message?.includes("valid") ? 400 : 500;
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
}

async function handleDisperse(req: Request): Promise<Response> {
  try {
    const body = await req.json();

    // Defaults & Parsing mapped exactly to Python logic
    const N = Number(body.N ?? 100);
    const steps = Number(body.steps ?? 50);
    const R_grid = Number(body.R_grid ?? 50);
    const s_grid = Number(body.s_grid ?? 500);
    const num_sides = Number(body.num_sides ?? 0);

    let shape_params = body.shape_params || body.edges || [3];
    if (!Array.isArray(shape_params)) shape_params = [shape_params];

    const num_rotations = Number(body.num_rotations ?? 1);
    const enable_mirror = Boolean(body.enable_mirror ?? false);

    const v_lines = body.v_lines || body.vertical_lines || [];
    const h_lines = body.h_lines || body.horizontal_lines || [];
    const holes = body.holes || body.forbidden_cells || [];
    
    // Support both 'seed' and legacy 'entropy_seed'
    const seed = body.seed || body.entropy_seed;

    // Validation
    if (N <= 0 || steps <= 0 || s_grid <= 0) {
      throw new Error("N, steps, and s_grid must be positive integers");
    }
    
    // Validate seed format if provided
    if (seed && !/^[0-9a-fA-F]+$/.test(seed)) {
      throw new Error("Seed must be a valid hexadecimal string");
    }

    // Instantiation
    const { rng, usingBeacon } = await createRNG(seed);
    const shape = new Shape(num_sides, shape_params, num_rotations, enable_mirror);

    let gridConstraints: GridConstraints | null = null;
    if (v_lines.length > 0 || h_lines.length > 0 || holes.length > 0) {
      gridConstraints = new GridConstraints(s_grid, v_lines, h_lines, holes);
    }

    // Run 
    const { points, totalBits, orientationHistory } = simulate(
      N, steps, R_grid, s_grid, shape, rng, gridConstraints, true
    );

    // Get the effective seed (original or extended)
    let effectiveSeed: string | null = null;
    if (seed) {
      effectiveSeed = seed.toLowerCase();
      if (effectiveSeed.length < 128) {
        // Extended seed would be calculated here for response
        // For simplicity, we just note it was extended
        effectiveSeed = effectiveSeed + "...";
      }
    }

    const result = {
      success: true,
      parameters: {
        N, steps, R_grid, s_grid, num_sides,
        shape_params, edges: shape_params,
        num_rotations, enable_mirror,
        v_lines, h_lines, holes,
        seed: effectiveSeed,
        seed_source: usingBeacon ? "beacon" : "local_entropy"
      },
      results: {
        total_points: points.length,
        points: points.map((p, i) => ({ id: i + 1, x: p.x, y: p.y })),
        orientation_entropy_bits: totalBits,
        orientation_history_sample: orientationHistory.slice(0, 5)
      }
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    const status = (error as Error).message?.includes("must be") ? 400 : 500;
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
}

// ============ MAIN ROUTER ============

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  // Route to appropriate handler
  // In Supabase Edge Functions, the function name is part of the path
  // e.g., /functions/v1/disperse/beacon -> pathname is /disperse/beacon
  if (path.includes("/beacon") || path === "/beacon") {
    return await handleBeacon(req);
  } else if (path.includes("/chacha20/derive") || path === "/chacha20/derive") {
    return await handleChaCha20Derive(req);
  } else if (path.includes("/distribute") || path === "/distribute") {
    return await handleDistribute(req);
  } else {
    // Default to disperse handler (for /disperse or any other path)
    return await handleDisperse(req);
  }
});
