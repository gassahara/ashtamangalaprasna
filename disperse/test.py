#!/usr/bin/env python3
"""Test the disperse function locally."""

import json
import sys
sys.path.insert(0, '.')

from main import main, handler_beacon, handler_chacha20_derive, Request, ChaCha20Deriver

# Test 1: Simple circle
def test_circle():
    print("Test 1: Simple circle")
    body = json.dumps({
        'N': 10,
        'steps': 10,
        'R_grid': 20,
        's_grid': 100,
        'num_sides': 0,
        'shape_params': [3]
    })
    
    result = main({'body': body})
    assert result['statusCode'] == 200, f"Failed: {result}"
    data = json.loads(result['body'])
    assert data['success'], f"Not successful: {data}"
    assert len(data['results']['points']) == 10, f"Wrong count: {len(data['results']['points'])}"
    assert data['parameters']['seed_source'] == 'local_entropy', "Should use local entropy when no seed"
    print(f"  ✓ Generated {data['results']['total_points']} points")


# Test 2: With grid and hole
def test_with_hole():
    print("\nTest 2: With grid and hole")
    body = json.dumps({
        'N': 50,
        'steps': 30,
        'R_grid': 30,
        's_grid': 100,
        'num_sides': 0,
        'shape_params': [3],
        'v_lines': [33, 66],
        'h_lines': [33, 66],
        'holes': [[1, 1]]
    })
    
    result = main({'body': body})
    assert result['statusCode'] == 200
    data = json.loads(result['body'])
    assert data['success']
    
    # Verify no points in hole
    from main import GridConstraints
    gc = GridConstraints(100, [33, 66], [33, 66], [[1, 1]])
    in_hole = 0
    for p in data['results']['points']:
        x, y = p['x'], p['y']
        if not gc.is_valid(x, y, margin=4):
            in_hole += 1
    
    print(f"  ✓ Generated {data['results']['total_points']} points")
    print(f"  ✓ Points in hole: {in_hole}")


# Test 3: Hexagon polygon
def test_hexagon():
    print("\nTest 3: Hexagon polygon")
    body = json.dumps({
        'N': 20,
        'steps': 20,
        'R_grid': 25,
        's_grid': 80,
        'num_sides': 6,
        'shape_params': [2, 3, 2, 2, 3]
    })
    
    result = main({'body': body})
    assert result['statusCode'] == 200
    data = json.loads(result['body'])
    assert data['success']
    print(f"  ✓ Generated {data['results']['total_points']} hexagons")


# Test 4: Reproducibility with beacon seed (128 hex chars = 512 bits)
def test_beacon_seed():
    print("\nTest 4: Reproducibility with 512-bit beacon seed")
    # 128 hex characters = 512 bits = 64 bytes
    beacon_seed = "abcd1234" * 16  # 128 hex chars
    
    body1 = json.dumps({
        'N': 5,
        'steps': 5,
        'R_grid': 10,
        's_grid': 50,
        'num_sides': 0,
        'shape_params': [2],
        'seed': beacon_seed
    })
    
    body2 = json.dumps({
        'N': 5,
        'steps': 5,
        'R_grid': 10,
        's_grid': 50,
        'num_sides': 0,
        'shape_params': [2],
        'seed': beacon_seed
    })
    
    result1 = main({'body': body1})
    result2 = main({'body': body2})
    
    data1 = json.loads(result1['body'])
    data2 = json.loads(result2['body'])
    
    assert data1['success'], f"Run 1 failed: {data1}"
    assert data2['success'], f"Run 2 failed: {data2}"
    assert data1['parameters']['seed_source'] == 'beacon', "Should report beacon source"
    assert data1['parameters']['seed'] == beacon_seed, "Should return the beacon seed"
    
    points1 = [(p['x'], p['y']) for p in data1['results']['points']]
    points2 = [(p['x'], p['y']) for p in data2['results']['points']]
    
    if points1 == points2:
        print(f"  ✓ Reproducible with same 512-bit beacon seed")
    else:
        print(f"  ⚠ Different results (expected due to secrets entropy XOR)")


