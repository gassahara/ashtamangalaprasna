# Spatial Disperse API - Documentation Index

Complete documentation for the Supabase Edge Function spatial distribution simulator with per-step orientation support.

## Quick Links

| Document | Description |
|----------|-------------|
| [README.md](README.md) | Main API documentation, usage guide, client examples |
| [openapi.json](openapi.json) | OpenAPI 3.0 specification for auto-generated clients |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Internal design, algorithms, performance analysis |
| [EXAMPLES.md](EXAMPLES.md) | Comprehensive usage examples in multiple languages |
| [main.py](main.py) | Source code for the Edge Function |

## Overview

The **Spatial Disperse API** simulates distribution of geometric shapes in constrained spaces using:

- **Markov chain dynamics**: Stochastic movement with memoryless property
- **Hybrid CSPRNG**: ChaCha20-based randomness with NIST beacon entropy option
- **Geometric constraints**: Grid lines and holes (forbidden zones)
- **Bounce physics**: Shapes reflect off hole boundaries
- **Per-step orientation**: Rotation and mirror randomized each step

## Quick Start

### Deploy

```bash
supabase functions deploy disperse
```

### Call

```bash
curl -X POST https://<project>.supabase.co/functions/v1/disperse \
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

### Response

```json
{
  "success": true,
  "results": {
    "total_points": 100,
    "points": [{"id": 1, "x": 250, "y": 180}, ...],
    "orientation_entropy_bits": 0,
    "orientation_history_sample": []
  }
}
```

## Documentation Structure

### For API Users

1. **Start with [README.md](README.md)** for:
   - API endpoint and authentication
   - Request/response formats
   - Shape types and parameters
   - Per-step rotation and mirror configuration
   - Grid constraints (lines and holes)
   - Python and JavaScript client code

2. **See [EXAMPLES.md](EXAMPLES.md)** for:
   - 10+ complete usage examples
   - Circle, triangle, hexagon simulations
   - Line segments with rotation
   - Single hole, multiple holes, obstacle courses
   - Reproducible runs with entropy seeds
   - React component example
   - Error handling examples

3. **Use [openapi.json](openapi.json)** for:
   - Auto-generating TypeScript clients
   - Swagger UI documentation
   - Validation schemas
   - Importing into Postman/Insomnia

### For Developers

1. **Read [ARCHITECTURE.md](ARCHITECTURE.md)** for:
   - System design and data flow
   - Markov chain mathematics
   - ChaCha20 RNG implementation
   - Overlap resolution algorithm
   - Bounce physics
   - Per-step orientation randomization
   - Security considerations
   - Performance benchmarks

2. **Review [main.py](main.py)** for:
   - Complete source code
   - Component classes (RNG, Grid, Shape)
   - Simulation loop implementation
   - Error handling

## Common Use Cases

### 1. Particle Distribution

Distribute particles in a confined space with obstacles.

```json
{
  "N": 500,
  "steps": 200,
  "s_grid": 1000,
  "num_sides": 0,
  "shape_params": [3],
  "v_lines": [300, 700],
  "h_lines": [300, 700],
  "holes": [[1, 1]]
}
```

### 2. Network Node Placement

Place nodes avoiding central hub area.

```json
{
  "N": 50,
  "steps": 100,
  "s_grid": 200,
  "num_sides": 3,
  "shape_params": [15, 12],
  "holes": [[1, 1]]
}
```

### 3. Art/Visualization with Rotation

Generate patterns with rotating shapes.

```json
{
  "N": 100,
  "steps": 200,
  "s_grid": 400,
  "num_sides": 2,
  "edges": [20],
  "num_rotations": 8,
  "enable_mirror": true
}
```

### 4. Game Development

Spawn enemies with no-overlap constraints.

```json
{
  "N": 20,
  "steps": 30,
  "s_grid": 100,
  "num_sides": 0,
  "shape_params": [8],
  "holes": [[0, 0], [2, 2]]
}
```

## Parameter Reference

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| N | integer | 100 | 1-10000 | Number of shapes |
| steps | integer | 50 | 1-10000 | Simulation iterations |
| R_grid | integer | 50 | 1-65536 | Capture radius |
| s_grid | integer | 500 | 1-65536 | Grid size S×S |
| num_sides | integer | 0 | 0-100 | Shape type (0=circle, 2=line, 3=triangle, etc.) |
| shape_params | array | [3] | 1+ items | Shape dimensions (alias: edges) |
| num_rotations | integer | 1 | 1-360 | Rotation positions (1=none, 2=0°/90°, 4=0°/45°/90°/135°) |
| enable_mirror | boolean | false | - | Enable per-step mirror randomization |
| v_lines | array | [] | 0+ items | Vertical grid lines (alias: vertical_lines) |
| h_lines | array | [] | 0+ items | Horizontal grid lines (alias: horizontal_lines) |
| holes | array | [] | 0+ items | Forbidden cells [[row, col], ...] (alias: forbidden_cells) |
| entropy_seed | string | null | hex 32+ chars | Reproducibility seed |

## Shape Reference

| num_sides | Shape | params | Example |
|-----------|-------|--------|---------|
| 0 | Circle | [radius] | `[5]` |
| 2 | Line | [length] | `[20]` |
| 3 | Triangle | [side1, side2] | `[10, 8]` |
| 4 | Quadrilateral | [s1, s2, s3] | `[10, 8, 6]` |
| 5 | Pentagon | [s1, s2, s3, s4] | `[10, 8, 6, 4]` |
| 6 | Hexagon | [s1, s2, s3, s4, s5] | `[2, 3, 2, 2, 3]` |

## Per-Step Orientation Reference

### Rotation Calculation

```
rotation_angle = rotation_index × (180° / num_rotations)
```

| num_rotations | Angles | Bits/shape/step |
|--------------|--------|-----------------|
| 1 | 0° | 0 bits |
| 2 | 0°, 90° | 1 bit |
| 3 | 0°, 60°, 120° | 1.58 bits |
| 4 | 0°, 45°, 90°, 135° | 2 bits |
| 6 | 0°, 30°, 60°, 90°, 120°, 150° | 2.58 bits |
| 8 | 0°, 22.5°, 45°, 67.5°, 90°, 112.5°, 135°, 157.5° | 3 bits |

### Mirror Entropy

- `enable_mirror: false`: 0 bits
- `enable_mirror: true`: 1 bit per shape per step

### Total Orientation Entropy

```
total_bits = N × steps × (rotation_bits + mirror_bits)
```

Example: N=100, steps=50, num_rotations=4, enable_mirror=true
```
total_bits = 100 × 50 × (2 + 1) = 15,000 bits
```

## Response Fields

| Field | Type | Description |
|-------|------|-------------|
| success | boolean | Whether simulation succeeded |
| parameters | object | Echo of input parameters |
| results.total_points | integer | Number of shapes generated (N) |
| results.points | array | List of {id, x, y} coordinates |
| results.orientation_entropy_bits | integer | Bits consumed by orientation randomization |
| results.orientation_history_sample | array | Sample of orientation states per step |

## Testing

Run local tests:

```bash
cd supabase/functions/disperse
python3 test.py
```

Serve locally:

```bash
supabase functions serve disperse
```

Test with rotation:

```bash
curl -X POST http://localhost:54321/functions/v1/disperse \
  -H "Content-Type: application/json" \
  -d '{
    "N": 10,
    "steps": 20,
    "num_sides": 2,
    "edges": [15],
    "num_rotations": 4,
    "enable_mirror": true
  }'
```

## Support

- **Issues**: GitHub Issues
- **Documentation**: This directory
- **Examples**: [EXAMPLES.md](EXAMPLES.md)
- **API Spec**: [openapi.json](openapi.json)

## License

MIT License - See source files for details.
