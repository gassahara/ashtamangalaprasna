# Prasna Chakra - 108 Kavane

## Overview

The Prasna Chakra is a sacred geometric distribution of 108 elements (kavane) representing the 108 beads of a traditional mala. Each kavane is a hexagon distributed across a 72×72 grid with a central hole (empty space).

## Configuration

| Parameter | Value | Description |
|-----------|-------|-------------|
| N (Elements) | 108 | Number of kavane (beads) |
| Shape | Irregular Hexagon | 6-sided polygon with alternating sides |
| Sides | [3, 2, 3, 2, 3, 2] | Alternating side lengths (3, 2, 3, 2, 3, 2) |
| Grid Size | 72×72 | Canvas grid units |
| Center | Hole | Empty space in center |
| Hole Radius | 8 | Approximate radius of center hole |

## Randomness Sources

The implementation uses **dynamic entropy calculation** to ensure sufficient randomness:

### Configuration
- **Beacons**: 3 × 512 bits each = 1536 bits
- **Target Entropy**: 3072+ bits minimum
- **Additional Random Blocks**: Calculated dynamically

### Dynamic Calculation

```javascript
// Calculate required random blocks
const beaconBits = numBeacons * 512;  // 3 × 512 = 1536 bits
const remainingBits = targetBits - beaconBits;  // 3072 - 1536 = 1536 bits
const requiredBlocks = ceil(remainingBits / 512);  // 3 blocks
```

### Sources

1. **Beacons** (3 × 512 bits):
   - External beacon (NIST Randomness Beacon) or local entropy
   - Fetched in parallel from `/beacon` endpoint

2. **Crypto Random Blocks** (N × 512 bits):
   - Generated via Web Crypto API
   - Number of blocks calculated dynamically based on target entropy
   - Each block: 64 bytes = 512 bits

```javascript
const array = new Uint8Array(64);
crypto.getRandomValues(array);
```

### Combined Seed

The final seed combines all sources with alternating pattern:
```
seed = beacon1 + random1 + beacon2 + random2 + beacon3 + random3 + random4 + ...
```

This ensures:
- **Minimum**: 3072 bits of entropy
- **Mixing**: External and local entropy are interleaved
- **Scalability**: More random blocks added if target increases

## API Usage

### Endpoint
```
POST https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/disperse
```

### Request Body
```json
{
  "N": 108,
  "steps": 100,
  "R_grid": 8,
  "s_grid": 72,
  "num_sides": 6,
  "shape_params": [3, 3, 3, 3, 3],
  "num_rotations": 6,
  "enable_mirror": true,
  "v_lines": [],
  "h_lines": [],
  "holes": [[36, 36], [36, 37], ...],
  "seed": "abcdef123456..."
}
```

### Response
```json
{
  "success": true,
  "parameters": { ... },
  "results": {
    "total_points": 108,
    "points": [{"id": 1, "x": 45, "y": 32}, ...],
    "orientation_entropy_bits": 650,
    "orientation_history_sample": [...]
  }
}
```

## Canvas Projection

The grid coordinates (0-72) are normalized and projected to canvas coordinates:

```javascript
// Normalize to canvas
const scaleX = canvas.width / 72;
const scaleY = canvas.height / 72;

const canvasX = gridX * scaleX;
const canvasY = gridY * scaleY;
```

## Center Hole

The center hole is defined as a circular exclusion zone at the center of the grid:

```javascript
const center = [36, 36];  // Center of 72×72 grid
const radius = 8;         // Hole radius

// Any cell within radius distance from center is a "hole"
if (distance(cell, center) < radius) {
    // This cell is excluded (empty)
}
```

## Hexagon Drawing

Each kavane is drawn as a hexagon using canvas path:

```javascript
// Hexagon vertices
for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    const x = centerX + size * Math.cos(angle);
    const y = centerY + size * Math.sin(angle);
    // ... draw
}
```

## Usage

1. Open `prasna-chakra.html` in a browser
2. Click "Generate Prasna Chakra"
3. The sacred casting animation begins with:
   - **Vedic Atmosphere**: Animated stars, rotating mandala, pulsing Om symbol
   - **Verbose Status Messages**: Six steps of Vedic wisdom and technical progress
   - **Vedic Wisdom Panel**: Rotating quotes from sacred texts