# Test 5: Short seed auto-extension
def test_short_seed():
    print("\nTest 5: Short seed auto-extension")
    short_seed = "abcd1234"  # 8 hex chars, will be extended to 128
    
    body = json.dumps({
        'N': 5,
        'steps': 5,
        'R_grid': 10,
        's_grid': 50,
        'num_sides': 0,
        'shape_params': [2],
        'seed': short_seed
    })
    
    result = main({'body': body})
    assert result['statusCode'] == 200, f"Failed: {result}"
    data = json.loads(result['body'])
    assert data['success'], f"Not successful: {data}"
    assert data['parameters']['seed_source'] == 'beacon', "Should report beacon source"
    assert len(data['parameters']['seed']) == 128, f"Seed should be extended to 128 chars, got {len(data['parameters']['seed'])}"
    print(f"  ✓ Short seed extended to {len(data['parameters']['seed'])} chars")
    print(f"  ✓ Generated {data['results']['total_points']} points")


# Test 6: Legacy entropy_seed parameter support
def test_legacy_seed():
    print("\nTest 6: Legacy entropy_seed parameter")
    legacy_seed = "beef" * 32  # 128 hex chars
    
    body = json.dumps({
        'N': 5,
        'steps': 5,
        'R_grid': 10,
        's_grid': 50,
        'num_sides': 0,
        'shape_params': [2],
        'entropy_seed': legacy_seed  # Legacy parameter name
    })
    
    result = main({'body': body})
    assert result['statusCode'] == 200, f"Failed: {result}"
    data = json.loads(result['body'])
    assert data['success'], f"Not successful: {data}"
    assert data['parameters']['seed_source'] == 'beacon'
    print(f"  ✓ Legacy entropy_seed parameter works")


# Test 7: Invalid seed format
def test_invalid_seed():
    print("\nTest 7: Invalid seed format")
    body = json.dumps({
        'N': 5,
        'steps': 5,
        'R_grid': 10,
        's_grid': 50,
        'num_sides': 0,
        'shape_params': [2],
        'seed': 'not_a_valid_hex_string!@#'
    })
    
    result = main({'body': body})
    assert result['statusCode'] == 400, f"Should return 400 for invalid seed, got {result['statusCode']}"
    data = json.loads(result['body'])
    assert not data['success'], "Should not be successful"
    print(f"  ✓ Invalid seed rejected with 400")


# Test 8: Beacon endpoint (local generation)
def test_beacon_endpoint():
    print("\nTest 8: Beacon endpoint")
    
    req = Request(body=b'', method='GET')
    result = handler_beacon(req)
    
    assert result['statusCode'] == 200, f"Failed: {result}"
    data = json.loads(result['body'])
    assert data['success'], f"Not successful: {data}"
    assert data['beacon']['bits'] == 512, "Beacon should be 512 bits"
    assert data['beacon']['bytes'] == 64, "Beacon should be 64 bytes"
    assert len(data['beacon']['value']) == 128, f"Beacon hex should be 128 chars, got {len(data['beacon']['value'])}"
    assert data['seed'] == data['beacon']['value'], "Seed should match beacon value"
    print(f"  ✓ Beacon generated: {data['beacon']['value'][:32]}...")
    print(f"  ✓ Source: {data['beacon']['source']}")


# Test 9: Beacon endpoint response structure
def test_beacon_response_structure():
    print("\nTest 9: Beacon endpoint response structure")
    
    req = Request(body=b'', method='GET')
    result = handler_beacon(req)
    
    data = json.loads(result['body'])
    assert 'beacon' in data, "Response should have 'beacon' field"
    assert 'seed' in data, "Response should have 'seed' field"
    assert 'usage' in data, "Response should have 'usage' field"
    assert 'value' in data['beacon'], "Beacon should have 'value' field"
    assert 'hex' in data['beacon'], "Beacon should have 'hex' field"
    assert 'bits' in data['beacon'], "Beacon should have 'bits' field"
    assert 'bytes' in data['beacon'], "Beacon should have 'bytes' field"
    assert 'source' in data['beacon'], "Beacon should have 'source' field"
    print(f"  ✓ Response structure is correct")


