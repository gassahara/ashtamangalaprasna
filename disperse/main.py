"""
Supabase Edge Function: disperse

Simulates spatial distribution of shapes in a grid with hole constraints.
"""

import json
import math
import hashlib
import secrets
import urllib.request
import os
from typing import List, Tuple, Optional


# ============ RANDOMNESS ============

class ChaCha20RNG:
    """CSPRNG using hash-based derivation for reproducibility.
    
    Accepts a 512-bit beacon string (128 hex chars) or generates local entropy.
    """
    
    def __init__(self, beacon_hex: str = None, bits_per_step: int = 128):
        """Initialize RNG with a 512-bit beacon string (128 hex chars)."""
        if beacon_hex:
            # Validate: must be 128 hex chars = 512 bits = 64 bytes
            beacon_hex = beacon_hex.strip()
            if len(beacon_hex) != 128:
                raise ValueError(f"Beacon must be 128 hex characters (512 bits), got {len(beacon_hex)}")
            try:
                self.beacon = bytes.fromhex(beacon_hex)
            except ValueError:
                raise ValueError("Beacon must be valid hexadecimal string")
            self.using_beacon = True
        else:
            # Generate 512 bits (64 bytes) of local entropy
            self.beacon = secrets.token_bytes(64)
            self.using_beacon = False
        
        self.bits_per_step = bits_per_step
        self.block_counter = 0
        self.buffer = b''
        
        # Derive working key from beacon
        self._derive_key()
    
    def _derive_key(self):
        """Derive internal key from 512-bit beacon using SHA-256."""
        # Split beacon into two 256-bit halves for additional mixing
        half1 = self.beacon[:32]
        half2 = self.beacon[32:]
        
        # Derive key using both halves
        self.key = hashlib.sha256(half1 + b'key_derivation' + half2).digest()
        self.nonce = hashlib.sha256(half2 + b'nonce' + half1).digest()[:12]
    
    def _generate_block(self, counter: int) -> bytes:
        """Generate deterministic random block."""
        data = self.key + self.nonce + counter.to_bytes(8, 'big')
        return hashlib.sha256(data).digest() + hashlib.sha256(data + b'x').digest()
    
    def get_random_bytes(self, n: int) -> bytes:
        """Get n random bytes."""
        while len(self.buffer) < n:
            self.buffer += self._generate_block(self.block_counter)
            self.block_counter += 1
        
        result = self.buffer[:n]
        self.buffer = self.buffer[n:]
        
        # XOR with local entropy for hybrid randomness (always add unpredictability)
        local = secrets.token_bytes(n)
        return bytes(a ^ b for a, b in zip(result, local))
    
    def get_random_int(self, max_val: int) -> int:
        """Get random integer in [0, max_val)."""
        if max_val <= 0:
            return 0
        rand_bytes = self.get_random_bytes(8)
        rand_int = int.from_bytes(rand_bytes, 'big')
        return rand_int % max_val
    
    def get_beacon_hex(self) -> str:
        """Return the beacon as hex string."""
        return self.beacon.hex()


class ChaCha20Deriver:
    """
    Deterministic random bitstring derivation with uniform distribution.
    
    Takes a variable-length seed and input blocks to produce N bits of output.
    The seed is thoroughly mixed throughout the entire N-length output.
    
    KEY PROPERTIES:
    - Seed length Y can be any valid hex string (variable length)
    - Input provides the data blocks to be processed
    - Every output bit depends on every seed bit (full mixing)
    - Uniform distribution (repetitions/overlaps allowed per probability)
    - Deterministic and reversible (same inputs → same output)
    
    CONSTRUCTION (for block i):
      block_i = Mix(seed, input_block_i, seed)
      
    Where Mix uses multiple SHA-512 rounds to ensure full seed propagation.
    """
    
    def __init__(self, seed_hex: str, input_hex: str):
        """
        Initialize with variable-length seed and input.
        
        Args:
            seed_hex: Hex string of any even length (Y bits, Y >= 64 recommended)
            input_hex: Hex string (the data blocks to process, will be split into 64-byte chunks)
        """
        # Validate seed - must be valid hex, minimum 64 bits (16 hex chars) recommended
        seed_hex = seed_hex.strip().lower()
        if len(seed_hex) < 2 or len(seed_hex) % 2 != 0:
            raise ValueError(f"Seed must be at least 2 hex chars and even length, got {len(seed_hex)}")
        try:
            self.seed = bytes.fromhex(seed_hex)
        except ValueError:
            raise ValueError("Seed must be valid hexadecimal string")
        
        # Validate input - must be valid hex
        input_hex = input_hex.strip().lower()
        if len(input_hex) % 2 != 0:
            raise ValueError(f"Input must have even length, got {len(input_hex)}")
        if len(input_hex) < 2:
            raise ValueError(f"Input must be at least 2 hex chars, got {len(input_hex)}")
        try:
            self.input_data = bytes.fromhex(input_hex)
        except ValueError:
            raise ValueError("Input must be valid hexadecimal string")
    
    def _split_input_into_blocks(self, block_size: int = 64) -> List[bytes]:
        """Split input data into fixed-size blocks."""
        blocks = []
        for i in range(0, len(self.input_data), block_size):
            block = self.input_data[i:i+block_size]
            # Pad last block if needed
            if len(block) < block_size:
                block = block + bytes(block_size - len(block))
            blocks.append(block)
        return blocks
    
    def _mix_block(self, input_block: bytes, block_idx: int) -> bytes:
        """
        Mix a single input block with the seed.
        
        Uses multiple rounds of SHA-512 to ensure every output bit
        depends on every bit of the seed and input block.
        
        Mixing rounds:
          1. Hash(seed || input_block || block_idx)
          2. Hash(result || seed)
          3. Hash(result || input_block || seed)
          4. Hash(result || seed || block_idx)
        """
        # Block index as 8 bytes
        idx_bytes = block_idx.to_bytes(8, 'big')
        
        # Round 1: Initial mixing of seed, input, and index
        # This binds the block to its position and the seed
        state = hashlib.sha512(self.seed + input_block + idx_bytes).digest()
        
        # Round 2: Mix with seed
        # Propagate seed influence throughout
        state = hashlib.sha512(state + self.seed).digest()
        
        # Round 3: Mix with input and seed again
        # Ensure input data affects all bits
        state = hashlib.sha512(state + input_block + self.seed).digest()
        
        # Round 4: Final mixing with seed and index
        # Final avalanche and position binding
        state = hashlib.sha512(state + self.seed + idx_bytes).digest()
        
        return state
    
    def derive_bits(self, n_bits: int) -> str:
        """
        Derive N bits of output as hex string.
        
        The input data is split into blocks, each mixed with the seed.
        If N requires more blocks than input provides, blocks are reused
        with different mixing (seed || block || counter).
        
        Every output bit depends on every seed bit.
        
        Args:
            n_bits: Number of bits to derive
        
        Returns:
            Hex string of derived bits
        """
        if n_bits <= 0:
            raise ValueError("n_bits must be positive")
        if n_bits > 524288:  # Max 64KB = 524288 bits
            raise ValueError("n_bits cannot exceed 524288 (64KB)")
        
        # Calculate bytes needed
        n_bytes = (n_bits + 7) // 8
        
        # Split input into 64-byte blocks
        input_blocks = self._split_input_into_blocks(64)
        
        # Generate output by mixing blocks
        output = b''
        block_idx = 0
        
        while len(output) < n_bytes:
            # Cycle through input blocks if we need more output
            input_block = input_blocks[block_idx % len(input_blocks)]
            
            # Mix this block with seed
            mixed = self._mix_block(input_block, block_idx)
            
            output += mixed
            block_idx += 1
        
        # Trim to exact bytes needed
        output = output[:n_bytes]
        
        # Convert to hex
        hex_output = output.hex()
        
        # If n_bits is not a multiple of 8, mask the last byte
        extra_bits = (n_bytes * 8) - n_bits
        if extra_bits > 0:
            last_byte = output[-1]
            mask = (0xFF >> extra_bits)
            last_byte_masked = last_byte & mask
            hex_output = output[:-1].hex() + format(last_byte_masked, '02x')
        
        return hex_output
    
    def derive_bytes(self, n_bytes: int) -> bytes:
        """Derive N bytes of output."""
        if n_bytes <= 0:
            raise ValueError("n_bytes must be positive")
        if n_bytes > 65536:  # Max 64KB
            raise ValueError("n_bytes cannot exceed 65536 (64KB)")
        
        # Split input into 64-byte blocks
        input_blocks = self._split_input_into_blocks(64)
        
        output = b''
        block_idx = 0
        
        while len(output) < n_bytes:
            input_block = input_blocks[block_idx % len(input_blocks)]
            mixed = self._mix_block(input_block, block_idx)
            output += mixed
            block_idx += 1
        
        return output[:n_bytes]


