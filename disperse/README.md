# Spatial Disperse API

A Supabase Edge Function that simulates spatial distribution of geometric shapes (circles, polygons) in a constrained grid using cryptographically secure randomness from NIST beacon entropy. Features **per-step rotation and mirror randomization** for non-symmetrical polygons.

## Overview

The `disperse` function implements a spatial simulation where:
- **N shapes** are distributed across an **S×S grid**
- Shapes undergo **stochastic movement** ("throws") over multiple steps
- **Grid constraints** (lines and holes) create forbidden zones
- **Bounce physics** ensure shapes respect boundaries
- **Hybrid CSPRNG** combines deterministic entropy with local randomness
- **Per-step orientation**: Rotation and mirror are randomized each step (optional)

## Mathematical Model

### Core Algorithm

The simulation implements a **Markov chain** where each step depends only on the current state:

```
X(t+1) = f(X(t), R(t), O(t))
```

Where:
- `X(t)` = positions of all N shapes at step t
- `R(t)` = random variables from CSPRNG for movement
- `O(t)` = orientation state (rotation angle, mirror flag) - randomized per step
- `f()` = throw + overlap resolution + boundary bounce

### Throw Mechanism

For each shape i at position (xᵢ, yᵢ):

1. **Capture**: If distance to random center (cx, cy) < R_grid:
   - Move to center: (xᵢ, yᵢ) = (cx, cy)
   
2. **Dispersion**: Apply random displacement:
   - θ ~ Uniform(0, 2π)
   - d ~ Uniform(0, step_size)
   - xᵢ += d·cos(θ)
   - yᵢ += d·sin(θ)

3. **Boundary Check**: Clip to grid [0, s_grid)

4. **Hole Bounce**: If (xᵢ, yᵢ) near hole, binary search for valid position

### Per-Step Orientation

For non-symmetrical shapes, rotation and mirror are randomized at each step:

```
rotation_angle = rotation_index × (180° / num_rotations)
```

Where `rotation_index` is randomly chosen from [0, num_rotations-1] each step.

Entropy consumption:
- Rotation: log₂(num_rotations) bits per shape per step
- Mirror: 1 bit per shape per step (if enabled)

### Overlap Resolution

After all throws, iteratively push overlapping shapes apart:

```
For each pair (i, j):
  If overlap:
    Move both by (separation - distance)/2 along collision axis
Until no movement or max_iterations
```

### Randomness Generation

Uses a **hybrid CSPRNG**:

1. **Deterministic seed** (from NIST beacon or provided)
2. **ChaCha20-like derivation** for stream generation
3. **XOR with secrets.token_bytes()** for local entropy
4. **Result**: Deterministic with seed, unpredictable without

## API Reference

### Endpoint

```
POST /functions/v1/disperse
```

### Authentication

No authentication required (public function).

### Request Headers

| Header | Value |
|--------|-------|
| Content-Type | `application/json` |

### Request Body

```typescript
interface DisperseRequest {
  /** Number of shapes to distribute (1-10000) */
  N: number;
  
  /** Simulation steps/iterations (1-10000) */
  steps: number;
  
  /** Capture radius for throw mechanism (1-s_grid) */
  R_grid: number;
  
  /** Grid size S×S (1-65536) */
  s_grid: number;
  
  /** Shape type: 0=circle, 2=line, 3+=polygon */
  num_sides: number;
  
  /** Shape parameters: [radius] for circle, [side1, side2, ...] for polygon */
  shape_params: number[];
  
  /** Alias for shape_params */
  edges?: number[];
  
  /** Number of rotation positions for per-step randomization (1=no rotation, 2=0°/90°, 4=0°/45°/90°/135°) */
  num_rotations?: number;
  
  /** Enable per-step mirror randomization */
  enable_mirror?: boolean;
  
  /** Vertical grid line positions (optional) */
  v_lines?: number[];
  
  /** Alias for v_lines */
  vertical_lines?: number[];
  
  /** Horizontal grid line positions (optional) */
  h_lines?: number[];
  
  /** Alias for h_lines */
  horizontal_lines?: number[];
  
  /** Hole cells as [[row, col], ...] (optional) */
  holes?: number[][];
  
  /** Alias for holes */
  forbidden_cells?: number[][];
  
  /** Hex entropy seed for reproducibility (optional) */
  entropy_seed?: string;
}
```