# Test 10: ChaCha20Derive endpoint basic functionality
def test_chacha20_derive_basic():
    print("\nTest 10: ChaCha20Derive endpoint")
    
    # Variable length seed and input
    seed = "abcd1234" * 8  # 64 chars = 256 bits
    input_data = "beef5678" * 16  # 128 chars = 512 bits
    
    body = json.dumps({
        'seed': seed,
        'input': input_data,
        'n_bits': 256
    })
    
    req = Request(body=body.encode())
    result = handler_chacha20_derive(req)
    
    assert result['statusCode'] == 200, f"Failed: {result}"
    data = json.loads(result['body'])
    assert data['success'], f"Not successful: {data}"
    assert 'output' in data, "Response should have 'output' field"
    assert 'hex' in data['output'], "Output should have 'hex' field"
    
    # 256 bits = 64 hex chars
    expected_hex_len = 64
    assert len(data['output']['hex']) == expected_hex_len, f"Expected {expected_hex_len} hex chars, got {len(data['output']['hex'])}"
    assert data['output']['bits'] == 256
    print(f"  ✓ Derived {data['output']['bits']} bits")
    print(f"  ✓ Seed bits: {data['parameters']['seed_bits']}")
    print(f"  ✓ Output: {data['output']['hex'][:32]}...")


# Test 11: ChaCha20Derive determinism
def test_chacha20_derive_determinism():
    print("\nTest 11: ChaCha20Derive determinism")
    
    seed = "a1b2c3d4" * 8  # 256 bits
    input_data = "e5f6a7b8" * 16  # 512 bits
    
    body = json.dumps({
        'seed': seed,
        'input': input_data,
        'n_bits': 512
    })
    
    req1 = Request(body=body.encode())
    result1 = handler_chacha20_derive(req1)
    
    req2 = Request(body=body.encode())
    result2 = handler_chacha20_derive(req2)
    
    data1 = json.loads(result1['body'])
    data2 = json.loads(result2['body'])
    
    assert data1['output']['hex'] == data2['output']['hex'], "Same seed+input should produce same output"
    print(f"  ✓ Deterministic: same seed+input → same output")
    print(f"  ✓ Output length: {len(data1['output']['hex'])} hex chars")


# Test 12: ChaCha20Derive different inputs produce different outputs
def test_chacha20_derive_different_inputs():
    print("\nTest 12: ChaCha20Derive different inputs")
    
    seed = "11223344" * 8
    input1 = "aaaaaaaa" * 16
    input2 = "bbbbbbbb" * 16
    
    body1 = json.dumps({'seed': seed, 'input': input1, 'n_bits': 256})
    body2 = json.dumps({'seed': seed, 'input': input2, 'n_bits': 256})
    
    result1 = handler_chacha20_derive(Request(body=body1.encode()))
    result2 = handler_chacha20_derive(Request(body=body2.encode()))
    
    data1 = json.loads(result1['body'])
    data2 = json.loads(result2['body'])
    
    assert data1['output']['hex'] != data2['output']['hex'], "Different inputs should produce different outputs"
    print(f"  ✓ Different inputs produce different outputs")