# ============ GRID CONSTRAINTS ============

class GridConstraints:
    """Manages grid lines and holes."""
    
    def __init__(self, s_grid: int, v_lines: List[int], h_lines: List[int], holes: List[List[int]]):
        self.s_grid = s_grid
        self.v_lines = sorted(v_lines)
        self.h_lines = sorted(h_lines)
        self.holes = set(tuple(h) for h in holes)
        
        self.x_bounds = [0] + self.v_lines + [s_grid]
        self.y_bounds = [0] + self.h_lines + [s_grid]
        self.num_cols = len(self.x_bounds) - 1
        self.num_rows = len(self.y_bounds) - 1
    
    def get_cell(self, x: int, y: int) -> Tuple[int, int]:
        col = 0
        for i in range(len(self.x_bounds) - 1):
            if self.x_bounds[i] <= x < self.x_bounds[i + 1]:
                col = i
                break
        else:
            col = self.num_cols - 1
        
        row = 0
        for i in range(len(self.y_bounds) - 1):
            if self.y_bounds[i] <= y < self.y_bounds[i + 1]:
                row = i
                break
        else:
            row = self.num_rows - 1
        
        return (row, col)
    
    def is_valid(self, x: int, y: int, margin: int = 0) -> bool:
        if self.get_cell(x, y) in self.holes:
            return False
        if margin > 0:
            for dx in [-margin, 0, margin]:
                for dy in [-margin, 0, margin]:
                    cx, cy = x + dx, y + dy
                    if 0 <= cx < self.s_grid and 0 <= cy < self.s_grid:
                        if self.get_cell(cx, cy) in self.holes:
                            return False
        return True
    
    def bounce(self, prev_x: int, prev_y: int, new_x: int, new_y: int, margin: int) -> Tuple[int, int]:
        """Bounce off hole boundary."""
        if self.is_valid(new_x, new_y, margin):
            return (new_x, new_y)
        
        best_x, best_y = prev_x, prev_y
        for i in range(1, 21):
            t = i / 20.0
            test_x = int(prev_x + (new_x - prev_x) * t)
            test_y = int(prev_y + (new_y - prev_y) * t)
            if self.is_valid(test_x, test_y, margin):
                best_x, best_y = test_x, test_y
        
        return (max(0, min(self.s_grid - 1, best_x)), 
                max(0, min(self.s_grid - 1, best_y)))
    
    def random_valid(self, rng: ChaCha20RNG) -> Tuple[int, int]:
        valid_cells = [(r, c) for r in range(self.num_rows) 
                      for c in range(self.num_cols) if (r, c) not in self.holes]
        
        if not valid_cells:
            return (self.s_grid // 2, self.s_grid // 2)
        
        idx = rng.get_random_int(len(valid_cells))
        row, col = valid_cells[idx]
        
        x_min, x_max = self.x_bounds[col], self.x_bounds[col + 1]
        y_min, y_max = self.y_bounds[row], self.y_bounds[row + 1]
        
        x = x_min + rng.get_random_int(x_max - x_min)
        y = y_min + rng.get_random_int(y_max - y_min)
        
        return (x, y)


# ============ SHAPE ============

class Shape:
    """Geometric shape for spatial simulation.
    
    For circles: num_sides=0, params=[radius]
    For lines: num_sides=2, params=[length]
    For polygons: num_sides=n, params=[side1, side2, ...] (n-1 sides given)
    
    For non-symmetrical polygons:
    - num_rotations: number of allowed rotation positions (1=none, 2=0/90, 4=0/45/90/135, etc.)
    - enable_mirror: whether mirroring is enabled (True=allow mirror randomization)
    
    When per_step_orientation=True, rotation_index and current_mirror are randomized each step.
    """
    def __init__(self, num_sides: int, params: List[int], num_rotations: int = 1, 
                 enable_mirror: bool = False):
        self.num_sides = num_sides
        self.params = params
        self.num_rotations = max(1, num_rotations)
        self.enable_mirror = enable_mirror
        self.rotation_index = 0
        self.current_mirror = False
    
    def set_orientation(self, rotation_index: int, mirror: bool = False):
        """Set current orientation state (called per step)."""
        if self.num_rotations > 1:
            self.rotation_index = rotation_index % self.num_rotations
        else:
            self.rotation_index = 0
        self.current_mirror = mirror and self.enable_mirror
    
    def get_rotation_angle(self) -> float:
        """Get actual rotation angle in degrees (0-180 range)."""
        if self.num_rotations <= 1:
            return 0.0
        return (self.rotation_index * 180.0) / self.num_rotations
    
    def get_effective_mirror(self) -> bool:
        """Get current mirror state."""
        return self.current_mirror and self.enable_mirror
    
    def _apply_rotation(self, width: int, height: int) -> Tuple[int, int]:
        """Apply rotation to bounding box dimensions."""
        angle = self.get_rotation_angle()
        if angle == 0:
            return (width, height)
        
        rad = math.radians(angle)
        cos_a = abs(math.cos(rad))
        sin_a = abs(math.sin(rad))
        
        new_width = int(width * cos_a + height * sin_a)
        new_height = int(width * sin_a + height * cos_a)
        
        return (max(1, new_width), max(1, new_height))
    
    def get_bounding_box(self) -> Tuple[int, int]:
        """Get (width, height) of bounding box, accounting for rotation."""
        if self.num_sides == 0:
            # Circle: diameter x diameter (rotation doesn't matter)
            r = self.params[0] if self.params else 1
            return (2 * r, 2 * r)
        elif self.num_sides == 2:
            # Line: length x thickness
            length = self.params[0] if self.params else 10
            thickness = max(1, length // 10)
            return self._apply_rotation(length, thickness)
        else:
            max_side = max(self.params) if self.params else 10
            w = h = max_side * 2
            return self._apply_rotation(w, h)


# ============ SIMULATION ============

def resolve_overlaps(points: List[Tuple[int, int]], shape: Shape, s_grid: int) -> List[Tuple[int, int]]:
    box_w, box_h = shape.get_bounding_box()
    min_sep_x, min_sep_y = box_w, box_h
    
    for _ in range(50):
        moved = False
        new_points = list(points)
        
        for i in range(len(new_points)):
            for j in range(i + 1, len(new_points)):
                x1, y1 = new_points[i]
                x2, y2 = new_points[j]
                
                dx, dy = abs(x1 - x2), abs(y1 - y2)
                
                if dx < min_sep_x and dy < min_sep_y:
                    if dx < min_sep_x:
                        overlap = min_sep_x - dx
                        if x1 < x2:
                            x1 -= overlap // 2 + 1
                            x2 += overlap // 2 + 1
                        else:
                            x1 += overlap // 2 + 1
                            x2 -= overlap // 2 + 1
                    
                    if dy < min_sep_y:
                        overlap = min_sep_y - dy
                        if y1 < y2:
                            y1 -= overlap // 2 + 1
                            y2 += overlap // 2 + 1
                        else:
                            y1 += overlap // 2 + 1
                            y2 -= overlap // 2 + 1
                    
                    x1 = max(0, min(s_grid - 1, x1))
                    y1 = max(0, min(s_grid - 1, y1))
                    x2 = max(0, min(s_grid - 1, x2))
                    y2 = max(0, min(s_grid - 1, y2))
                    
                    new_points[i] = (x1, y1)
                    new_points[j] = (x2, y2)
                    moved = True
        
        points = new_points
        if not moved:
            break
    
    return points


def throw_step(points, R_grid, step_size, s_grid, rng, grid_constraints, margin):
    if points:
        avg_x = sum(p[0] for p in points) // len(points)
        avg_y = sum(p[1] for p in points) // len(points)
    else:
        avg_x, avg_y = s_grid // 2, s_grid // 2
    
    region = max(R_grid * 4, s_grid // 10)
    region = min(region, s_grid // 2)
    
    cx = avg_x + rng.get_random_int(2 * region) - region
    cy = avg_y + rng.get_random_int(2 * region) - region
    cx = max(0, min(s_grid - 1, cx))
    cy = max(0, min(s_grid - 1, cy))
    
    new_points = []
    for (prev_x, prev_y) in points:
        x, y = prev_x, prev_y
        dx, dy = x - cx, y - cy
        
        if dx * dx + dy * dy <= R_grid * R_grid:
            x, y = cx, cy
            angle = rng.get_random_int(65536) / 65536 * 2 * math.pi
            dist = rng.get_random_int(65536) / 65536 * step_size
            x += int(dist * math.cos(angle))
            y += int(dist * math.sin(angle))
        
        x = max(0, min(s_grid - 1, x))
        y = max(0, min(s_grid - 1, y))
        
        if grid_constraints and margin > 0:
            if not grid_constraints.is_valid(x, y, margin):
                x, y = grid_constraints.bounce(prev_x, prev_y, x, y, margin)
        
        new_points.append((x, y))
    
    return new_points


def randomize_orientation(shape: Shape, rng: ChaCha20RNG) -> int:
    """Randomize shape orientation for current step. Returns bits used."""
    bits_used = 0
    
    # Randomize rotation index if multiple rotations enabled
    if shape.num_rotations > 1:
        rotation_index = rng.get_random_int(shape.num_rotations)
        bits_used += math.ceil(math.log2(shape.num_rotations))
    else:
        rotation_index = 0
    
    # Randomize mirror if enabled
    if shape.enable_mirror:
        mirror = rng.get_random_int(2) == 1
        bits_used += 1
    else:
        mirror = False
    
    shape.set_orientation(rotation_index, mirror)
    return bits_used


def simulate(N, steps, R_grid, s_grid, shape, rng, grid_constraints, per_step_orientation: bool = True):
    box_w, box_h = shape.get_bounding_box()
    margin = max(box_w, box_h) // 2 + 1
    
    points = []
    center = s_grid // 2
    for _ in range(N):
        if grid_constraints:
            x, y = grid_constraints.random_valid(rng)
        else:
            x = center + rng.get_random_int(256) - 128
            y = center + rng.get_random_int(256) - 128
            x = max(0, min(s_grid - 1, x))
            y = max(0, min(s_grid - 1, y))
        points.append((x, y))
    
    points = resolve_overlaps(points, shape, s_grid)
    step_size = max(1, s_grid // 4)
    
    total_bits = 0
    orientation_history = []
    
    for step in range(steps):
        # Randomize orientation per step if enabled
        if per_step_orientation and (shape.num_rotations > 1 or shape.enable_mirror):
            orient_bits = randomize_orientation(shape, rng)
            total_bits += orient_bits
            orientation_history.append({
                'step': step,
                'rotation_index': shape.rotation_index,
                'rotation_angle': shape.get_rotation_angle(),
                'mirror': shape.get_effective_mirror()
            })
            # Recalculate margin based on new bounding box
            box_w, box_h = shape.get_bounding_box()
            margin = max(box_w, box_h) // 2 + 1
        
        prev_points = list(points)
        points = throw_step(points, R_grid, step_size, s_grid, rng, grid_constraints, margin)
        points = resolve_overlaps(points, shape, s_grid)
        
        if grid_constraints:
            for i, (x, y) in enumerate(points):
                if not grid_constraints.is_valid(x, y, margin):
                    px, py = prev_points[i]
                    points[i] = grid_constraints.bounce(px, py, x, y, margin)
    
    return points, total_bits, orientation_history


# ============ REQUEST HANDLER ============

class Request:
    """Simple request wrapper."""
    def __init__(self, body: bytes = None, json_data: dict = None, method: str = "POST"):
        self._body = body
        self._json = json_data
        self.method = method
    
    def body(self):
        return self._body
    
    def json(self):
        if self._json is not None:
            return self._json
        if self._body:
            return json.loads(self._body.decode())
        return {}


# ============ BEACON ENDPOINT ============

def fetch_beacon_from_url(url: str, timeout: int = 10) -> str:
    """
    Fetch a 512-bit beacon from a URL.
    
    Supports:
    - NIST Randomness Beacon format (XML)
    - Raw hex response
    - JSON with 'pulse' or 'outputValue' field
    """
    try:
        req = urllib.request.Request(
            url,
            headers={
                'User-Agent': 'disperse-beacon-fetcher/1.0',
                'Accept': 'application/json, application/xml, text/plain'
            }
        )
        
        with urllib.request.urlopen(req, timeout=timeout) as response:
            content = response.read().decode('utf-8')
            
            # Try to extract beacon from various formats
            beacon_hex = extract_beacon_from_content(content)
            
            if beacon_hex and len(beacon_hex) == 128:
                return beacon_hex.lower()
            else:
                raise ValueError(f"Could not extract 512-bit beacon from response. Got: {beacon_hex[:32] if beacon_hex else 'none'}...")
                
    except urllib.error.URLError as e:
        raise ValueError(f"Failed to fetch beacon from URL: {e}")
    except Exception as e:
        raise ValueError(f"Error fetching beacon: {e}")


def extract_beacon_from_content(content: str) -> str:
    """Extract beacon hex from various response formats."""
    content = content.strip()
    
    # Try JSON format first
    if content.startswith('{') or content.startswith('['):
        try:
            data = json.loads(content)
            # Try common field names
            for field in ['pulse', 'outputValue', 'value', 'beacon', 'seed', 'random', 'data']:
                if isinstance(data, dict) and field in data:
                    value = data[field]
                    if isinstance(value, str):
                        return value.strip().lower()
                    elif isinstance(value, dict) and 'outputValue' in value:
                        return value['outputValue'].strip().lower()
        except json.JSONDecodeError:
            pass
    
    # Try XML format (NIST beacon)
    if content.startswith('<') or '<?xml' in content[:100]:
        import re
        # Look for outputValue or pulseValue tags
        patterns = [
            r'<outputValue>([0-9a-fA-F]+)</outputValue>',
            r'<pulseValue>([0-9a-fA-F]+)</pulseValue>',
            r'<value>([0-9a-fA-F]+)</value>',
        ]
        for pattern in patterns:
            match = re.search(pattern, content)
            if match:
                return match.group(1).strip().lower()
    
    # Try raw hex (128 hex chars)
    # Remove whitespace and check if it's a hex string
    cleaned = ''.join(content.split())
    if len(cleaned) == 128 and all(c in '0123456789abcdefABCDEF' for c in cleaned):
        return cleaned.lower()
    
    return None


def handler_beacon(req: Request):
    """
    Beacon endpoint - fetches a 512-bit beacon from an external URL.
    
    GET /beacon
    
    Returns a 512-bit beacon (128 hex characters) fetched from a configured URL.
    If fetching fails, generates local entropy.
    """
    try:
        # Get beacon URL from environment or use default
        # Default: NIST Randomness Beacon (last pulse)
        beacon_url = os.environ.get(
            'BEACON_URL',
            'https://beacon.nist.gov/beacon/2.0/pulse/last'
        )
        
        # Also allow override via query param for testing
        # (In real deployment, might want to restrict this)
        
        try:
            # Fetch beacon from external source
            beacon_hex = fetch_beacon_from_url(beacon_url)
            source = "external"
        except Exception as e:
            # Fallback to local entropy if fetch fails
            beacon_hex = secrets.token_bytes(64).hex()
            source = "generated"
        
        # Create response
        result = {
            "success": True,
            "beacon": {
                "value": beacon_hex,
                "hex": beacon_hex,
                "bits": 512,
                "bytes": 64,
                "source": source,
                "url": beacon_url if source == "external" else None
            },
            "seed": beacon_hex,
            "usage": {
                "endpoint": "/disperse",
                "parameter": "seed",
                "description": "Pass this seed value to the /disperse endpoint"
            }
        }
        
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(result)
        }
        
    except Exception as e:
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"success": False, "error": str(e)})
        }


# ============ DISPERSE ENDPOINT ============

def handler_disperse(req: Request):
    """Main disperse endpoint - accepts seed as hex bitstring."""
    try:
        body = req.json()
        
        # Extract parameters
        N = int(body.get('N', 100))
        steps = int(body.get('steps', 50))
        R_grid = int(body.get('R_grid', 50))
        s_grid = int(body.get('s_grid', 500))
        num_sides = int(body.get('num_sides', 0))
        
        # Support both 'shape_params' and 'edges' for side lengths
        shape_params = body.get('shape_params') or body.get('edges') or [3]
        if not isinstance(shape_params, list):
            shape_params = [shape_params]
        
        num_rotations = int(body.get('num_rotations', 1))
        enable_mirror = bool(body.get('enable_mirror', False))
        
        # Grid lines (support both v_lines/h_lines and vertical_lines/horizontal_lines)
        v_lines = body.get('v_lines') or body.get('vertical_lines') or []
        h_lines = body.get('h_lines') or body.get('horizontal_lines') or []
        
        # Holes (forbidden cells)
        holes = body.get('holes') or body.get('forbidden_cells') or []
        
        # Get seed (hex bitstring) - can be 128 chars (512 bits) or shorter
        # Supports legacy 'entropy_seed' and new 'seed' parameter
        seed = body.get('seed') or body.get('entropy_seed')
        
        # Validate seed if provided
        if seed:
            seed = seed.strip().lower()
            # Ensure it's valid hex
            try:
                bytes.fromhex(seed)
            except ValueError:
                return {
                    "statusCode": 400,
                    "headers": {"Content-Type": "application/json"},
                    "body": json.dumps({
                        "success": False,
                        "error": "Seed must be a valid hexadecimal string"
                    })
                }
            # If seed is shorter than 128 chars, extend it
            if len(seed) < 128:
                # Extend seed to 512 bits by hashing and concatenating
                seed_bytes = bytes.fromhex(seed)
                extended = hashlib.sha256(seed_bytes).digest() + hashlib.sha256(seed_bytes + b'padding').digest()
                seed = extended.hex()
        
        # Create components
        rng = ChaCha20RNG(beacon_hex=seed)
        shape = Shape(num_sides, shape_params, num_rotations, enable_mirror)
        
        grid_constraints = None
        if v_lines or h_lines or holes:
            grid_constraints = GridConstraints(s_grid, v_lines, h_lines, holes)
        
        # Run simulation
        points, orient_bits_used, orientation_history = simulate(N, steps, R_grid, s_grid, shape, rng, grid_constraints)
        
        # Build response
        result = {
            "success": True,
            "parameters": {
                "N": N,
                "steps": steps,
                "R_grid": R_grid,
                "s_grid": s_grid,
                "num_sides": num_sides,
                "shape_params": shape_params,
                "edges": shape_params,
                "num_rotations": num_rotations,
                "enable_mirror": enable_mirror,
                "v_lines": v_lines,
                "h_lines": h_lines,
                "holes": holes,
                "seed": rng.get_beacon_hex() if rng.using_beacon else None,
                "seed_source": "beacon" if rng.using_beacon else "local_entropy"
            },
            "results": {
                "total_points": len(points),
                "points": [{"id": i + 1, "x": x, "y": y} for i, (x, y) in enumerate(points)],
                "orientation_entropy_bits": orient_bits_used,
                "orientation_history_sample": orientation_history[:5] if orientation_history else []
            }
        }
        
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(result)
        }
        
    except ValueError as e:
        return {
            "statusCode": 400,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"success": False, "error": str(e)})
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"success": False, "error": str(e)})
        }


