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
        orientation_history_sample: orientationHistory
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

// ============ DISTRIBUTE (XY CURVES FOR TEMPORAL PILES) ============

type CurveType = 'sine' | 'bezier' | 'polyline';

interface SeparationCurve {
  type: CurveType;
  start: [number, number];
  end: [number, number];
  controlPoints: [number, number][];
  equation?: string;
}

interface DistributionResult {
  piles: { past: number; present: number; future: number };
  pile_names: { past: string; present: string; future: string };
  pile_planets: { 
    past: PileNumerology; 
    present: PileNumerology; 
    future: PileNumerology 
  };
  pile_numerology: {
    all: Record<number, PileNumerology>;
    summary: {
      total_benefic: number;
      total_malefic: number;
      total_neutral: number;
      dominant_element: string;
      dominant_nature: string;
      overall_indication: "Favorable" | "Mixed" | "Unfavorable";
    }
  };
  drishti: {
    pile_aspects: Record<string, { house: number; aspects: number[] }>;
    analysis: string;
  };
  boundaries: { past_present: SeparationCurve; present_future: SeparationCurve };
  start_point: { x: number; y: number; house: number };
  distribution_by_house: Record<number, number>;
  temporal_regions: { past: number[]; present: number[]; future: number[] };
}

class SFC32 {
  private a: number; private b: number; private c: number; private d: number;
  constructor(seed: number[]) {
    this.a = seed[0] || 0; this.b = seed[1] || 0; this.c = seed[2] || 0; this.d = seed[3] || 0;
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
  randRange(min: number, max: number): number { return min + this.next() * (max - min); }
}

function seedToNumbers(seed: string): number[] {
  const nums: number[] = [];
  for (let i = 0; i < seed.length; i += 4) {
    nums.push(parseInt(seed.substring(i, i + 4), 16) || 0);
  }
  return nums;
}

// Traditional Ashtamangala pile names
function getPileName(num: number): string {
  const names: Record<number, string> = {
    1: "Dhwaja (Victory)", 2: "Dhumra (Obscurity)", 3: "Simha (Power)",
    4: "Shwana (Service)", 5: "Vrushabha (Stability)", 6: "Khara (Adversity)",
    7: "Gaja (Prosperity)", 8: "Dhwanksha (Decay)"
  };
  return names[num] || "Unknown";
}

// Ashtamangala numerology: remainder mod 8 maps to planets
// 1=Sun, 2=Mars, 3=Jupiter, 4=Mercury, 5=Venus, 6=Saturn, 7=Moon, 8=Rahu
// Odd = Good/Benefic, Even = Bad/Malefic
// ============================================
// ASHTAMANGALA NUMEROLOGY - 8 PILES SYSTEM
// ============================================

interface PileNumerology {
  number: number;
  planet: string;
  sanskrit: string;
  symbol: string;
  nature: "Benefic" | "Malefic" | "Neutral";
  numberType: "Odd" | "Even";
  indication: "Good" | "Bad";
  gender: "Masculine" | "Feminine" | "Neutral";
  element: "Fire" | "Earth" | "Air" | "Water" | "Ether";
  direction: "East" | "South" | "West" | "North" | "Upward" | "Downward";
  color: string;
  gemstone: string;
  metal: string;
  deity: string;
  day: string;
  description: string;
  significance: string;
}

const pileNumerologyData: Record<number, PileNumerology> = {
  1: {
    number: 1,
    planet: "Sun",
    sanskrit: "Surya",
    symbol: "☉",
    nature: "Benefic",
    numberType: "Odd",
    indication: "Good",
    gender: "Masculine",
    element: "Fire",
    direction: "East",
    color: "Orange/Red",
    gemstone: "Ruby (Manikya)",
    metal: "Gold",
    deity: "Surya Narayana",
    day: "Sunday",
    description: "The Sun represents the soul, authority, vitality, and divine consciousness.",
    significance: "Success, honor, power, and spiritual illumination. Best for beginnings."
  },
  2: {
    number: 2,
    planet: "Mars",
    sanskrit: "Mangala",
    symbol: "♂",
    nature: "Malefic",
    numberType: "Even",
    indication: "Bad",
    gender: "Masculine",
    element: "Fire",
    direction: "South",
    color: "Red/Coral",
    gemstone: "Red Coral (Moonga)",
    metal: "Copper",
    deity: "Karttikeya",
    day: "Tuesday",
    description: "Mars represents courage, energy, conflict, and decisive action.",
    significance: "Struggle, obstacles, accidents. Caution needed. Good for surgery/war."
  },
  3: {
    number: 3,
    planet: "Jupiter",
    sanskrit: "Guru",
    symbol: "♃",
    nature: "Benefic",
    numberType: "Odd",
    indication: "Good",
    gender: "Masculine",
    element: "Ether",
    direction: "North",
    color: "Yellow/Golden",
    gemstone: "Yellow Sapphire (Pukhraj)",
    metal: "Gold",
    deity: "Brihaspati",
    day: "Thursday",
    description: "Jupiter represents wisdom, expansion, prosperity, and divine grace.",
    significance: "Fortune, growth, learning, and spiritual guidance. Very auspicious."
  },
  4: {
    number: 4,
    planet: "Mercury",
    sanskrit: "Budha",
    symbol: "☿",
    nature: "Neutral",
    numberType: "Even",
    indication: "Bad",
    gender: "Neutral",
    element: "Earth",
    direction: "North",
    color: "Green",
    gemstone: "Emerald (Panna)",
    metal: "Brass",
    deity: "Vishnu",
    day: "Wednesday",
    description: "Mercury represents intellect, communication, commerce, and adaptability.",
    significance: "Mixed results. Business fluctuations. Good for learning and travel."
  },
  5: {
    number: 5,
    planet: "Venus",
    sanskrit: "Shukra",
    symbol: "♀",
    nature: "Benefic",
    numberType: "Odd",
    indication: "Good",
    gender: "Feminine",
    element: "Water",
    direction: "Southeast",
    color: "White/Silver",
    gemstone: "Diamond (Heera)",
    metal: "Silver",
    deity: "Lakshmi",
    day: "Friday",
    description: "Venus represents love, beauty, arts, luxury, and material comforts.",
    significance: "Pleasure, marriage, wealth through arts. Creative success."
  },
  6: {
    number: 6,
    planet: "Saturn",
    sanskrit: "Shani",
    symbol: "♄",
    nature: "Malefic",
    numberType: "Even",
    indication: "Bad",
    gender: "Neutral",
    element: "Air",
    direction: "West",
    color: "Blue/Black",
    gemstone: "Blue Sapphire (Neelam)",
    metal: "Iron",
    deity: "Shani Dev",
    day: "Saturday",
    description: "Saturn represents karma, discipline, delays, and spiritual lessons.",
    significance: "Obstacles, delays, suffering. Tests patience. Good for long-term work."
  },
  7: {
    number: 7,
    planet: "Moon",
    sanskrit: "Chandra",
    symbol: "☽",
    nature: "Benefic",
    numberType: "Odd",
    indication: "Good",
    gender: "Feminine",
    element: "Water",
    direction: "Northwest",
    color: "White/Pearl",
    gemstone: "Pearl (Moti)",
    metal: "Silver",
    deity: "Parvati",
    day: "Monday",
    description: "The Moon represents mind, emotions, intuition, and nurturing energy.",
    significance: "Mental peace, popularity, fertility. Favorable for all beginnings."
  },
  8: {
    number: 8,
    planet: "Rahu",
    sanskrit: "Rahu",
    symbol: "☊",
    nature: "Malefic",
    numberType: "Even",
    indication: "Bad",
    gender: "Feminine",
    element: "Air",
    direction: "Southwest",
    color: "Smoky/Grey",
    gemstone: "Hessonite (Gomed)",
    metal: "Lead",
    deity: "Durga",
    day: "Saturday",
    description: "Rahu represents illusion, foreign influences, sudden events, and desires.",
    significance: "Confusion, deception, sudden losses. Unexpected events. Caution."
  }
};

function getPilePlanet(num: number): PileNumerology {
  return pileNumerologyData[num] || {
    number: num,
    planet: "Unknown",
    sanskrit: "Unknown",
    symbol: "?",
    nature: "Neutral",
    numberType: "Odd",
    indication: "Neutral",
    gender: "Neutral",
    element: "Ether",
    direction: "Center",
    color: "Grey",
    gemstone: "Unknown",
    metal: "Unknown",
    deity: "Unknown",
    day: "Unknown",
    description: "Unknown number.",
    significance: "Unknown significance."
  };
}

// Get all numerology data for reference
function getAllPileNumerology(): Record<number, PileNumerology> {
  return pileNumerologyData;
}

// ============================================
// JYOTISHA (VEDIC ASTROLOGY) CALCULATIONS
// ============================================

interface PlanetData {
  tropical: number;
  sidereal: number;
  house: number;
  sign: string;
  degrees: number;
}

interface JyotishaData {
  ayanamsa: number;
  planets: Record<string, PlanetData>;
  drishti: Record<string, { house: number; aspects: number[] }>;
}

// Convert date to Julian Day
function dateToJD(year: number, month: number, day: number, hour: number = 0): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  let jd = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  jd += (hour - 12) / 24;
  return jd;
}