### Response Body

```typescript
interface DisperseResponse {
  success: boolean;
  parameters: {
    N: number;
    steps: number;
    R_grid: number;
    s_grid: number;
    num_sides: number;
    shape_params: number[];
    edges: number[];
    num_rotations: number;
    enable_mirror: boolean;
    v_lines: number[];
    h_lines: number[];
    holes: number[][];
  };
  results: {
    total_points: number;
    points: Array<{
      id: number;
      x: number;
      y: number;
    }>;
    orientation_entropy_bits: number;
    orientation_history_sample: Array<{
      step: number;
      rotation_index: number;
      rotation_angle: number;
      mirror: boolean;
    }>;
  };
  error?: string;
}
```

### Error Codes

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 400 | Invalid parameters |
| 500 | Server error |

## Shape Types

### Circle (`num_sides: 0`)

```json
{
  "num_sides": 0,
  "shape_params": [5]  // radius = 5 pixels
}
```

Bounding box: 2r × 2r

### Line Segment (`num_sides: 2`)

```json
{
  "num_sides": 2,
  "shape_params": [10]  // length = 10 pixels
}
```

### Triangle (`num_sides: 3`)

```json
{
  "num_sides": 3,
  "shape_params": [10, 8]  // 2 sides given, 3rd determined
}
```

### Quadrilateral (`num_sides: 4`)

```json
{
  "num_sides": 4,
  "shape_params": [10, 8, 6]  // 3 sides given, 4th determined
}
```

### Pentagon (`num_sides: 5`)

```json
{
  "num_sides": 5,
  "shape_params": [10, 8, 6, 4]  // 4 sides given, 5th determined
}
```

### Hexagon (`num_sides: 6`)

```json
{
  "num_sides": 6,
  "shape_params": [2, 3, 2, 2, 3]  // 5 sides given, 6th determined
}
```

## Per-Step Orientation

For non-symmetrical polygons, rotation angle and mirror state can be randomized at each simulation step.

### How It Works

1. **num_rotations**: Divides 180° into equal parts
   - `1`: No rotation (fixed 0°)
   - `2`: Two positions (0°, 90°)
   - `4`: Four positions (0°, 45°, 90°, 135°)
   - `8`: Eight positions (0°, 22.5°, 45°, ...)

2. **enable_mirror**: When true, randomly flips shape each step

### Entropy Consumption

| Configuration | Bits per shape/step | N=100, steps=50 |
|--------------|--------------------|-----------------|
| 1 rotation, no mirror | 0 bits | 0 bits |
| 2 rotations, with mirror | 2 bits | 10,000 bits |
| 4 rotations, with mirror | 3 bits | 15,000 bits |
| 8 rotations, with mirror | 4 bits | 20,000 bits |

### Example: Line with Rotation

```json
{
  "N": 50,
  "steps": 100,
  "R_grid": 40,
  "s_grid": 200,
  "num_sides": 2,
  "edges": [25],
  "num_rotations": 4,
  "enable_mirror": true
}
```

This creates 50 line segments that rotate randomly between 0°/45°/90°/135° and randomly mirror each step.

## Grid Constraints

### Lines

Vertical and horizontal lines divide the grid into cells:

```json
{
  "v_lines": [20, 40],  // X = 20 and X = 40
  "h_lines": [20, 40]   // Y = 20 and Y = 40
}
```

Creates a 3×3 grid with cells:
- (0,0): [0,20) × [0,20)
- (0,1): [20,40) × [0,20)
- (0,2): [40,64) × [0,20)
- etc.

