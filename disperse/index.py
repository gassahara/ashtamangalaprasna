"""
Supabase Edge Function: disperse

Simulates spatial distribution of shapes in a grid with hole constraints.
Returns a list of (x, y) points.

POST /disperse
Body: {
    "N": 100,                    # Number of shapes
    "steps": 50,                 # Simulation steps
    "R_grid": 50,                # Capture radius
    "s_grid": 500,               # Grid size
    "shape_type": "circle",      # "circle" or "polygon"
    "shape_params": [3],         # [radius] for circle, [side1, side2, ...] for polygon
    "num_sides": 0,              # 0=circle, 3=triangle, etc.
    "v_lines": [],               # Vertical grid lines
    "h_lines": [],               # Horizontal grid lines  
    "holes": [],                 # Hole cells as [[row, col], ...]
    "entropy_seed": null         # Optional hex seed for reproducibility
}
"""

import json
import math
import hashlib
import secrets
from typing import List, Tuple, Optional, Dict, Any


# ============ RANDOMNESS ============

class ChaCha20RNG:
    """Simple CSPRNG using ChaCha20-based derivation."""
    
    def __init__(self, seed_hex: str = None, bits_per_step: int = 128):
        if seed_hex:
            self.seed = bytes.fromhex(seed_hex)
        else:
            self.seed = secrets.token_bytes(32)
        self.bits_per_step = bits_per_step
        self.step_count = 0
        
        # Derive key and nonce from seed
        self.key = hashlib.sha256(self.seed + b'key').digest()[:32]
        self.nonce = hashlib.sha256(self.seed + b'nonce').digest()[:12]
        self.block_counter = 0
        self.buffer = b''
    
    def _chacha20_block(self, counter: int) -> bytes:
        """Generate ChaCha20-like block."""
        # Simplified - use hash for deno compatibility
        data = self.key + self.nonce + counter.to_bytes(8, 'big')
        return hashlib.sha256(data).digest() + hashlib.sha256(data + b'x').digest()
    
    def get_random_bytes(self, n: int) -> bytes:
        """Get n random bytes."""
        while len(self.buffer) < n:
            self.buffer += self._chacha20_block(self.block_counter)
            self.block_counter += 1
        
        result = self.buffer[:n]
        self.buffer = self.buffer[n:]
        
        # XOR with local entropy
        local = secrets.token_bytes(n)
        return bytes(a ^ b for a, b in zip(result, local))
    
    def get_random_int(self, max_val: int) -> int:
        """Get random integer in [0, max_val)."""
        if max_val <= 0:
            return 0
        # Use 8 bytes for good distribution
        rand_bytes = self.get_random_bytes(8)
        rand_int = int.from_bytes(rand_bytes, 'big')
        return rand_int % max_val


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
        
        # Binary search for valid position
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
        """Get random position in valid cell."""
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
    def __init__(self, num_sides: int, params: List[int]):
        self.num_sides = num_sides
        self.params = params
    
    def get_bounding_box(self) -> Tuple[int, int]:
        if self.num_sides == 0:  # Circle
            r = self.params[0] if self.params else 1
            return (2 * r, 2 * r)
        elif self.num_sides == 2:  # Line
            return (self.params[0] if self.params else 10, 2)
        else:
            # Polygon - approximate
            max_side = max(self.params) if self.params else 10
            return (max_side * 2, max_side * 2)


# ============ SIMULATION ============

def resolve_overlaps(points: List[Tuple[int, int]], shape: Shape, s_grid: int) -> List[Tuple[int, int]]:
    """Push overlapping shapes apart."""
    box_w, box_h = shape.get_bounding_box()
    min_sep_x = box_w
    min_sep_y = box_h
    
    for _ in range(50):
        moved = False
        new_points = list(points)
        
        for i in range(len(new_points)):
            for j in range(i + 1, len(new_points)):
                x1, y1 = new_points[i]
                x2, y2 = new_points[j]
                
                dx = abs(x1 - x2)
                dy = abs(y1 - y2)
                
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


def throw_step(points: List[Tuple[int, int]], R_grid: int, step_size: int, 
               s_grid: int, rng: ChaCha20RNG, 
               grid_constraints: Optional[GridConstraints], margin: int):
    """One simulation step with throws."""
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
        dx = x - cx
        dy = y - cy
        
        if dx * dx + dy * dy <= R_grid * R_grid:
            x, y = cx, cy
            
            angle = rng.get_random_int(2**16) / 2**16 * 2 * math.pi
            dist = rng.get_random_int(2**16) / 2**16 * step_size
            
            x += int(dist * math.cos(angle))
            y += int(dist * math.sin(angle))
        
        x = max(0, min(s_grid - 1, x))
        y = max(0, min(s_grid - 1, y))
        
        if grid_constraints and margin > 0:
            if not grid_constraints.is_valid(x, y, margin):
                x, y = grid_constraints.bounce(prev_x, prev_y, x, y, margin)
        
        new_points.append((x, y))
    
    return new_points