// Calculate Lahiri Ayanamsa (Chitrapaksha)
function getLahiriAyanamsa(jd: number): number {
  const t = (jd - 2451545.0) / 36525.0; // Julian centuries from J2000
  // Lahiri formula
  const ayanamsa = 22.4605 + 1.3969715 * t + 0.0003086 * t * t;
  return ayanamsa % 360;
}

// Get tropical longitude for a planet (simplified)
function getTropicalLongitude(planet: string, jd: number): number {
  switch(planet) {
    case 'Sun':
      return (280.460 + 0.9856474 * (jd - 2451545.0)) % 360;
    case 'Moon':
      return (218.316 + 13.176396 * (jd - 2451545.0)) % 360;
    case 'Mars':
      return (355.433 + 0.524033 * (jd - 2451545.0)) % 360;
    case 'Mercury':
      return (252.251 + 4.092338 * (jd - 2451545.0)) % 360;
    case 'Jupiter':
      return (34.351 + 0.083091 * (jd - 2451545.0)) % 360;
    case 'Venus':
      return (181.979 + 1.602130 * (jd - 2451545.0)) % 360;
    case 'Saturn':
      return (50.077 + 0.033444 * (jd - 2451545.0)) % 360;
    case 'Rahu':
      // Mean node (retrograde)
      return (125.045 - 0.052992 * (jd - 2451545.0)) % 360;
    case 'Ketu':
      return (getTropicalLongitude('Rahu', jd) + 180) % 360;
    default:
      return 0;
  }
}