# ============ CHACHA20RNG DERIVE ENDPOINT ============

def handler_chacha20_derive(req: Request):
    """
    ChaCha20RNG derivation endpoint - produces deterministic random bitstring.
    
    POST /chacha20/derive
    Body: {
        "seed": "a1b2c3d4...",      # Variable length hex (Y bits) - the randomness source
        "input": "e5f6a1b2...",     # Variable length hex (the data blocks to mix)
        "n_bits": 256               # Number of bits to derive (default: 256)
    }
    
    Returns N bits of deterministic output with uniform distribution.
    Every bit of output depends on every bit of seed.
    Same seed + input always produces same output.
    """
    try:
        body = req.json()
        
        # Extract parameters
        seed_hex = body.get('seed')
        input_hex = body.get('input')
        n_bits = int(body.get('n_bits', 256))
        
        # Validate required parameters
        if not seed_hex:
            return {
                "statusCode": 400,
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps({
                    "success": False,
                    "error": "Missing required parameter: 'seed' (hex string, min 64 bits recommended)"
                })
            }
        
        if not input_hex:
            return {
                "statusCode": 400,
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps({
                    "success": False,
                    "error": "Missing required parameter: 'input' (hex string, the data blocks)"
                })
            }
        
        # Validate n_bits
        if n_bits <= 0 or n_bits > 524288:
            return {
                "statusCode": 400,
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps({
                    "success": False,
                    "error": "n_bits must be between 1 and 524288 (64KB)"
                })
            }
        
        # Create deriver and generate output
        deriver = ChaCha20Deriver(seed_hex, input_hex)
        output_hex = deriver.derive_bits(n_bits)
        
        # Calculate output stats
        n_bytes = (n_bits + 7) // 8
        seed_bits = len(seed_hex) * 4
        input_bits = len(input_hex) * 4
        
        result = {
            "success": True,
            "parameters": {
                "seed_length": len(seed_hex),
                "seed_bits": seed_bits,
                "input_length": len(input_hex),
                "input_bits": input_bits,
                "n_bits": n_bits,
                "n_bytes": n_bytes
            },
            "output": {
                "hex": output_hex,
                "bits": n_bits,
                "bytes": n_bytes
            },
            "algorithm": {
                "name": "ChaCha20Deriver",
                "description": "Deterministic random bitstring with uniform distribution. Every output bit depends on every seed bit via multi-round SHA-512 mixing.",
                "properties": [
                    "Variable seed length (Y bits)",
                    "Variable input data blocks",
                    "Uniform distribution",
                    "Full seed propagation throughout N-length output",
                    "Deterministic (same inputs → same output)"
                ]
            }
        }
        
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(result)
        }
        
    except ValueError as e:
        return {
            "statusCode": 400,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"success": False, "error": str(e)})
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"success": False, "error": str(e)})
        }