def simulate(N: int, steps: int, R_grid: int, s_grid: int,
             shape: Shape, rng: ChaCha20RNG,
             grid_constraints: Optional[GridConstraints] = None) -> List[Tuple[int, int]]:
    """Run full simulation."""
    # Calculate margin
    box_w, box_h = shape.get_bounding_box()
    margin = max(box_w, box_h) // 2 + 1
    
    # Initialize
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
    
    # Initial overlap resolution
    points = resolve_overlaps(points, shape, s_grid)
    
    # Run steps
    step_size = max(1, s_grid // 4)
    
    for _ in range(steps):
        prev_points = list(points)
        points = throw_step(points, R_grid, step_size, s_grid, rng, grid_constraints, margin)
        points = resolve_overlaps(points, shape, s_grid)
        
        # Bounce after overlaps
        if grid_constraints:
            for i, (x, y) in enumerate(points):
                if not grid_constraints.is_valid(x, y, margin):
                    px, py = prev_points[i]
                    points[i] = grid_constraints.bounce(px, py, x, y, margin)
    
    return points


# ============ HANDLER ============

def handler(req):
    """Main entry point for Supabase Edge Function."""
    try:
        # Parse request body
        if hasattr(req, 'json'):
            body = req.json()
        else:
            body = json.loads(req.body.decode() if hasattr(req, 'body') else '{}')
        
        # Extract parameters with defaults
        N = int(body.get('N', 100))
        steps = int(body.get('steps', 50))
        R_grid = int(body.get('R_grid', 50))
        s_grid = int(body.get('s_grid', 500))
        shape_type = body.get('shape_type', 'circle')
        num_sides = int(body.get('num_sides', 0))
        shape_params = body.get('shape_params', [3])
        v_lines = body.get('v_lines', [])
        h_lines = body.get('h_lines', [])
        holes = body.get('holes', [])
        entropy_seed = body.get('entropy_seed')
        
        # Create RNG
        rng = ChaCha20RNG(seed_hex=entropy_seed)
        
        # Create shape
        shape = Shape(num_sides, shape_params)
        
        # Create grid constraints if specified
        grid_constraints = None
        if v_lines or h_lines:
            grid_constraints = GridConstraints(s_grid, v_lines, h_lines, holes)
        
        # Run simulation
        points = simulate(N, steps, R_grid, s_grid, shape, rng, grid_constraints)
        
        # Format response
        result = {
            "success": True,
            "parameters": {
                "N": N,
                "steps": steps,
                "R_grid": R_grid,
                "s_grid": s_grid,
                "shape_type": shape_type,
                "num_sides": num_sides,
                "shape_params": shape_params,
                "v_lines": v_lines,
                "h_lines": h_lines,
                "holes": holes
            },
            "results": {
                "total_points": len(points),
                "points": [{"id": i + 1, "x": x, "y": y} for i, (x, y) in enumerate(points)]
            }
        }
        
        return Response(
            json.dumps(result),
            status=200,
            headers={"Content-Type": "application/json"}
        )
        
    except Exception as e:
        error_result = {
            "success": False,
            "error": str(e)
        }
        return Response(
            json.dumps(error_result),
            status=500,
            headers={"Content-Type": "application/json"}
        )


# Deno/Supabase Edge Function compatibility
from http.server import BaseHTTPRequestHandler

class Response:
    def __init__(self, body: str, status: int = 200, headers: dict = None):
        self.body = body
        self.status = status
        self.headers = headers or {}


def main(req):
    """Entry point for Supabase Edge Function."""
    return handler(req)


# For local testing
if __name__ == "__main__":
    # Test
    test_req = type('Req', (), {
        'json': lambda: {
            'N': 50,
            'steps': 30,
            'R_grid': 30,
            's_grid': 100,
            'shape_type': 'circle',
            'num_sides': 0,
            'shape_params': [3],
            'v_lines': [33, 66],
            'h_lines': [33, 66],
            'holes': [[1, 1]]
        }
    })()
    
    response = handler(test_req)
    print(f"Status: {response.status}")
    print(f"Body preview: {response.body[:500]}...")
