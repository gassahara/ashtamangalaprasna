# Usage Examples

## Table of Contents

1. [Basic Examples](#basic-examples)
2. [Shape Types](#shape-types)
3. [Per-Step Orientation](#per-step-orientation)
4. [Grid Constraints](#grid-constraints)
5. [Advanced Scenarios](#advanced-scenarios)
6. [Client Code Examples](#client-code-examples)

---

## Basic Examples

### Example 1: Simple Circle Distribution

Distribute 100 circles of radius 5 in a 500×500 grid.

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

**Expected Result**: 100 points scattered across the 500×500 space.

---

### Example 2: Triangle Grid

50 triangles in a 200×200 space.

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 50,
    "steps": 30,
    "R_grid": 40,
    "s_grid": 200,
    "num_sides": 3,
    "shape_params": [10, 8]
  }'
```

**Parameters Explained**:
- `num_sides: 3` = Triangle
- `shape_params: [10, 8]` = Two sides specified (10 and 8), third determined

---

## Shape Types

### Circle (num_sides: 0)

```json
{
  "N": 100,
  "num_sides": 0,
  "shape_params": [5]  // radius = 5
}
```

### Line Segment (num_sides: 2)

```json
{
  "N": 50,
  "num_sides": 2,
  "shape_params": [20]  // length = 20
}
```

### Triangle (num_sides: 3)

```json
{
  "N": 50,
  "num_sides": 3,
  "shape_params": [10, 8]  // 2 sides, 3rd determined
}
```

### Square/Quadrilateral (num_sides: 4)

```json
{
  "N": 50,
  "num_sides": 4,
  "shape_params": [10, 8, 6]  // 3 sides, 4th determined
}
```

### Pentagon (num_sides: 5)

```json
{
  "N": 50,
  "num_sides": 5,
  "shape_params": [10, 8, 6, 4]  // 4 sides, 5th determined
}
```

### Hexagon (num_sides: 6)

```json
{
  "N": 108,
  "num_sides": 6,
  "shape_params": [2, 3, 2, 2, 3]  // 5 sides, 6th determined
}
```

---

## Per-Step Orientation

### Example 3: Line Segments with Rotation

50 line segments that randomly rotate between 0°, 90° each step.

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
    "num_rotations": 2,
    "enable_mirror": false
  }'
```

**Parameters Explained**:
- `edges: [25]` = Line length 25 pixels (alias for shape_params)
- `num_rotations: 2` = Two rotation positions: 0° and 90°
- `enable_mirror: false` = No mirroring

**Entropy Consumption**: 50 shapes × 100 steps × 1 bit = 5,000 bits

---

### Example 4: Lines with Full Orientation

Lines with 4 rotation positions and mirror randomization.

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 30,
    "steps": 80,
    "R_grid": 35,
    "s_grid": 180,
    "num_sides": 2,
    "edges": [30],
    "num_rotations": 4,
    "enable_mirror": true
  }'
```

**Rotation Angles**:
- Index 0: 0°
- Index 1: 45°
- Index 2: 90°
- Index 3: 135°

**Entropy Consumption**: 30 shapes × 80 steps × 3 bits = 7,200 bits

---

### Example 5: Triangles with 8 Rotations

Triangles rotating through 8 positions with mirroring.

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 25,
    "steps": 60,
    "R_grid": 30,
    "s_grid": 160,
    "num_sides": 3,
    "edges": [15, 12],
    "num_rotations": 8,
    "enable_mirror": true
  }'
```

**Rotation Angles**: 0°, 22.5°, 45°, 67.5°, 90°, 112.5°, 135°, 157.5°

**Entropy Consumption**: 25 shapes × 60 steps × 4 bits = 6,000 bits

---

### Example 6: Quadrilateral in Grid with Rotation

Quads rotating in a constrained grid.

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 40,
    "steps": 70,
    "R_grid": 45,
    "s_grid": 220,
    "num_sides": 4,
    "shape_params": [12, 10, 8],
    "num_rotations": 6,
    "enable_mirror": false,
    "v_lines": [73, 146],
    "h_lines": [73, 146]
  }'
```

---

## Grid Constraints

### Example 7: Single Central Hole

3×3 grid with center cell forbidden.

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

**Grid Layout**:
```
     Col 0    Col 1    Col 2
    [0-21)   [21-41)  [41-64)
Row 0  (0,0)    (0,1)    (0,2)   Y=[0,21)
Row 1  (1,0)   [HOLE]    (1,2)   Y=[21,41)
Row 2  (2,0)    (2,1)    (2,2)   Y=[41,64)
```

**Result**: 108 hexagons distributed across 8 valid cells, 0 in hole.

---

### Example 8: Multiple Holes

4×4 grid with 3 holes.

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

**Result**: 200 shapes in 13 valid cells (16 - 3 holes).

---

### Example 9: Row of Holes (Obstacle Course)

Horizontal barrier with gaps.

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 150,
    "steps": 150,
    "R_grid": 60,
    "s_grid": 300,
    "num_sides": 0,
    "shape_params": [4],
    "v_lines": [100, 200],
    "h_lines": [100, 200],
    "holes": [[1, 0], [1, 2]]
  }'
```

**Grid Layout**:
```
     C0      C1      C2
R0:  [OK]    [OK]    [OK]
R1: [HOLE]   [OK]   [HOLE]   ← Gap in middle
R2:  [OK]    [OK]    [OK]
```

**Result**: Shapes must flow through the middle gap (cell 1,1).

---

## Advanced Scenarios

### Example 10: Reproducible Simulation

Same parameters + same seed = same results.

```bash
# Run 1
SEED="aabbccddaabbccddaabbccddaabbccdd"

RESULT1=$(curl -s -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d "{
    \"N\": 50,
    \"steps\": 30,
    \"R_grid\": 40,
    \"s_grid\": 200,
    \"num_sides\": 0,
    \"shape_params\": [3],
    \"entropy_seed\": \"$SEED\"
  }")

# Run 2 (identical)
RESULT2=$(curl -s -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d "{
    \"N\": 50,
    \"steps\": 30,
    \"R_grid\": 40,
    \"s_grid\": 200,
    \"num_sides\": 0,
    \"shape_params\": [3],
    \"entropy_seed\": \"$SEED\"
  }")

# Compare (should be identical)
echo "$RESULT1" | jq '.results.points[0]'
echo "$RESULT2" | jq '.results.points[0]'
```

---

### Example 11: High-Density Packing

Many small shapes in limited space.

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 500,
    "steps": 300,
    "R_grid": 30,
    "s_grid": 150,
    "num_sides": 0,
    "shape_params": [2]
  }'
```

**Note**: With 500 circles of radius 2 (4px diameter) in 150×150 = 22,500px², expect tight packing!

---

### Example 12: Asymmetric Grid

Non-uniform cell sizes.

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 100,
    "steps": 100,
    "R_grid": 50,
    "s_grid": 200,
    "num_sides": 3,
    "shape_params": [8, 6],
    "v_lines": [50, 150],  // Small left, large middle, small right
    "h_lines": [100],      // Top half, bottom half
    "holes": [[0, 1]]      // Hole in large top-middle cell
  }'
```

**Cell Sizes**:
- Col 0: 50px wide
- Col 1: 100px wide (with hole)
- Col 2: 50px wide

---

### Example 13: Maximum Entropy Configuration

Maximum rotation and mirror randomization.

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 100,
    "steps": 100,
    "R_grid": 50,
    "s_grid": 400,
    "num_sides": 3,
    "edges": [18, 15],
    "num_rotations": 12,
    "enable_mirror": true,
    "v_lines": [100, 200, 300],
    "h_lines": [100, 200, 300],
    "forbidden_cells": [[1, 1], [2, 2]]
  }'
```

**Entropy Consumption**: 100 shapes × 100 steps × (3.58 + 1) bits ≈ 45,800 bits

---

## Client Code Examples

### Python

```python
import requests
import json

class DisperseClient:
    def __init__(self, base_url: str, api_key: str = None):
        self.url = f"{base_url}/functions/v1/disperse"
        self.headers = {"Content-Type": "application/json"}
        if api_key:
            self.headers["Authorization"] = f"Bearer {api_key}"
    
    def disperse(
        self,
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
    ) -> dict:
        """Run spatial distribution simulation."""
        
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
            self.url,
            json=payload,
            headers=self.headers
        )
        response.raise_for_status()
        return response.json()
    
    def visualize_ascii(self, result: dict, width: int = 60, height: int = 30) -> str:
        """Create ASCII visualization of points."""
        s_grid = result["parameters"]["s_grid"]
        points = result["results"]["points"]
        
        # Create canvas
        canvas = [[' ' for _ in range(width)] for _ in range(height)]
        
        # Map points to canvas
        for p in points:
            cx = int(p["x"] * width / s_grid)
            cy = int(p["y"] * height / s_grid)
            cy = height - 1 - cy  # Flip Y
            if 0 <= cx < width and 0 <= cy < height:
                canvas[cy][cx] = '●'
        
        return '\n'.join(''.join(row) for row in canvas)