# ============ DISTRIBUTE ENDPOINT (XY Separation Curves for Temporal Piles) ============

def seed_to_numbers(seed_hex: str) -> List[int]:
    """Convert seed hex string to numeric array for RNG."""
    nums = []
    for i in range(0, len(seed_hex), 4):
        chunk = seed_hex[i:i+4]
        try:
            nums.append(int(chunk, 16))
        except ValueError:
            nums.append(0)
    return nums


class SFC32:
    """Fast, high-quality random number generator."""
    
    def __init__(self, seed: List[int]):
        self.a = seed[0] if len(seed) > 0 else 0
        self.b = seed[1] if len(seed) > 1 else 0
        self.c = seed[2] if len(seed) > 2 else 0
        self.d = seed[3] if len(seed) > 3 else 0
        # Warm up
        for _ in range(12):
            self.next()
    
    def next(self) -> float:
        self.a = (self.a & 0xFFFFFFFF) >> 0
        self.b = (self.b & 0xFFFFFFFF) >> 0
        self.c = (self.c & 0xFFFFFFFF) >> 0
        self.d = (self.d & 0xFFFFFFFF) >> 0
        
        t = ((self.a + self.b) | 0) + self.d | 0
        self.d = (self.d + 1) | 0
        self.a = self.b ^ (self.b >> 9)
        self.b = (self.c + (self.c << 3)) | 0
        self.c = ((self.c << 21) | (self.c >> 11)) + t | 0
        
        return ((t >> 0) & 0xFFFFFFFF) / 4294967296
    
    def rand_int(self, max_val: int) -> int:
        if max_val <= 0:
            return 0
        return int(self.next() * max_val)
    
    def rand_range(self, min_val: float, max_val: float) -> float:
        return min_val + self.next() * (max_val - min_val)