// Get Sanskrit sign name
function getRashiName(house: number): string {
  const rashis = ["Mesha", "Vrishabha", "Mithuna", "Karka", "Simha", "Kanya",
                  "Thula", "Vrischika", "Dhanus", "Makara", "Kumbha", "Meena"];
  return rashis[house - 1] || "Unknown";
}

// Calculate all planets with Lahiri ayanamsa
function calculatePlanets(jd: number): JyotishaData {
  const ayanamsa = getLahiriAyanamsa(jd);
  const planets = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn', 'Rahu', 'Ketu'];
  const result: Record<string, PlanetData> = {};
  
  planets.forEach(planet => {
    const tropical = getTropicalLongitude(planet, jd);
    const sidereal = (tropical - ayanamsa + 360) % 360;
    const house = Math.floor(sidereal / 30) + 1;
    const degreesInSign = sidereal % 30;
    
    result[planet] = {
      tropical: Math.round(tropical * 10000) / 10000,
      sidereal: Math.round(sidereal * 10000) / 10000,
      house,
      sign: getRashiName(house),
      degrees: Math.round(degreesInSign * 100) / 100
    };
  });
  
  // Calculate drishti
  const drishti = calculateAllDrishti(result);
  const drishtiRecord: Record<string, { house: number; aspects: number[] }> = {};
  drishti.forEach(d => {
    drishtiRecord[d.planet] = { house: d.house, aspects: d.aspects };
  });
  
  return {
    ayanamsa: Math.round(ayanamsa * 10000) / 10000,
    planets: result,
    drishti: drishtiRecord
  };
}