# Usage - Basic hexagon
client = DisperseClient("https://your-project.supabase.co")

result = client.disperse(
    N=108,
    steps=200,
    s_grid=64,
    num_sides=6,
    shape_params=[1, 2, 1, 1, 2],
    v_lines=[21, 41],
    h_lines=[21, 41],
    holes=[[1, 1]]
)

print(f"Generated {result['results']['total_points']} points")
print(client.visualize_ascii(result))

# Usage - Line with rotation
result = client.disperse(
    N=50,
    steps=100,
    s_grid=200,
    num_sides=2,
    edges=[25],
    num_rotations=4,
    enable_mirror=True
)

print(f"\nOrientation entropy: {result['results']['orientation_entropy_bits']} bits")
print("Sample orientations:")
for orient in result['results']['orientation_history_sample'][:3]:
    print(f"  Step {orient['step']}: {orient['rotation_angle']}°, mirror={orient['mirror']}")
```

---

### JavaScript/TypeScript

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
  h_lines?: number[];
  holes?: number[][];
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

interface DisperseResult {
  success: boolean;
  parameters: DisperseParams;
  results: {
    total_points: number;
    points: Point[];
    orientation_entropy_bits: number;
    orientation_history_sample: OrientationState[];
  };
}

class DisperseClient {
  private url: string;
  private headers: Record<string, string>;

  constructor(baseUrl: string, apiKey?: string) {
    this.url = `${baseUrl}/functions/v1/disperse`;
    this.headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      this.headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  async disperse(params: DisperseParams): Promise<DisperseResult> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  visualizeASCII(result: DisperseResult, width = 60, height = 30): string {
    const { s_grid } = result.parameters;
    const { points } = result.results;
    
    // Create canvas
    const canvas: string[][] = Array(height)
      .fill(null)
      .map(() => Array(width).fill(' '));
    
    // Map points
    for (const p of points) {
      const cx = Math.floor(p.x * width / s_grid);
      const cy = height - 1 - Math.floor(p.y * height / s_grid);
      if (cx >= 0 && cx < width && cy >= 0 && cy < height) {
        canvas[cy][cx] = '●';
      }
    }
    
    return canvas.map(row => row.join('')).join('\n');
  }
}

// Usage - Basic hexagon
const client = new DisperseClient('https://your-project.supabase.co');

const result = await client.disperse({
  N: 108,
  steps: 200,
  R_grid: 64,
  s_grid: 64,
  num_sides: 6,
  shape_params: [1, 2, 1, 1, 2],
  v_lines: [21, 41],
  h_lines: [21, 41],
  holes: [[1, 1]]
});

console.log(`Generated ${result.results.total_points} points`);
console.log(client.visualizeASCII(result));

// Usage - Triangle with rotation
const result2 = await client.disperse({
  N: 30,
  steps: 60,
  R_grid: 35,
  s_grid: 160,
  num_sides: 3,
  edges: [15, 12],
  num_rotations: 8,
  enable_mirror: true
});

console.log(`\nOrientation entropy: ${result2.results.orientation_entropy_bits} bits`);
console.log('Sample orientations:', result2.results.orientation_history_sample);
```