def get_pile_name(num: int) -> str:
    """Get pile name from number."""
    names = {
        1: "Dhwaja (Victory)",
        2: "Dhumra (Obscurity)",
        3: "Simha (Power)",
        4: "Shwana (Service)",
        5: "Vrushabha (Stability)",
        6: "Khara (Adversity)",
        7: "Gaja (Prosperity)",
        8: "Dhwanksha (Decay)"
    }
    return names.get(num, "Unknown")


def get_pile_planet(num: int) -> dict:
    """
    Ashtamangala numerology: remainder mod 8 maps to planets.
    1=Sun, 2=Mars, 3=Jupiter, 4=Mercury, 5=Venus, 6=Saturn, 7=Moon, 8=Rahu
    Odd = Good/Benefic, Even = Bad/Malefic
    """
    mapping = {
        1: {"planet": "Sun", "sanskrit": "Surya", "nature": "Benefic", "number_type": "Odd (Good)"},
        2: {"planet": "Mars", "sanskrit": "Mangala", "nature": "Malefic", "number_type": "Even (Bad)"},
        3: {"planet": "Jupiter", "sanskrit": "Guru", "nature": "Benefic", "number_type": "Odd (Good)"},
        4: {"planet": "Mercury", "sanskrit": "Budha", "nature": "Neutral", "number_type": "Even (Bad)"},
        5: {"planet": "Venus", "sanskrit": "Shukra", "nature": "Benefic", "number_type": "Odd (Good)"},
        6: {"planet": "Saturn", "sanskrit": "Shani", "nature": "Malefic", "number_type": "Even (Bad)"},
        7: {"planet": "Moon", "sanskrit": "Chandra", "nature": "Benefic", "number_type": "Odd (Good)"},
        8: {"planet": "Rahu", "sanskrit": "Rahu", "nature": "Malefic", "number_type": "Even (Bad)"}
    }
    return mapping.get(num, {"planet": "Unknown", "sanskrit": "Unknown", "nature": "Neutral", "number_type": "Unknown"})