// Calculate Natal Chart
function calculateNatalChart(birthData: { year: number; month: number; day: number; hour: number; minute?: number }): JyotishaData | null {
  if (!birthData) return null;
  
  const hour = birthData.hour + (birthData.minute || 0) / 60;
  const jd = dateToJD(birthData.year, birthData.month, birthData.day, hour);
  const data = calculatePlanets(jd);
  
  // Add lagna (simplified - should calculate properly with latitude)
  const lagnaDegree = data.planets['Sun'].sidereal; // Placeholder
  const lagnaHouse = Math.floor(lagnaDegree / 30) + 1;
  
  return {
    ...data,
    planets: {
      ...data.planets,
      lagna: {
        tropical: 0,
        sidereal: Math.round(lagnaDegree * 10000) / 10000,
        house: lagnaHouse,
        sign: getRashiName(lagnaHouse),
        degrees: Math.round((lagnaDegree % 30) * 100) / 100
      }
    }
  };
}

// ============================================
// DRISHTI (ASPECT) CALCULATION
// ============================================

interface Drishti {
  planet: string;
  house: number;
  aspects: number[];
  aspectType: string;
}

// Calculate Vedic aspects (drishti) for planets
function calculateDrishti(planet: string, house: number): number[] {
  const aspects: number[] = [];
  
  // All planets aspect 7th house (opposition)
  const seventh = ((house + 6 - 1) % 12) + 1;
  aspects.push(seventh);
  
  // Special aspects
  switch (planet) {
    case "Mars":
      aspects.push(((house + 3 - 1) % 12) + 1);  // 4th
      aspects.push(((house + 7 - 1) % 12) + 1);  // 8th
      break;
    case "Jupiter":
      aspects.push(((house + 4 - 1) % 12) + 1);  // 5th
      aspects.push(((house + 8 - 1) % 12) + 1);  // 9th
      break;
    case "Saturn":
      aspects.push(((house + 2 - 1) % 12) + 1);  // 3rd
      aspects.push(((house + 9 - 1) % 12) + 1);  // 10th
      break;
    case "Rahu":
    case "Ketu":
      aspects.push(((house + 4 - 1) % 12) + 1);  // 5th
      aspects.push(((house + 8 - 1) % 12) + 1);  // 9th
      break;
  }
  
  return [...new Set(aspects)];
}

// Calculate all drishti for a set of planets
function calculateAllDrishti(planets: Record<string, { house: number }>): Drishti[] {
  return Object.entries(planets).map(([planet, data]) => {
    const aspects = calculateDrishti(planet, data.house);
    return {
      planet,
      house: data.house,
      aspects,
      aspectType: "full"
    };
  });
}

function generateSineCurve(rng: SFC32, yBase: number): SeparationCurve {
  const amplitude = rng.randRange(5, 15);
  const frequency = rng.randRange(0.05, 0.15);
  const phase = rng.randRange(0, Math.PI * 2);
  const vertical = yBase + rng.randRange(-5, 5);
  return {
    type: 'sine', start: [0, vertical], end: [100, vertical + amplitude * Math.sin(frequency * 100 + phase)],
    controlPoints: [[25, vertical + amplitude * Math.sin(frequency * 25 + phase)], [50, vertical + amplitude * Math.sin(frequency * 50 + phase)], [75, vertical + amplitude * Math.sin(frequency * 75 + phase)]],
    equation: `y = ${amplitude.toFixed(2)}*sin(${frequency.toFixed(3)}*x + ${phase.toFixed(2)}) + ${vertical.toFixed(2)}`
  };
}

function generateBezierCurve(rng: SFC32, yBase: number): SeparationCurve {
  return {
    type: 'bezier', start: [0, yBase], end: [100, yBase + rng.randRange(-10, 10)],
    controlPoints: [[rng.randRange(20, 40), yBase + rng.randRange(-20, 20)], [rng.randRange(60, 80), yBase + rng.randRange(-20, 20)]]
  };
}

function generatePolylineCurve(rng: SFC32, yBase: number): SeparationCurve {
  const points: [number, number][] = [[0, yBase]];
  let cx = 0, cy = yBase;
  while (cx < 100) {
    cx = Math.min(100, cx + rng.randRange(10, 25));
    cy += rng.randRange(-15, 15);
    points.push([cx, cy]);
  }
  return { type: 'polyline', start: [0, yBase], end: points[points.length - 1], controlPoints: points.slice(1, -1) };
}