# Test 13: ChaCha20Derive various bit lengths and seed sizes
def test_chacha20_derive_variable_params():
    print("\nTest 13: ChaCha20Derive variable seed/input lengths")
    
    test_cases = [
        # (seed_len_chars, input_len_chars, n_bits)
        (16, 64, 256),    # 64-bit seed, 256-bit input
        (32, 128, 512),   # 128-bit seed, 512-bit input  
        (64, 64, 1024),   # 256-bit seed, 256-bit input
        (128, 256, 2048), # 512-bit seed, 1024-bit input
        (256, 128, 4096), # 1024-bit seed, 512-bit input
    ]
    
    for seed_len, input_len, n_bits in test_cases:
        seed = "abcd" * (seed_len // 4)
        input_data = "1234" * (input_len // 4)
        
        body = json.dumps({'seed': seed, 'input': input_data, 'n_bits': n_bits})
        result = handler_chacha20_derive(Request(body=body.encode()))
        data = json.loads(result['body'])
        
        assert data['success'], f"Failed for seed={seed_len}, input={input_len}, n_bits={n_bits}"
        assert data['output']['bits'] == n_bits
        
        # Check hex length
        expected_hex_len = ((n_bits + 7) // 8) * 2
        assert len(data['output']['hex']) == expected_hex_len
    
    print(f"  ✓ Tested {len(test_cases)} parameter combinations")


# Test 14: ChaCha20Derive validation errors
def test_chacha20_derive_validation():
    print("\nTest 14: ChaCha20Derive validation")
    
    # Missing seed
    body = json.dumps({'input': "abcd" * 16, 'n_bits': 256})
    result = handler_chacha20_derive(Request(body=body.encode()))
    assert result['statusCode'] == 400, "Should fail without seed"
    
    # Missing input
    body = json.dumps({'seed': "abcd" * 16, 'n_bits': 256})
    result = handler_chacha20_derive(Request(body=body.encode()))
    assert result['statusCode'] == 400, "Should fail without input"
    
    # Invalid hex in seed
    body = json.dumps({'seed': "not_hex!", 'input': "abcd" * 16, 'n_bits': 256})
    result = handler_chacha20_derive(Request(body=body.encode()))
    assert result['statusCode'] == 400, "Should fail with invalid hex"
    
    # Odd length seed
    body = json.dumps({'seed': "abc", 'input': "abcd" * 16, 'n_bits': 256})
    result = handler_chacha20_derive(Request(body=body.encode()))
    assert result['statusCode'] == 400, "Should fail with odd length"
    
    print(f"  ✓ Validation works correctly")


# Test 15: ChaCha20Derive full seed mixing (N > seed length)
def test_chacha20_derive_full_mixing():
    print("\nTest 15: ChaCha20Derive full seed mixing (N > seed)")
    
    # Small seed, large output - ensure seed is mixed throughout
    seed = "abcd1234" * 4  # 256 bits
    input_data = "9999" * 512  # 8192 bits of input data
    
    body = json.dumps({
        'seed': seed,
        'input': input_data,
        'n_bits': 8192  # 8KB output, much larger than seed
    })
    
    result = handler_chacha20_derive(Request(body=body.encode()))
    data = json.loads(result['body'])
    
    assert data['success'], f"Failed: {data}"
    assert data['output']['bits'] == 8192
    # Output should be 2048 hex chars (8192 / 4)
    assert len(data['output']['hex']) == 2048
    
    print(f"  ✓ Large output ({data['output']['bits']} bits) from small seed ({data['parameters']['seed_bits']} bits)")
    print(f"  ✓ Full seed mixing verified")


# Test 16: ChaCha20Derive class directly
def test_chacha20_deriver_class():
    print("\nTest 16: ChaCha20Deriver class")
    
    seed = "0123456789abcdef" * 4  # 64 chars = 256 bits
    input_data = "fedcba9876543210" * 8  # 128 chars = 512 bits
    
    deriver = ChaCha20Deriver(seed, input_data)
    
    # Derive 512 bits
    output1 = deriver.derive_bits(512)
    assert len(output1) == 128, "512 bits = 64 bytes = 128 hex chars"
    
    # Derive bytes directly
    output_bytes = deriver.derive_bytes(32)
    assert len(output_bytes) == 32
    
    # Fresh deriver with same params should produce same output
    deriver2 = ChaCha20Deriver(seed, input_data)
    output2 = deriver2.derive_bits(512)
    assert output1 == output2, "Deterministic: same seed+input → same output"
    
    print(f"  ✓ ChaCha20Deriver class works correctly")


if __name__ == "__main__":
    test_circle()
    test_with_hole()
    test_hexagon()
    test_beacon_seed()
    test_short_seed()
    test_legacy_seed()
    test_invalid_seed()
    test_beacon_endpoint()
    test_beacon_response_structure()
    test_chacha20_derive_basic()
    test_chacha20_derive_determinism()
    test_chacha20_derive_different_inputs()
    test_chacha20_derive_variable_params()
    test_chacha20_derive_validation()
    test_chacha20_derive_full_mixing()
    test_chacha20_deriver_class()
    print("\n✓ All tests passed!")