---

### React Component

```tsx
import { useState } from 'react';

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

function DisperseVisualizer() {
  const [points, setPoints] = useState<Point[]>([]);
  const [orientationHistory, setOrientationHistory] = useState<OrientationState[]>([]);
  const [entropyBits, setEntropyBits] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sGrid, setSGrid] = useState(200);
  const [numRotations, setNumRotations] = useState(4);
  const [enableMirror, setEnableMirror] = useState(true);

  const runSimulation = async () => {
    setLoading(true);
    try {
      const response = await fetch(
        'https://your-project.supabase.co/functions/v1/disperse',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            N: 100,
            steps: 50,
            R_grid: 50,
            s_grid: sGrid,
            num_sides: 2,
            edges: [20],
            num_rotations: numRotations,
            enable_mirror: enableMirror
          })
        }
      );
      const data = await response.json();
      setPoints(data.results.points);
      setEntropyBits(data.results.orientation_entropy_bits);
      setOrientationHistory(data.results.orientation_history_sample);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <label>
          Grid Size:
          <input 
            type="number" 
            value={sGrid} 
            onChange={e => setSGrid(Number(e.target.value))}
          />
        </label>
        <label style={{ marginLeft: 20 }}>
          Rotations:
          <select 
            value={numRotations} 
            onChange={e => setNumRotations(Number(e.target.value))}
          >
            <option value={1}>None</option>
            <option value={2}>2 (0°/90°)</option>
            <option value={4}>4 (0°/45°/90°/135°)</option>
            <option value={8}>8 (8 angles)</option>
          </select>
        </label>
        <label style={{ marginLeft: 20 }}>
          <input 
            type="checkbox" 
            checked={enableMirror}
            onChange={e => setEnableMirror(e.target.checked)}
          />
          Enable Mirror
        </label>
      </div>
      
      <button onClick={runSimulation} disabled={loading}>
        {loading ? 'Running...' : 'Run Simulation'}
      </button>
      
      <svg width={400} height={400} style={{ border: '1px solid black', display: 'block', marginTop: 10 }}>
        {points.map(p => (
          <circle
            key={p.id}
            cx={p.x * 400 / sGrid}
            cy={400 - p.y * 400 / sGrid}
            r={3}
            fill="blue"
          />
        ))}
      </svg>
      
      <p>Total points: {points.length}</p>
      <p>Orientation entropy: {entropyBits} bits</p>
      {orientationHistory.length > 0 && (
        <div>
          <p>Sample orientations:</p>
          <ul>
            {orientationHistory.map(o => (
              <li key={o.step}>
                Step {o.step}: {o.rotation_angle.toFixed(1)}°, mirror={o.mirror.toString()}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default DisperseVisualizer;
```