4. The system will:
   - Invoke the sacred space (Step 1)
   - Fetch 3 beacons from cosmic sources (Step 2)
   - Cast the 108 kavane (Step 3)
   - Project cosmic distribution (Step 4)
   - Draw the sacred geometry (Step 5)
   - Complete with Vedic blessing (Step 6)
5. Click "Download Result" to save the PNG

## Casting Animation Features

### Vedic Atmosphere Overlay
When casting begins, a full-screen overlay appears with:
- **Twinkling Stars**: Background animation representing cosmic energies
- **Rotating Mandala**: Three concentric circles rotating at different speeds
- **Sacred Om (ॐ)**: Pulsing golden symbol at the center
- **Progress Bar**: Shows casting progress through 6 steps
- **Skip Button**: Option to skip animation and proceed quickly

### Verbose Status Messages
Each step displays educational Vedic wisdom:

| Step | Status Message | Vedic Teaching |
|------|----------------|----------------|
| 1 | Invoking sacred space | Purusha-Prakriti union, Navagraha alignment |
| 2 | Fetching beacons | Shiva's cosmic dance, Brihat Samhita on Time |
| 3 | Casting 108 kavane | 108 Nadis, Brahma's breath, expansion-contraction |
| 4 | Projecting to chakra | 72,000 Nadis, Shunya (void) as creation source |
| 5 | Drawing geometry | Bhagavad Gita on perfection and evolution |
| 6 | Completion | Prashna Upanishad on Self and Universe, Om Shanti |

### Vedic Wisdom Panel
A permanently visible panel displays rotating quotes from:
- Prasna Tantra
- Jyotish Shastra
- Vedanta Sutras
- Brihat Parashara Hora Shastra
- Mandukya Upanishad
- Surya Siddhanta
- Ayurveda & Marma Shastra
- Bhagavad Gita
- And more...

## Visualization

- **Gold hexagons**: 108 kavane distributed across the grid
- **Black center**: The hole (empty space)
- **Dashed circle**: Hole boundary
- **Golden center dot**: Reference point for the chakra center
- **Grid lines**: Faint 72×72 grid for reference

## Sacred Experience Design

The Prasna Chakra is not merely a technical tool—it is a sacred instrument of divination. The interface has been designed to create a Vedic atmosphere that honors the tradition of Jyotish (Vedic astrology).

### The Six Steps of Casting

The casting process mirrors the Vedic cosmogony:

1. **Invocation** - Like the Rishi calling upon the devas before a yajna (sacrifice)
2. **Entropy Gathering** - Collecting the prana (life force) from cosmic sources
3. **Distribution** - The 108 kavane fall like the 108 beads of the japamala during japa
4. **Projection** - Mapping the subtle energies onto the gross plane
5. **Manifestation** - Drawing the sacred geometry that reveals hidden patterns
6. **Blessing** - Completing with the Shanti Mantra for peace on all levels

### Vedic Educational Component

Throughout the experience, users learn:
- The significance of 108 in Vedic tradition (9 planets × 12 houses)
- The symbolism of the hexagon (Shani's geometry)
- The concept of Shunya (void) as the source of creation
- The 72,000 Nadis and their connection to the 72×72 grid
- Wisdom from the Upanishads, Gita, and Jyotish Shastras

## Technical Details

### Shape Parameters

For an **irregular hexagon** with alternating sides [3, 2, 3, 2, 3, 2]:

```
Side 1: 3 units
Side 2: 2 units  
Side 3: 3 units
Side 4: 2 units
Side 5: 3 units
Side 6: 2 units (determined geometrically)
```

API parameters:
- `num_sides = 6`
- `shape_params = [3, 2, 3, 2, 3]` (first 5 sides)
- The 6th side (2 units) is determined geometrically by the API

This creates a non-regular hexagon where sides alternate between lengths 3 and 2, giving it a distinctive sacred geometry pattern.

### Simulation Parameters

- `steps = 100`: Number of simulation iterations
- `R_grid = 8`: Capture radius for throw mechanism
- `num_rotations = 6`: 6 rotation positions (0°, 60°, 120°, 180°, 240°, 300°)
- `enable_mirror = true`: Allow mirror/flipping for variety

### Constraints

- Grid boundaries: 0-72 on both axes
- Center hole: Circular exclusion zone
- No overlapping: Collision detection ensures hexagons don't overlap
- Bounce physics: Shapes bounce off hole boundaries