### Holes

Holes are forbidden cells specified by (row, col) indices:

```json
{
  "holes": [[1, 1], [0, 2]]  // Center and top-right cells forbidden
}
```

Shapes **cannot enter holes** - they bounce off boundaries.

## Examples

### Example 1: Simple Circle Distribution

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 100,
    "steps": 50,
    "R_grid": 50,
    "s_grid": 500,
    "num_sides": 0,
    "shape_params": [5]
  }'
```

### Example 2: Line Segments with Per-Step Rotation

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 50,
    "steps": 100,
    "R_grid": 40,
    "s_grid": 200,
    "num_sides": 2,
    "edges": [25],
    "num_rotations": 4,
    "enable_mirror": true
  }'
```

### Example 3: Hexagons with Central Hole

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 108,
    "steps": 200,
    "R_grid": 64,
    "s_grid": 64,
    "num_sides": 6,
    "shape_params": [1, 2, 1, 1, 2],
    "v_lines": [21, 41],
    "h_lines": [21, 41],
    "holes": [[1, 1]]
  }'
```

### Example 4: Reproducible Run with Seed

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 50,
    "steps": 30,
    "R_grid": 40,
    "s_grid": 200,
    "num_sides": 3,
    "shape_params": [10, 8],
    "entropy_seed": "aabbccddaabbccddaabbccddaabbccdd"
  }'
```

Same seed → Same results.

### Example 5: Complex Grid with Multiple Holes

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 200,
    "steps": 100,
    "R_grid": 80,
    "s_grid": 256,
    "num_sides": 4,
    "shape_params": [8, 6, 8],
    "v_lines": [64, 128, 192],
    "h_lines": [64, 128, 192],
    "holes": [[1, 1], [1, 2], [2, 1]]
  }'
```

Creates a 4×4 grid with 3 holes (9 valid cells for 200 shapes).

### Example 6: Triangles with Full Orientation

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 30,
    "steps": 50,
    "R_grid": 35,
    "s_grid": 150,
    "num_sides": 3,
    "edges": [12, 10],
    "num_rotations": 8,
    "enable_mirror": true,
    "vertical_lines": [50, 100],
    "horizontal_lines": [50, 100]
  }'
```

## Python Client

```python
import requests

def disperse(
    url: str,
    N: int = 100,
    steps: int = 50,
    R_grid: int = 50,
    s_grid: int = 500,
    num_sides: int = 0,
    shape_params: list = None,
    edges: list = None,
    num_rotations: int = 1,
    enable_mirror: bool = False,
    v_lines: list = None,
    h_lines: list = None,
    holes: list = None,
    entropy_seed: str = None
):
    """Call the disperse API."""
    
    payload = {
        "N": N,
        "steps": steps,
        "R_grid": R_grid,
        "s_grid": s_grid,
        "num_sides": num_sides,
        "shape_params": shape_params or edges or [3],
    }
    
    if num_rotations > 1:
        payload["num_rotations"] = num_rotations
    if enable_mirror:
        payload["enable_mirror"] = enable_mirror
    if v_lines:
        payload["v_lines"] = v_lines
    if h_lines:
        payload["h_lines"] = h_lines
    if holes:
        payload["holes"] = holes
    if entropy_seed:
        payload["entropy_seed"] = entropy_seed
    
    response = requests.post(
        f"{url}/functions/v1/disperse",
        json=payload,
        headers={"Content-Type": "application/json"}
    )
    
    response.raise_for_status()
    return response.json()


# Usage - Simple circle
result = disperse(
    url="https://your-project.supabase.co",
    N=100,
    steps=50,
    s_grid=200,
    num_sides=6,
    shape_params=[2, 3, 2, 2, 3],
    v_lines=[66, 133],
    h_lines=[66, 133],
    holes=[[1, 1]]
)

points = result["results"]["points"]
print(f"Generated {len(points)} points")

# Usage - Line with rotation
result = disperse(
    url="https://your-project.supabase.co",
    N=50,
    steps=100,
    s_grid=200,
    num_sides=2,
    edges=[25],
    num_rotations=4,
    enable_mirror=True
)

print(f"Orientation entropy: {result['results']['orientation_entropy_bits']} bits")
```

