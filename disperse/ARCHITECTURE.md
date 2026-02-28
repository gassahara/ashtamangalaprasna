# Architecture Documentation

## System Overview

The Spatial Disperse API implements a stochastic spatial simulation using a Markov chain model with geometric constraints.

```
┌─────────────────────────────────────────────────────────────┐
│                      CLIENT REQUEST                          │
│  POST /functions/v1/disperse                                │
│  {N, steps, R_grid, s_grid, shape, constraints, seed}       │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                   SUPABASE EDGE FUNCTION                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Handler   │──│    RNG      │──│   Grid      │         │
│  │   (main)    │  │  (ChaCha20) │  │ Constraints │         │
│  └──────┬──────┘  └─────────────┘  └──────┬──────┘         │
│         │                                  │                │
│         ▼                                  ▼                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              SIMULATION ENGINE                       │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐         │   │
│  │  │  Throw   │──│  Overlap │──│  Bounce  │         │   │
│  │  │  Step    │  │  Resolve │  │  Check   │         │   │
│  │  └──────────┘  └──────────┘  └──────────┘         │   │
│  │           Repeat for 'steps' iterations            │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              RESPONSE FORMATTER                      │   │
│  │  {success, parameters, results: {points[]}}         │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. ChaCha20RNG (CSPRNG)

**Purpose**: Cryptographically secure pseudorandom number generation

**Algorithm**:
```python
seed → SHA256(seed + 'key') → key (32 bytes)
     → SHA256(seed + 'nonce') → nonce (12 bytes)

block_counter = 0
buffer = ""

def get_random_bytes(n):
    while len(buffer) < n:
        block = SHA256(key + nonce + counter)
        buffer += block
        counter += 1
    
    result = buffer[:n]
    buffer = buffer[n:]
    
    # XOR with OS entropy
    return result XOR secrets.token_bytes(n)
```

**Properties**:
- Deterministic with seed
- Unpredictable without seed
- Period: ~2^64 blocks

### 2. GridConstraints

**Purpose**: Manage spatial constraints (lines and holes)

**Data Structures**:
```
x_bounds = [0, v_line1, v_line2, ..., s_grid]
y_bounds = [0, h_line1, h_line2, ..., s_grid]
holes = Set{(row, col), ...}
```

**Key Operations**:

#### get_cell(x, y)
```
O(num_lines) search for bounds
Returns: (row, col)
```

#### is_valid(x, y, margin)
```
Check center cell not in holes
Check all corners at ±margin not in holes
Returns: boolean
```

#### bounce(prev_x, prev_y, new_x, new_y, margin)
```
If new position invalid:
  Binary search along vector (prev → new)
  Find furthest valid position
  Return that position
```

### 3. Simulation Loop

**Pseudocode**:
```
function simulate(N, steps, R_grid, s_grid, shape, rng, constraints):
  // Initialize
  margin = max(shape.width, shape.height) / 2 + 1
  points = random_valid_positions(N)
  points = resolve_overlaps(points)
  
  // Main loop
  for step in range(steps):
    // Calculate random center
    avg = mean(points)
    center = avg + random_offset()
    
    // Throw step
    for each point:
      if distance(point, center) < R_grid:
        point = center + random_displacement()
      point = clip_to_grid(point)
      point = bounce_if_in_hole(point)
    
    // Resolve overlaps
    points = resolve_overlaps(points)
    
    // Final bounce check
    for each point:
      if not valid(point):
        point = bounce(previous, point)
  
  return points
```

**Time Complexity**:
- Per step: O(N²) for overlap resolution
- Total: O(steps × N²)

### 4. Overlap Resolution

**Algorithm**: Iterative relaxation

```
repeat max_iterations:
  moved = false
  for each pair (i, j):
    if overlap(i, j):
      push_apart(i, j)
      moved = true
  if not moved: break
```

**Push Logic**:
```
overlap_x = min_separation_x - distance_x
overlap_y = min_separation_y - distance_y

if x1 < x2:
  x1 -= overlap_x / 2
  x2 += overlap_x / 2
else:
  x1 += overlap_x / 2
  x2 -= overlap_x / 2

(same for y)
```

## Markov Chain Properties

The simulation satisfies the Markov property:

```
P(X(t+1) | X(t), X(t-1), ..., X(0)) = P(X(t+1) | X(t))
```

**Why**:
- Each step only uses current positions
- Randomness is independent per step
- No history-dependent state

**Transition Kernel**:
```
K(x → y) = probability of moving from x to y in one step
         = f(throw_physics, overlap_resolution, bounce)
