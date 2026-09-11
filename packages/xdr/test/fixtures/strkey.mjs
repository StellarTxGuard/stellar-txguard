// Minimal StrKey (ed25519 public key / "G..." address) encoder, used only to
// generate synthetic accounts for test fixtures below. Not part of the
// published package — StellarTxGuard never needs to construct addresses,
// only read them out of already-decoded XDR.
import crypto from "node:crypto";

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

/** Generates a random, structurally-valid (checksum-correct) "G..." address. */
export function randomAccountId() {
  const payload = crypto.randomBytes(32);
  const versioned = Buffer.concat([Buffer.from([ED25519_PUBLIC_KEY_VERSION_BYTE]), payload]);
  const crc = crc16xmodem(versioned);
  const crcBuf = Buffer.alloc(2);
  crcBuf.writeUInt16LE(crc, 0);
  return base32Encode(Buffer.concat([versioned, crcBuf]));
}