# ============================================
# JYOTISHA (VEDIC ASTROLOGY) CALCULATIONS
# ============================================

def date_to_jd(year: int, month: int, day: int, hour: float = 0) -> float:
    """Convert date to Julian Day."""
    a = (14 - month) // 12
    y = year + 4800 - a
    m = month + 12 * a - 3
    jd = day + (153 * m + 2) // 5 + 365 * y + y // 4 - y // 100 + y // 400 - 32045
    jd += (hour - 12) / 24
    return float(jd)


def get_lahiri_ayanamsa(jd: float) -> float:
    """
    Calculate Lahiri Ayanamsa (Chitrapaksha) for a given Julian Day.
    This is the standard ayanamsa used in Vedic astrology.
    """
    t = (jd - 2451545.0) / 36525.0  # Julian centuries from J2000
    # Lahiri formula
    ayanamsa = 22.4605 + 1.3969715 * t + 0.0003086 * t * t
    return ayanamsa % 360


def get_tropical_longitude(planet: str, jd: float) -> float:
    """
    Calculate tropical longitude for a planet.
    Uses simplified algorithms - for production, use Swiss Ephemeris.
    """
    t = (jd - 2451545.0) / 36525.0
    
    if planet == "Sun":
        return (280.460 + 0.9856474 * (jd - 2451545.0)) % 360
    elif planet == "Moon":
        return (218.316 + 13.176396 * (jd - 2451545.0)) % 360
    elif planet == "Mars":
        return (355.433 + 0.524033 * (jd - 2451545.0)) % 360
    elif planet == "Mercury":
        return (252.251 + 4.092338 * (jd - 2451545.0)) % 360
    elif planet == "Jupiter":
        return (34.351 + 0.083091 * (jd - 2451545.0)) % 360
    elif planet == "Venus":
        return (181.979 + 1.602130 * (jd - 2451545.0)) % 360
    elif planet == "Saturn":
        return (50.077 + 0.033444 * (jd - 2451545.0)) % 360
    elif planet == "Rahu":
        # Mean node (retrograde)
        return (125.045 - 0.052992 * (jd - 2451545.0)) % 360
    elif planet == "Ketu":
        return (get_tropical_longitude("Rahu", jd) + 180) % 360
    return 0.0


