const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+?";

/**
 * Random password from the CSPRNG for Settings → Users "Generate strong password".
 * Rejection sampling keeps every character equally likely; no look-alikes (0/O, 1/l/I).
 */
export function generatePassword(length = 16): string {
  const n = PASSWORD_CHARS.length;
  const limit = 256 - (256 % n);
  let out = "";
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < length) out += PASSWORD_CHARS[b % n];
    }
  }
  return out;
}