function getCurveYAtX(x: number, curve: SeparationCurve): number {
  if (curve.type === 'sine' && curve.equation) {
    const m = curve.equation.match(/y = ([\d.]+)\*sin\(([\d.]+)\*x \+ ([\d.]+)\) \+ ([\d.]+)/);
    if (m) return parseFloat(m[1]) * Math.sin(parseFloat(m[2]) * x + parseFloat(m[3])) + parseFloat(m[4]);
  }
  const pts = [curve.start, ...curve.controlPoints, curve.end];
  for (let i = 0; i < pts.length - 1; i++) {
    if (x >= pts[i][0] && x <= pts[i+1][0]) {
      const t = (x - pts[i][0]) / (pts[i+1][0] - pts[i][0]);
      return pts[i][1] + t * (pts[i+1][1] - pts[i][1]);
    }
  }
  return curve.start[1];
}

function getPointRegion(x: number, y: number, boundaries: { past_present: SeparationCurve; present_future: SeparationCurve }): 'past' | 'present' | 'future' {
  const ypp = getCurveYAtX(x, boundaries.past_present);
  const ypf = getCurveYAtX(x, boundaries.present_future);
  if (y < ypp) return 'past';
  if (y >= ypp && y < ypf) return 'present';
  return 'future';
}

function generateDistribution(seed: string, kavane: Array<{ house: number; cell: number; up: boolean }>): DistributionResult {
  const rng = new SFC32(seedToNumbers(seed));
  const startX = rng.randRange(0, 100), startY = rng.randRange(0, 100);
  const startHouse = Math.min(Math.max(Math.floor(startY / 33.33) * 4 + Math.floor(startX / 25) + 1, 1), 12);
  
  const ct1: CurveType = rng.next() < 0.4 ? 'sine' : (rng.next() < 0.5 ? 'bezier' : 'polyline');
  const ppb = ct1 === 'sine' ? generateSineCurve(rng, 33) : (ct1 === 'bezier' ? generateBezierCurve(rng, 33) : generatePolylineCurve(rng, 33));
  const ct2: CurveType = rng.next() < 0.4 ? 'sine' : (rng.next() < 0.5 ? 'bezier' : 'polyline');
  const pfb = ct2 === 'sine' ? generateSineCurve(rng, 66) : (ct2 === 'bezier' ? generateBezierCurve(rng, 66) : generatePolylineCurve(rng, 66));
  
  let past = 0, present = 0, future = 0;
  const dbh: Record<number, number> = {}; for (let i = 1; i <= 12; i++) dbh[i] = 0;
  
  for (const k of kavane) {
    const hc = (k.house - 1) % 4, hr = Math.floor((k.house - 1) / 4);
    const cx = k.cell % 3, cy = Math.floor(k.cell / 3);
    const x = (hc * 25) + (cx / 3) * 25 + (12.5 / 3);
    const y = (hr * 33.33) + (cy / 4) * 33.33 + (8.33 / 4);
    const pile = getPointRegion(x, y, { past_present: ppb, present_future: pfb });
    if (pile === 'past') past++; else if (pile === 'present') present++; else future++;
    dbh[k.house]++;
  }
  
  const reduce = (n: number) => { const r = n % 8; return r === 0 ? 8 : r; };
  const pastNum = reduce(past), presentNum = reduce(present), futureNum = reduce(future);
  
  // Get pile planets for drishti calculation
  const pastPlanet = getPilePlanet(pastNum);
  const presentPlanet = getPilePlanet(presentNum);
  const futurePlanet = getPilePlanet(futureNum);
  
  // Calculate drishti (aspects) for pile planets
  // Place pile planets in their temporal region houses
  const pilePlanetsForDrishti: Record<string, { house: number }> = {
    [pastPlanet.planet]: { house: 1 },    // Past - House 1 (Lagna)
    [presentPlanet.planet]: { house: 5 }, // Present - House 5 (Trine)
    [futurePlanet.planet]: { house: 9 }   // Future - House 9 (Trine)
  };
  
  const drishtiResults = calculateAllDrishti(pilePlanetsForDrishti);
  const pileAspects: Record<string, { house: number; aspects: number[] }> = {};
  drishtiResults.forEach(d => {
    pileAspects[d.planet] = { house: d.house, aspects: d.aspects };
  });
  
  // Generate analysis text
  const goodCount = [pastNum, presentNum, futureNum].filter(n => n % 2 === 1).length;
  const badCount = 3 - goodCount;
  let analysis = `${goodCount} Good (Odd), ${badCount} Bad (Even). `;
  if (goodCount >= 2) {
    analysis += "Favorable overall indication.";
  } else if (badCount >= 2) {
    analysis += "Challenging overall indication.";
  } else {
    analysis += "Mixed results indicated.";
  }
  
  // Calculate numerology summary
  const pileNumbers = [pastNum, presentNum, futureNum];
  const beneficCount = pileNumbers.filter(n => pileNumerologyData[n].nature === "Benefic").length;
  const maleficCount = pileNumbers.filter(n => pileNumerologyData[n].nature === "Malefic").length;
  const neutralCount = pileNumbers.filter(n => pileNumerologyData[n].nature === "Neutral").length;
  
  // Count elements
  const elementCounts: Record<string, number> = {};
  pileNumbers.forEach(n => {
    const el = pileNumerologyData[n].element;
    elementCounts[el] = (elementCounts[el] || 0) + 1;
  });
  const dominantElement = Object.entries(elementCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "Mixed";
  
  // Determine overall nature
  let dominantNature = "Mixed";
  if (beneficCount >= 2) dominantNature = "Benefic";
  else if (maleficCount >= 2) dominantNature = "Malefic";
  
  // Overall indication
  let overallIndication: "Favorable" | "Mixed" | "Unfavorable" = "Mixed";
  if (goodCount >= 2) overallIndication = "Favorable";
  else if (badCount >= 2) overallIndication = "Unfavorable";
  
  return {
    piles: { past: pastNum, present: presentNum, future: futureNum },
    pile_names: { past: getPileName(pastNum), present: getPileName(presentNum), future: getPileName(futureNum) },
    pile_planets: { past: pastPlanet, present: presentPlanet, future: futurePlanet },
    pile_numerology: {
      all: pileNumerologyData,
      summary: {
        total_benefic: beneficCount,
        total_malefic: maleficCount,
        total_neutral: neutralCount,
        dominant_element: dominantElement,
        dominant_nature: dominantNature,
        overall_indication: overallIndication
      }
    },
    drishti: {
      pile_aspects: pileAspects,
      analysis
    },
    boundaries: { past_present: ppb, present_future: pfb },
    start_point: { x: +startX.toFixed(2), y: +startY.toFixed(2), house: startHouse },
    distribution_by_house: dbh,
    temporal_regions: { past: [12, 1, 2], present: [3, 4, 5, 6], future: [7, 8, 9, 10, 11] }
  };
}

async function handleDistribute(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const seed = body.seed;
    const kavane = body.kavane;
    const birthData = body.birth; // { year, month, day, hour, minute, place, latitude, longitude }
    
    if (!seed) return new Response(JSON.stringify({ success: false, error: "Missing required parameter: 'seed'" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (!kavane || !Array.isArray(kavane) || kavane.length !== 108) return new Response(JSON.stringify({ success: false, error: "Missing required parameter: 'kavane' array with 108 items" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (!/^[0-9a-fA-F]+$/.test(seed)) return new Response(JSON.stringify({ success: false, error: "Seed must be hexadecimal string" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    
    const result = generateDistribution(seed.toLowerCase(), kavane);
    
    // Calculate Jyotisha data from current time (Udaya Lagna)
    const now = new Date();
    const queryHour = now.getHours() + now.getMinutes() / 60;
    const jdNow = dateToJD(now.getFullYear(), now.getMonth() + 1, now.getDate(), queryHour);
    const prasnaChart = calculatePlanets(jdNow);
    
    // Calculate natal chart if birth data provided
    let natalChart = null;
    if (birthData && birthData.year && birthData.month && birthData.day) {
      const birthHour = birthData.hour + (birthData.minute || 0) / 60;
      const jdBirth = dateToJD(birthData.year, birthData.month, birthData.day, birthHour);
      natalChart = calculatePlanets(jdBirth);
    }
    
    return new Response(JSON.stringify({ 
      success: true, 
      seed: seed.substring(0, 32) + (seed.length > 32 ? "..." : ""), 
      start_point: result.start_point, 
      piles: result.piles, 
      pile_names: result.pile_names, 
      pile_planets: result.pile_planets,
      pile_numerology: result.pile_numerology,
      drishti: result.drishti,
      boundaries: result.boundaries, 
      distribution_by_house: result.distribution_by_house, 
      temporal_regions: result.temporal_regions,
      jyotisha: {
        prasna: prasnaChart,
        natal: natalChart,
        timestamp: now.toISOString(),
        ayanamsa: "Lahiri (Chitrapaksha)"
      }
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

// ============ SWARNA/UDAYA LAGNA ENDPOINT ============

interface LagnaResult {
  house: number;
  sign: number;  // 1-12 sign number
  sign_name: string;
  degree: number;  // 0-30 degrees within sign
  nakshatra: string;
  method: string;
  full_degree: number; // 0-360 degree
}

// Calculate Nakshatra from longitude (0-360)
function getNakshatra(longitude: number): { name: string; pada: number } {
  const nakshatras = [
    "Ashwini", "Bharani", "Krittika", "Rohini", "Mrigashira", "Ardra",
    "Punarvasu", "Pushya", "Ashlesha", "Magha", "Purva Phalguni", "Uttara Phalguni",
    "Hasta", "Chitra", "Swati", "Vishakha", "Anuradha", "Jyeshtha",
    "Mula", "Purva Ashadha", "Uttara Ashadha", "Shravana", "Dhanishta", "Shatabhisha",
    "Purva Bhadrapada", "Uttara Bhadrapada", "Revati"
  ];
  // Each nakshatra is 13°20' (13.333... degrees)
  const nakshatraIndex = Math.floor(longitude / (360 / 27));
  const pada = Math.floor((longitude % (360 / 27)) / (360 / 108)) + 1;
  return { 
    name: nakshatras[nakshatraIndex] || "Unknown", 
    pada: Math.min(pada, 4) 
  };
}

// Calculate Udaya Lagna (Ascendant) from time and location - Lahiri Ayanamsa
function calculateUdayaLagna(jd: number, lat: number = 0, lng: number = 0): LagnaResult {
  // Get Sun's position as base
  const sunTropical = getTropicalLongitude('Sun', jd);
  const ayanamsa = getLahiriAyanamsa(jd);
  const sunSidereal = (sunTropical - ayanamsa + 360) % 360;
  
  // Approximate Local Sidereal Time (LST)
  // LST at midnight + time elapsed * sidereal rate
  const jd2000 = 2451545.0;
  const daysSince2000 = jd - jd2000;
  const lst = (280.46061837 + 360.98564736629 * daysSince2000 + lng) % 360;
  
  // Ascendant (Lagna) approximation
  // The ascendant is roughly LST + 90° (adjusted for obliquity)
  // This is a simplified calculation - full calculation would involve
  // the obliquity of the ecliptic and more precise spherical trig
  let ascendantDeg = (lst + 90) % 360;
  
  // Adjust for latitude (simplified)
  // At higher latitudes, the ascendant moves faster/slower
  const latCorrection = Math.sin(lat * Math.PI / 180) * 15;
  ascendantDeg = (ascendantDeg + latCorrection + 360) % 360;
  
  // Convert to sidereal
  const ascendantSidereal = (ascendantDeg - ayanamsa + 360) % 360;
  
  const sign = Math.floor(ascendantSidereal / 30) + 1;
  const degree = ascendantSidereal % 30;
  const nakshatra = getNakshatra(ascendantSidereal);
  
  return {
    house: sign,  // In equal house system, house 1 = ascendant sign
    sign,
    sign_name: getRashiName(sign),
    degree: Math.round(degree * 100) / 100,
    nakshatra: `${nakshatra.name} (${nakshatra.pada})`,
    method: lat !== 0 || lng !== 0 ? "lahiri_astronomical_with_location" : "lahiri_astronomical_approximate",
    full_degree: Math.round(ascendantSidereal * 100) / 100
  };
}

// Calculate Swarna Aroodham from beacon entropy
// Maps the full beacon entropy (0 to 2^N-1) to 0-360 degrees
function calculateSwarnaFromBeacon(beaconHex: string): LagnaResult {
  // Use the full bit strength of the beacon
  // Convert hex to BigInt for arbitrary precision
  const beaconValue = BigInt('0x' + beaconHex);
  const maxValue = BigInt('0x' + 'f'.repeat(beaconHex.length));
  
  // Map to 0-360 degrees: degree = (beaconValue / maxValue) * 360
  const degree360 = Number((beaconValue * BigInt(3600000)) / maxValue) / 10000;
  const normalizedDegree = degree360 % 360;
  
  // Convert to Vedic house/sign system
  const sign = Math.floor(normalizedDegree / 30) + 1;
  const degreeInSign = normalizedDegree % 30;
  const nakshatra = getNakshatra(normalizedDegree);
  
  return {
    house: sign,
    sign,
    sign_name: getRashiName(sign),
    degree: Math.round(degreeInSign * 100) / 100,
    nakshatra: `${nakshatra.name} (${nakshatra.pada})`,
    method: "beacon_entropy",
    full_degree: Math.round(normalizedDegree * 100) / 100
  };
}

async function handleSwarna(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { bitstring, beacon, lat, lng } = body;
    
    // Validate inputs
    if (!bitstring || typeof bitstring !== 'string') {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required parameter: 'bitstring'" }), 
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    // Get current time for Udaya calculation
    const now = new Date();
    const queryHour = now.getHours() + now.getMinutes() / 60;
    const jd = dateToJD(now.getFullYear(), now.getMonth() + 1, now.getDate(), queryHour);
    
    // Calculate Udaya Lagna (astronomical - Lahiri Ayanamsa)
    const latitude = lat !== undefined ? Number(lat) : 0;
    const longitude = lng !== undefined ? Number(lng) : 0;
    const udaya = calculateUdayaLagna(jd, latitude, longitude);
    
    // Calculate Swarna from beacon if provided, otherwise from bitstring
    let swarna: LagnaResult;
    if (beacon && typeof beacon === 'string' && /^[0-9a-fA-F]+$/.test(beacon)) {
      // Use fresh beacon entropy
      swarna = calculateSwarnaFromBeacon(beacon.toLowerCase());
    } else {
      // Fallback: use bitstring as entropy source
      swarna = calculateSwarnaFromBeacon(bitstring.toLowerCase());
    }
    
    // Calculate angular difference
    const diff = Math.abs(swarna.full_degree - udaya.full_degree);
    const angDist = Math.min(diff, 360 - diff);
    
    // Determine tulya type
    let tulya_type = "different";
    if (angDist < 3) tulya_type = "sama"; // Within 3 degrees = essentially same
    else if (angDist <= 30) tulya_type = "adjacent";
    else if (angDist >= 177 && angDist <= 183) tulya_type = "opposite"; // Atulya
    else if ([120, 240].includes(Math.round(angDist))) tulya_type = "trine";
    else if ([90, 270].includes(Math.round(angDist))) tulya_type = "kendra";
    
    return new Response(
      JSON.stringify({
        success: true,
        swarna,
        udaya,
        tulya_type,
        angular_distance: Math.round(angDist * 100) / 100,
        timestamp: now.toISOString(),
        location: latitude !== 0 || longitude !== 0 ? { lat: latitude, lng: longitude } : null,
        beacon_used: !!beacon
      }), 
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }), 
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
  if (path.includes("/distribute")) {
    return await handleDistribute(req);
  } else if (path.includes("/swarna")) {
    return await handleSwarna(req);
  } else if (path.includes("/beacon") || path === "/beacon") {
    return await handleBeacon(req);
  } else if (path.includes("/chacha20/derive") || path === "/chacha20/derive") {
    return await handleChaCha20Derive(req);
  } else {
    // Default to disperse handler
    return await handleDisperse(req);
  }
});
