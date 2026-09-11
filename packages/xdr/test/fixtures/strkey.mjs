// Minimal StrKey (ed25519 public key / "G..." address) encoder, used only to
// generate synthetic accounts for test fixtures below. Not part of the
// published package — StellarTxGuard never needs to construct addresses,
// only read them out of already-decoded XDR.
//
// Everything here is deterministic and pure: the same input byte always
// produces the exact same address, on every run, on every machine. This is
// deliberate — the checked-in fixtures.json this feeds (via
// generate-fixtures.mjs) must be byte-for-byte reproducible, so nothing in
// this file uses randomness.

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ED25519_PUBLIC_KEY_VERSION_BYTE = 6 << 3; // 48 ('G' prefix)

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

// CRC16/XModem, as used by the StrKey spec.
function crc16xmodem(bytes) {
  let crc = 0x0000;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

/**
 * Encodes a 32-byte ed25519 public key payload as a checksum-valid "G..."
 * StrKey address. Pure and deterministic: the same `payload` bytes always
 * produce the same address.
 *
 * @param {Uint8Array} payload Exactly 32 bytes.
 * @returns {string}
 */
export function encodeAccountId(payload) {
  const versioned = Buffer.concat([
    Buffer.from([ED25519_PUBLIC_KEY_VERSION_BYTE]),
    Buffer.from(payload),
  ]);
  const crc = crc16xmodem(versioned);
  const crcBuf = Buffer.alloc(2);
  crcBuf.writeUInt16LE(crc, 0);
  return base32Encode(Buffer.concat([versioned, crcBuf]));
}

/**
 * A fixed, deterministic, checksum-valid "G..." address built from a
 * single repeated byte value — e.g. `deterministicAccountId(0x11)` always
 * returns the same address. An obviously-synthetic placeholder pattern,
 * consistent with this project's other fixtures (see
 * `packages/core/test/fixtures/README.md`).
 *
 * @param {number} byteValue A single byte, 0-255.
 * @returns {string}
 */
export function deterministicAccountId(byteValue) {
  return encodeAccountId(new Uint8Array(32).fill(byteValue));
}