## JavaScript/TypeScript Client

```typescript
interface DisperseParams {
  N: number;
  steps: number;
  R_grid: number;
  s_grid: number;
  num_sides: number;
  shape_params?: number[];
  edges?: number[];
  num_rotations?: number;
  enable_mirror?: boolean;
  v_lines?: number[];
  vertical_lines?: number[];
  h_lines?: number[];
  horizontal_lines?: number[];
  holes?: number[][];
  forbidden_cells?: number[][];
  entropy_seed?: string;
}

interface Point {
  id: number;
  x: number;
  y: number;
}

interface OrientationState {
  step: number;
  rotation_index: number;
  rotation_angle: number;
  mirror: boolean;
}

async function disperse(
  url: string,
  params: DisperseParams
): Promise<{ points: Point[], orientation_entropy_bits: number, orientation_history_sample: OrientationState[] }> {
  const response = await fetch(`${url}/functions/v1/disperse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  
  const data = await response.json();
  return {
    points: data.results.points,
    orientation_entropy_bits: data.results.orientation_entropy_bits,
    orientation_history_sample: data.results.orientation_history_sample
  };
}

// Usage - Triangle with rotation
const result = await disperse(
  'https://your-project.supabase.co',
  {
    N: 30,
    steps: 50,
    R_grid: 35,
    s_grid: 150,
    num_sides: 3,
    edges: [12, 10],
    num_rotations: 8,
    enable_mirror: true
  }
);

console.log(`Generated ${result.points.length} points`);
console.log(`Orientation entropy: ${result.orientation_entropy_bits} bits`);
console.log('First few orientations:', result.orientation_history_sample);
```

## Deployment

### Prerequisites

- Supabase CLI installed
- Supabase project created

### Deploy

```bash
# Login
supabase login

# Link project
supabase link --project-ref your-project-ref

# Deploy function
supabase functions deploy disperse

# Or serve locally for testing
supabase functions serve disperse
```

### Environment Variables

No environment variables required. The function uses:
- `secrets.token_bytes()` for local entropy
- Optional `entropy_seed` for reproducibility

## Performance

| N | Steps | s_grid | Orientation | Time (local) |
|---|-------|--------|-------------|--------------|
| 100 | 50 | 500 | None | ~100ms |
| 100 | 50 | 500 | 4 rotations + mirror | ~120ms |
| 500 | 100 | 1000 | None | ~500ms |
| 500 | 100 | 1000 | 8 rotations + mirror | ~550ms |
| 1000 | 200 | 2000 | 4 rotations | ~2.2s |

Larger grids, more shapes, and per-step orientation increase computation time.

## Limitations

- Maximum grid size: 65536×65536 (2^16)
- Maximum shapes: Limited by memory/CPU (practical limit ~10,000)
- Shape margin: Automatically calculated, very large shapes may have issues near holes
- No persistence: Each call generates new distribution (unless using entropy_seed)
- Per-step orientation entropy: Each rotation/mirror randomization consumes entropy (see table above)

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Client    │────▶│   Supabase   │────▶│   Edge      │
│   Request   │     │   Gateway    │     │   Function  │
└─────────────┘     └──────────────┘     └─────────────┘
                                                  │
                                                  ▼
                                         ┌──────────────┐
                                         │  Simulation  │
                                         │  - CSPRNG    │
                                         │  - Throws    │
                                         │  - Bounce    │
                                         │  - Orientation│
                                         └──────────────┘
                                                  │
                                                  ▼
                                         ┌──────────────┐
                                         │   Response   │
                                         │   Points[]   │
                                         │   OrientHist │
                                         └──────────────┘
```

## License

MIT