def calculate_planets(jd: float) -> dict:
    """
    Calculate all planetary positions with Lahiri ayanamsa.
    Returns planets with tropical, sidereal longitudes and house positions.
    """
    ayanamsa = get_lahiri_ayanamsa(jd)
    planets = ["Sun", "Moon", "Mars", "Mercury", "Jupiter", "Venus", "Saturn", "Rahu", "Ketu"]
    result = {"ayanamsa": round(ayanamsa, 4)}
    
    for planet in planets:
        tropical = get_tropical_longitude(planet, jd)
        sidereal = (tropical - ayanamsa + 360) % 360
        house = int(sidereal // 30) + 1
        degrees_in_sign = sidereal % 30
        
        result[planet] = {
            "tropical": round(tropical, 4),
            "sidereal": round(sidereal, 4),
            "house": house,
            "sign": get_rashi_name(house),
            "degrees": round(degrees_in_sign, 2)
        }
    
    return result


def get_rashi_name(house: int) -> str:
    """Get Sanskrit name for house/sign."""
    rashis = ["Mesha", "Vrishabha", "Mithuna", "Karka", "Simha", "Kanya",
              "Thula", "Vrischika", "Dhanus", "Makara", "Kumbha", "Meena"]
    return rashis[house - 1] if 1 <= house <= 12 else "Unknown"


def calculate_natal_chart(birth_data: dict) -> dict:
    """
    Calculate natal chart from birth data.
    birth_data should contain: year, month, day, hour, minute, lat, lng
    """
    if not birth_data or "year" not in birth_data:
        return None
    
    hour = birth_data.get("hour", 0) + birth_data.get("minute", 0) / 60.0
    jd = date_to_jd(
        birth_data["year"],
        birth_data["month"],
        birth_data["day"],
        hour
    )
    
    planets = calculate_planets(jd)
    
    # Calculate Lagna (Ascendant) - simplified
    # In production, this should use proper ascendant calculation with latitude
    # For now, using Sun's position as approximation
    lagna_degree = planets["Sun"]["sidereal"]  # Placeholder
    lagna_house = int(lagna_degree // 30) + 1
    
    planets["lagna"] = {
        "degree": round(lagna_degree, 2),
        "house": lagna_house,
        "sign": get_rashi_name(lagna_house)
    }
    
    return planets


def calculate_drishti(planet: str, house: int) -> list:
    """
    Calculate Vedic aspects (drishti) for a planet.
    Returns list of aspected houses with aspect type.
    """
    aspects = []
    
    # All planets aspect 7th house (opposition)
    seventh = ((house + 6 - 1) % 12) + 1
    aspects.append({"house": seventh, "type": "opposition", "strength": 1.0, "symbol": "◎"})
    
    # Special aspects
    if planet == "Mars":
        aspects.append({"house": ((house + 3 - 1) % 12) + 1, "type": "4th", "strength": 0.75, "symbol": "◻"})
        aspects.append({"house": ((house + 7 - 1) % 12) + 1, "type": "8th", "strength": 0.75, "symbol": "◻"})
    elif planet == "Jupiter":
        aspects.append({"house": ((house + 4 - 1) % 12) + 1, "type": "5th", "strength": 1.0, "symbol": "△"})
        aspects.append({"house": ((house + 8 - 1) % 12) + 1, "type": "9th", "strength": 1.0, "symbol": "△"})
    elif planet == "Saturn":
        aspects.append({"house": ((house + 2 - 1) % 12) + 1, "type": "3rd", "strength": 0.5, "symbol": "⚡"})
        aspects.append({"house": ((house + 9 - 1) % 12) + 1, "type": "10th", "strength": 0.75, "symbol": "⚡"})
    elif planet in ["Rahu", "Ketu"]:
        aspects.append({"house": ((house + 4 - 1) % 12) + 1, "type": "5th", "strength": 0.5, "symbol": "△"})
        aspects.append({"house": ((house + 8 - 1) % 12) + 1, "type": "9th", "strength": 0.5, "symbol": "△"})
    
    return aspects


def calculate_all_drishti(planets: dict) -> dict:
    """Calculate drishti for all planets."""
    result = {}
    for planet, data in planets.items():
        if planet in ["ayanamsa", "lagna"]:
            continue
        if "house" in data:
            result[planet] = {
                "house": data["house"],
                "aspects": calculate_drishti(planet, data["house"])
            }
    return result


def generate_sine_curve(rng: SFC32, y_base: float) -> dict:
    """Generate sine wave separation curve."""
    amplitude = rng.rand_range(5, 15)
    frequency = rng.rand_range(0.05, 0.15)
    phase = rng.rand_range(0, math.pi * 2)
    vertical = y_base + rng.rand_range(-5, 5)
    
    return {
        "type": "sine",
        "start": [0, vertical],
        "end": [100, vertical + amplitude * math.sin(frequency * 100 + phase)],
        "controlPoints": [
            [25, vertical + amplitude * math.sin(frequency * 25 + phase)],
            [50, vertical + amplitude * math.sin(frequency * 50 + phase)],
            [75, vertical + amplitude * math.sin(frequency * 75 + phase)]
        ],
        "equation": f"y = {amplitude:.2f}*sin({frequency:.3f}*x + {phase:.2f}) + {vertical:.2f}"
    }


def generate_bezier_curve(rng: SFC32, y_base: float) -> dict:
    """Generate bezier curve separation."""
    cp1x = rng.rand_range(20, 40)
    cp1y = y_base + rng.rand_range(-20, 20)
    cp2x = rng.rand_range(60, 80)
    cp2y = y_base + rng.rand_range(-20, 20)
    end_y = y_base + rng.rand_range(-10, 10)
    
    return {
        "type": "bezier",
        "start": [0, y_base],
        "end": [100, end_y],
        "controlPoints": [[cp1x, cp1y], [cp2x, cp2y]]
    }


def generate_polyline_curve(rng: SFC32, y_base: float) -> dict:
    """Generate polyline (connected segments) separation."""
    points = [[0, y_base]]
    current_x = 0
    current_y = y_base
    
    while current_x < 100:
        current_x += rng.rand_range(10, 25)
        if current_x > 100:
            current_x = 100
        current_y += rng.rand_range(-15, 15)
        points.append([current_x, current_y])
    
    return {
        "type": "polyline",
        "start": [0, y_base],
        "end": points[-1],
        "controlPoints": points[1:-1]
    }


def get_curve_y_at_x(x: float, curve: dict) -> float:
    """Get Y value of curve at given X."""
    if curve.get("type") == "sine" and curve.get("equation"):
        eq = curve["equation"]
        # Parse equation: y = A*sin(B*x + C) + D
        import re
        match = re.match(r'y = ([\d.]+)\*sin\(([\d.]+)\*x \+ ([\d.]+)\) \+ ([\d.]+)', eq)
        if match:
            A = float(match.group(1))
            B = float(match.group(2))
            C = float(match.group(3))
            D = float(match.group(4))
            return A * math.sin(B * x + C) + D
    
    all_points = [curve["start"]] + curve.get("controlPoints", []) + [curve["end"]]
    
    for i in range(len(all_points) - 1):
        p1 = all_points[i]
        p2 = all_points[i + 1]
        if p1[0] <= x <= p2[0]:
            t = (x - p1[0]) / (p2[0] - p1[0]) if p2[0] != p1[0] else 0
            return p1[1] + t * (p2[1] - p1[1])
    
    return curve["start"][1]


def get_point_region(x: float, y: float, boundaries: dict) -> str:
    """Check which region a point falls into."""
    y_past_present = get_curve_y_at_x(x, boundaries["past_present"])
    y_present_future = get_curve_y_at_x(x, boundaries["present_future"])
    
    # Y increases downward in canvas coordinates
    if y < y_past_present:
        return "past"
    if y >= y_past_present and y < y_present_future:
        return "present"
    return "future"


def generate_distribution(seed: str, kavane: List[dict], birth_data: dict = None, query_time: dict = None) -> dict:
    """Generate separation curves and calculate distribution with Jyotisha."""
    seed_nums = seed_to_numbers(seed)
    rng = SFC32(seed_nums)
    
    # Random start point (normalized coordinates 0-100)
    start_x = rng.rand_range(0, 100)
    start_y = rng.rand_range(0, 100)
    
    # Determine start house from coordinates
    start_house_col = int(start_x // 25)
    start_house_row = int(start_y // 33.33)
    start_house = start_house_row * 4 + start_house_col + 1
    
    # Generate separation curves
    r = rng.next()
    if r < 0.4:
        curve_type1 = "sine"
        past_present_boundary = generate_sine_curve(rng, 33)
    elif r < 0.9:
        curve_type1 = "bezier"
        past_present_boundary = generate_bezier_curve(rng, 33)
    else:
        curve_type1 = "polyline"
        past_present_boundary = generate_polyline_curve(rng, 33)
    
    r = rng.next()
    if r < 0.4:
        curve_type2 = "sine"
        present_future_boundary = generate_sine_curve(rng, 66)
    elif r < 0.9:
        curve_type2 = "bezier"
        present_future_boundary = generate_bezier_curve(rng, 66)
    else:
        curve_type2 = "polyline"
        present_future_boundary = generate_polyline_curve(rng, 66)
    
    # Count shells in each pile based on their position
    past = present = future = 0
    distribution_by_house = {i: 0 for i in range(1, 13)}
    
    for k in kavane:
        # Convert house+cell to normalized coordinates
        house_col = (k["house"] - 1) % 4
        house_row = (k["house"] - 1) // 4
        cell_x = k["cell"] % 3
        cell_y = k["cell"] // 3
        
        x = (house_col * 25) + (cell_x / 3) * 25 + (12.5 / 3)
        y = (house_row * 33.33) + (cell_y / 4) * 33.33 + (8.33 / 4)
        
        pile = get_point_region(x, y, {
            "past_present": past_present_boundary,
            "present_future": present_future_boundary
        })
        
        if pile == "past":
            past += 1
        elif pile == "present":
            present += 1
        else:
            future += 1
        
        distribution_by_house[k["house"]] += 1
    
    # Apply numerology reduction (mod 8, 0 becomes 8)
    def reduce_num(n: int) -> int:
        r = n % 8
        return 8 if r == 0 else r
    
    past_num = reduce_num(past)
    present_num = reduce_num(present)
    future_num = reduce_num(future)
    
    # Count good (odd) vs bad (even)
    good_count = sum(1 for n in [past_num, present_num, future_num] if n % 2 == 1)
    bad_count = 3 - good_count
    if good_count >= 2:
        analysis = f"{good_count} Good (Odd), {bad_count} Bad (Even). Favorable overall indication."
    elif bad_count >= 2:
        analysis = f"{good_count} Good (Odd), {bad_count} Bad (Even). Challenging overall indication."
    else:
        analysis = f"{good_count} Good (Odd), {bad_count} Bad (Even). Mixed results indicated."
    
    # Calculate Jyotisha (Prasna chart at query time)
    if query_time:
        jd = date_to_jd(query_time.get("year", 2024), query_time.get("month", 1), 
                       query_time.get("day", 1), query_time.get("hour", 12) + query_time.get("minute", 0) / 60)
    else:
        # Use current time
        import datetime
        now = datetime.datetime.now()
        jd = date_to_jd(now.year, now.month, now.day, now.hour + now.minute / 60)
    
    prasna_planets = calculate_planets(jd)
    prasna_drishti = calculate_all_drishti(prasna_planets)
    
    # Calculate Natal chart if birth data provided
    natal_data = None
    if birth_data:
        natal_planets = calculate_natal_chart(birth_data)
        if natal_planets:
            natal_drishti = calculate_all_drishti(natal_planets)
            natal_data = {
                "planets": natal_planets,
                "drishti": natal_drishti
            }
    
    return {
        "piles": {
            "past": past_num,
            "present": present_num,
            "future": future_num
        },
        "pile_names": {
            "past": get_pile_name(past_num),
            "present": get_pile_name(present_num),
            "future": get_pile_name(future_num)
        },
        "pile_planets": {
            "past": get_pile_planet(past_num),
            "present": get_pile_planet(present_num),
            "future": get_pile_planet(future_num)
        },
        "analysis": analysis,
        "jyotisha": {
            "ayanamsa": prasna_planets["ayanamsa"],
            "prasna_planets": prasna_planets,
            "prasna_drishti": prasna_drishti,
            "natal": natal_data
        },
        "boundaries": {
            "past_present": past_present_boundary,
            "present_future": present_future_boundary
        },
        "start_point": {
            "x": round(start_x, 2),
            "y": round(start_y, 2),
            "house": min(max(start_house, 1), 12)
        },
        "distribution_by_house": distribution_by_house,
        "temporal_regions": {
            "past": [12, 1, 2],
            "present": [3, 4, 5, 6],
            "future": [7, 8, 9, 10, 11]
        }
    }


def handler_distribute(req: Request):
    """
    Distribute endpoint - generates XY separation curves for temporal piles.
    
    POST /distribute
    Body: {
        "seed": "a1b2c3d4...",      # Hex seed for randomness
        "kavane": [...]             # Array of 108 kavane items with house and cell
    }
    """
    try:
        body = req.json()
        
        seed = body.get("seed")
        kavane = body.get("kavane")
        birth_data = body.get("birth_data")  # Optional: for natal chart
        query_time = body.get("query_time")   # Optional: for specific query time
        
        if not seed:
            return {
                "statusCode": 400,
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps({"success": False, "error": "Missing required parameter: 'seed'"})
            }
        
        if not kavane or not isinstance(kavane, list) or len(kavane) != 108:
            return {
                "statusCode": 400,
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps({"success": False, "error": "Missing required parameter: 'kavane' array with 108 items"})
            }
        
        # Validate seed format
        if not all(c in "0123456789abcdefABCDEF" for c in seed):
            return {
                "statusCode": 400,
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps({"success": False, "error": "Seed must be hexadecimal string"})
            }
        
        # Generate distribution with separation curves and Jyotisha
        result = generate_distribution(seed.lower(), kavane, birth_data, query_time)
        
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({
                "success": True,
                "seed": seed[:32] + ("..." if len(seed) > 32 else ""),
                "start_point": result["start_point"],
                "piles": result["piles"],
                "pile_names": result["pile_names"],
                "pile_planets": result["pile_planets"],
                "analysis": result["analysis"],
                "jyotisha": result["jyotisha"],
                "boundaries": result["boundaries"],
                "distribution_by_house": result["distribution_by_house"],
                "temporal_regions": result["temporal_regions"]
            })
        }
        
    except Exception as e:
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"success": False, "error": str(e)})
        }