---

## Error Handling Examples

### Invalid Parameters

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": -100,
    "steps": 50,
    "R_grid": 50,
    "s_grid": 500,
    "num_sides": 0,
    "shape_params": [5]
  }'
```

**Response**:
```json
{
  "success": false,
  "error": "N must be positive integer"
}
```

### Too Many Shapes for Space

```bash
curl -X POST https://your-project.supabase.co/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 10000,
    "steps": 100,
    "R_grid": 50,
    "s_grid": 100,
    "num_sides": 0,
    "shape_params": [10],
    "v_lines": [50],
    "h_lines": [50],
    "holes": [[0, 0], [0, 1], [1, 0], [1, 1]]
  }'
```

**Response** (if cells too small):
```json
{
  "success": false,
  "error": "Too many shapes: N > max_capacity"
}
```

---

## Entropy Calculation Reference

Calculate required entropy before running:

```python
def calculate_entropy(N, steps, num_rotations, enable_mirror):
    import math
    rot_bits = math.log2(num_rotations) if num_rotations > 1 else 0
    mirror_bits = 1 if enable_mirror else 0
    return N * steps * (rot_bits + mirror_bits)

# Examples
print(f"100 shapes, 50 steps, 4 rotations, mirror: {calculate_entropy(100, 50, 4, True):.0f} bits")
# Output: 15000 bits

print(f"50 shapes, 100 steps, 8 rotations, mirror: {calculate_entropy(50, 100, 8, True):.0f} bits")
# Output: 20000 bits
```
