// Minimal Reed-Solomon erasure coding over GF(2^8)
// Supports RS(n, k) where n <= 255, k <= n
// For erasure channels (we know which frames are missing)
var RS = (function() {
    // GF(2^8) with primitive polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1)
    var EXP = new Uint8Array(512);
    var LOG = new Uint8Array(256);
    var x = 1;
    for (var i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        x = (x << 1) ^ (x & 0x80 ? 0x11D : 0);
    }
    for (var i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

    function gfMul(a, b) {
        if (a === 0 || b === 0) return 0;
        return EXP[LOG[a] + LOG[b]];
    }

    function gfDiv(a, b) {
        if (b === 0) throw new Error('GF division by zero');
        if (a === 0) return 0;
        return EXP[(LOG[a] - LOG[b] + 255) % 255];
    }

    function gfPow(a, n) {
        if (n === 0) return 1;
        if (a === 0) return 0;
        return EXP[(LOG[a] * n) % 255];
    }

    // Build encoding matrix row for shard index s, given k data shards
    // Data shards (s < k): identity row — shard[s] = data[s]
    // Parity shards (s >= k): Vandermonde row with evaluation point s
    function encodingRow(s, k) {
        var row = new Array(k);
        if (s < k) {
            for (var j = 0; j < k; j++) row[j] = (j === s) ? 1 : 0;
        } else {
            for (var j = 0; j < k; j++) row[j] = gfPow(2, s * j);
        }
        return row;
    }

    // Encode: k data shards -> n total shards (k data + n-k parity)
    // Each shard is a Uint8Array of the same length
    function encode(dataShards, parityCount) {
        var k = dataShards.length;
        var n = k + parityCount;
        var shardLen = dataShards[0].length;
        var shards = new Array(n);
        for (var i = 0; i < k; i++) shards[i] = dataShards[i];
        for (var p = 0; p < parityCount; p++) {
            var parity = new Uint8Array(shardLen);
            var encRow = encodingRow(k + p, k);
            for (var i = 0; i < k; i++) {
                if (encRow[i] !== 0) {
                    var data = shards[i];
                    for (var j = 0; j < shardLen; j++) {
                        parity[j] ^= gfMul(data[j], encRow[i]);
                    }
                }
            }
            shards[k + p] = parity;
        }
        return shards;
    }

    // Decode: given shards array with some null entries, recover all
    // shardIndices: which shard indices we have (length >= k)
    // Returns recovered shards array
    function decode(shards, shardIndices, k) {
        var n = shards.length;
        var shardLen = 0;
        for (var i = 0; i < n; i++) {
            if (shards[i]) { shardLen = shards[i].length; break; }
        }

        // Find which shards are missing
        var have = {};
        for (var i = 0; i < shardIndices.length; i++) have[shardIndices[i]] = true;
        var missing = [];
        for (var i = 0; i < n; i++) {
            if (!have[i]) missing.push(i);
        }

        if (missing.length === 0) return shards; // nothing to recover

        // We need at least k shards
        if (shardIndices.length < k) {
            throw new Error('Not enough shards: have ' + shardIndices.length + ', need ' + k);
        }

        // Use only the first k available shards for recovery
        var used = shardIndices.slice(0, k);
        var usedShards = new Array(k);
        for (var i = 0; i < k; i++) usedShards[i] = shards[used[i]];

        // Build the k x k encoding submatrix for the used shards
        var matrix = [];
        for (var i = 0; i < k; i++) {
            matrix[i] = encodingRow(used[i], k);
        }

        // Invert the matrix (Gauss-Jordan over GF(2^8))
        var inv = invertMatrix(matrix, k);
        if (!inv) throw new Error('Matrix is singular, cannot recover');

        // Recover shards
        var recovered = new Array(n);
        for (var i = 0; i < n; i++) {
            if (shards[i]) {
                recovered[i] = shards[i];
            }
        }

        for (var mi = 0; mi < missing.length; mi++) {
            var m = missing[mi];
            var result = new Uint8Array(shardLen);
            var encRow = encodingRow(m, k);
            // shard[m] = encRow * M^-1 * received
            // Compute combined coefficients: coeff[j] = sum_l encRow[l] * inv[l][j]
            // Then result = sum_j coeff[j] * receivedShard[j]
            for (var j = 0; j < k; j++) {
                var coeff = 0;
                for (var l = 0; l < k; l++) {
                    coeff ^= gfMul(encRow[l], inv[l][j]);
                }
                if (coeff !== 0) {
                    for (var s = 0; s < shardLen; s++) {
                        result[s] ^= gfMul(usedShards[j][s], coeff);
                    }
                }
            }
            recovered[m] = result;
        }

        return recovered;
    }

    // Invert a k x k matrix over GF(2^8)
    function invertMatrix(mat, k) {
        // Augment with identity
        var aug = [];
        for (var i = 0; i < k; i++) {
            aug[i] = [];
            for (var j = 0; j < k; j++) aug[i][j] = mat[i][j];
            for (var j = 0; j < k; j++) aug[i][k + j] = (i === j) ? 1 : 0;
        }
        // Forward elimination
        for (var col = 0; col < k; col++) {
            // Find pivot
            var pivot = -1;
            for (var row = col; row < k; row++) {
                if (aug[row][col] !== 0) { pivot = row; break; }
            }
            if (pivot === -1) return null; // singular
            // Swap
            if (pivot !== col) {
                var tmp = aug[col]; aug[col] = aug[pivot]; aug[pivot] = tmp;
            }
            // Scale pivot row
            var invPivot = gfDiv(1, aug[col][col]);
            for (var j = 0; j < 2 * k; j++) aug[col][j] = gfMul(aug[col][j], invPivot);
            // Eliminate column
            for (var row = 0; row < k; row++) {
                if (row !== col && aug[row][col] !== 0) {
                    var factor = aug[row][col];
                    for (var j = 0; j < 2 * k; j++) {
                        aug[row][j] ^= gfMul(aug[col][j], factor);
                    }
                }
            }
        }
        // Extract inverse
        var inv = [];
        for (var i = 0; i < k; i++) {
            inv[i] = [];
            for (var j = 0; j < k; j++) inv[i][j] = aug[i][k + j];
        }
        return inv;
    }

    return { encode: encode, decode: decode };
})();