# ============ MAIN ROUTER ============

def handler(req: Request, endpoint: str = "disperse"):
    """Route to appropriate handler based on endpoint."""
    if endpoint == "beacon":
        return handler_beacon(req)
    elif endpoint == "chacha20" or endpoint == "chacha20/derive":
        return handler_chacha20_derive(req)
    elif endpoint == "distribute":
        return handler_distribute(req)
    else:
        return handler_disperse(req)


# Supabase Edge Function entry point
def main(args):
    """Entry point for Supabase."""
    body = args.get('body', '{}')
    if isinstance(body, str):
        body = body.encode()
    
    # Determine endpoint from path or args
    endpoint = args.get('endpoint', 'disperse')
    method = args.get('method', 'POST')
    
    req = Request(body=body, method=method)
    return handler(req, endpoint=endpoint)


# Local testing
if __name__ == "__main__":
    # Test beacon endpoint (will fallback to generated since no internet)
    print("=" * 50)
    print("Testing /beacon endpoint")
    print("=" * 50)
    
    result = main({'body': b'', 'endpoint': 'beacon', 'method': 'GET'})
    print(f"Status: {result['statusCode']}")
    data = json.loads(result['body'])
    if data['success']:
        print(f"Beacon source: {data['beacon']['source']}")
        print(f"Beacon value: {data['beacon']['value'][:32]}...")
        print(f"Seed: {data['seed'][:32]}...")
        print(f"Length: {len(data['beacon']['value'])} chars (expected: 128)")
    else:
        print(f"Error: {data.get('error')}")
    
    # Test disperse endpoint with beacon seed
    print("\n" + "=" * 50)
    print("Testing /disperse endpoint")
    print("=" * 50)
    
    # Use a valid 512-bit beacon
    test_beacon = "a" * 128
    
    test_body = json.dumps({
        'N': 50,
        'steps': 30,
        'R_grid': 30,
        's_grid': 100,
        'num_sides': 0,
        'shape_params': [3],
        'v_lines': [33, 66],
        'h_lines': [33, 66],
        'holes': [[1, 1]],
        'seed': test_beacon
    }).encode()
    
    result = main({'body': test_body, 'endpoint': 'disperse'})
    print(f"Status: {result['statusCode']}")
    data = json.loads(result['body'])
    print(f"Points: {data['results']['total_points']}")
    print(f"Seed source: {data['parameters']['seed_source']}")
    print(f"First point: {data['results']['points'][0] if data['results']['points'] else None}")
    
    # Test with short seed (auto-extend)
    test_body = json.dumps({
        'N': 10,
        'steps': 10,
        'R_grid': 20,
        's_grid': 100,
        'num_sides': 0,
        'shape_params': [3],
        'seed': 'abcd1234'  # Short seed, will be extended
    }).encode()
    
    result = main({'body': test_body, 'endpoint': 'disperse'})
    print(f"\nWith short seed:")
    print(f"Status: {result['statusCode']}")
    data = json.loads(result['body'])
    print(f"Points: {data['results']['total_points']}")
    print(f"Used seed: {data['parameters']['seed'][:32]}..." if data['parameters']['seed'] else "None")
    
    # Test ChaCha20Derive endpoint
    print("\n" + "=" * 50)
    print("Testing /chacha20/derive endpoint")
    print("=" * 50)
    
    test_seed = "abcd1234" * 16  # 128 chars = 512 bits
    test_input = "beef5678" * 8   # 64 chars = 256 bits
    
    test_body = json.dumps({
        'seed': test_seed,
        'input': test_input,
        'n_bits': 512
    }).encode()
    
    result = main({'body': test_body, 'endpoint': 'chacha20'})
    print(f"Status: {result['statusCode']}")
    data = json.loads(result['body'])
    if data['success']:
        print(f"Derived {data['output']['bits']} bits")
        print(f"Output: {data['output']['hex'][:64]}...")
        print(f"Algorithm: {data['algorithm']['name']}")
    else:
        print(f"Error: {data.get('error')}")