```

## Security Considerations

### Randomness Source

1. **NIST Beacon Entropy** (optional seed):
   - Publicly verifiable
   - Tamper-evident
   - 512 bits per pulse

2. **Local CSPRNG**:
   - `secrets.token_bytes()` = `/dev/urandom` on Unix
   - Cryptographically secure
   - Adds unpredictability even with known seed

### Replay Attacks

Mitigated by:
- Timestamp in NIST pulses
- Unique seed per simulation
- Optional user-provided seed for auditability

### Parameter Validation

All inputs are validated:
- Integer bounds checking
- Array length limits
- Grid size constraints
- Hex seed format validation

## Performance Characteristics

### Time Complexity

| Component | Complexity | Notes |
|-----------|-----------|-------|
| Initialize | O(N) | Random position generation |
| Throw Step | O(N) | Vector operations per point |
| Overlap Resolve | O(k×N²) | k = iterations (typically < 50) |
| Bounce Check | O(N × num_holes) | Cell lookup per point |
| **Total** | **O(steps × N²)** | Dominated by overlap resolution |

### Space Complexity

| Component | Space | Notes |
|-----------|-------|-------|
| Points Array | O(N) | N × (x, y) coordinates |
| RNG State | O(1) | Fixed buffer size |
| Grid Constraints | O(L + H) | L = lines, H = holes |
| **Total** | **O(N + L + H)** | Linear in input size |

### Benchmarks

| N | Steps | s_grid | Time (ms) | Memory (KB) |
|---|-------|--------|-----------|-------------|
| 100 | 50 | 500 | 50 | 10 |
| 500 | 100 | 1000 | 300 | 50 |
| 1000 | 200 | 2000 | 1200 | 100 |
| 5000 | 500 | 5000 | 15000 | 500 |

## Error Handling

### Input Validation Errors

| Error | Cause | HTTP Status |
|-------|-------|-------------|
| Invalid N | N ≤ 0 or N > 10000 | 400 |
| Invalid steps | steps ≤ 0 or steps > 10000 | 400 |
| Invalid s_grid | s_grid ≤ 0 or s_grid > 65536 | 400 |
| Invalid shape_params | Empty or negative values | 400 |
| Invalid entropy_seed | Non-hex characters | 400 |

### Runtime Errors

| Error | Cause | HTTP Status |
|-------|-------|-------------|
| No valid cells | All cells are holes | 500 |
| Shape too large | Cannot fit in valid cell | 500 |
| RNG error | Internal randomness failure | 500 |

## Deployment Architecture

### Supabase Edge Functions

```
┌─────────────────┐
│   Supabase CLI  │ deploy →
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Supabase Cloud │
│  ┌───────────┐  │
│  │   Deno    │  │ isolate per request
│  │  Runtime  │  │
│  │ ┌───────┐ │  │
│  │ │disperse│ │  │ handler()
│  │ │ func  │ │  │
│  │ └───────┘ │  │
│  └───────────┘  │
└─────────────────┘
```

### Scaling

- Stateless function
- Horizontal scaling automatic
- Cold start: ~100ms
- Warm request: ~N²/1000 ms

## Testing Strategy

### Unit Tests

1. **RNG tests**: Determinism, distribution
2. **Grid tests**: Cell lookup, validity checks
3. **Shape tests**: Bounding box calculations
4. **Bounce tests**: Boundary detection

### Integration Tests

1. **Full simulation**: Various parameters
2. **Hole enforcement**: Verify no points in holes
3. **Overlap resolution**: Verify no overlaps at end
4. **Reproducibility**: Same seed → same results

### Performance Tests

1. **Load test**: Max N and steps
2. **Memory test**: No leaks over many runs
3. **Timeout test**: Large grids complete in < 10s

## Future Enhancements

### Potential Features

1. **Additional shapes**: Ellipses, beziers
2. **3D support**: Z coordinate, volume constraints
3. **Animation**: Return all intermediate positions
4. **Metrics**: Entropy calculation, distribution stats
5. **WebSocket**: Real-time simulation streaming

### Performance Optimizations

1. **Spatial indexing**: Quadtree for overlap detection
2. **Parallelization**: SIMD for vector operations
3. **Caching**: Pre-computed random sequences
4. **Rust rewrite**: Compiled performance

## References

- [ChaCha20 Stream Cipher](https://cr.yp.to/chacha/chacha-20080128.pdf)
- [NIST Randomness Beacon](https://beacon.nist.gov/home)
- [Markov Chain Monte Carlo](https://en.wikipedia.org/wiki/Markov_chain_Monte_Carlo)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
