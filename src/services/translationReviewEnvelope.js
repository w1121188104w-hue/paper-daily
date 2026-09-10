import { createCipheriv, createDecipheriv, createHash, createPublicKey, generateKeyPairSync,
  privateDecrypt, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { DeepSeekError } from './deepseekTranslation.js';

const AAD = Buffer.from('paper-daily-translation-review-v1');
const oaep = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };
const fingerprint = (key) => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');

export function reviewPublicKey(encoded) {
  try {
    if (typeof encoded !== 'string' || encoded.length > 2000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa' || ![2048, 3072, 4096].includes(key.asymmetricKeyDetails.modulusLength)) throw new Error();
    return key;
  } catch { throw new DeepSeekError('INVALID_REVIEW_PUBLIC_KEY'); }
}

export function generateReviewKey() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  return { public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), fingerprint: fingerprint(publicKey) };
}

// Only this authenticated ciphertext is uploaded to the PUBLIC repository's Actions artifacts.
export function sealTranslationReview(value, encodedPublicKey) {
  const publicKey = reviewPublicKey(encodedPublicKey), key = randomBytes(32), iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { schema_version: 1, algorithm: 'RSA-OAEP-SHA256+A256GCM', recipient_sha256: fingerprint(publicKey),
      wrapped_key: publicEncrypt({ ...oaep, key: publicKey }, key).toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  } finally { key.fill(0); }
}

export function openTranslationReview(envelope, privateKey) {
  let key;
  try {
    if (envelope?.schema_version !== 1 || envelope.algorithm !== 'RSA-OAEP-SHA256+A256GCM' ||
      envelope.recipient_sha256 !== fingerprint(createPublicKey(privateKey))) throw new Error();
    for (const name of ['wrapped_key', 'iv', 'tag', 'ciphertext']) {
      if (typeof envelope[name] !== 'string' || envelope[name].length > 4000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope[name])) throw new Error();
    }
    key = privateDecrypt({ ...oaep, key: privateKey }, Buffer.from(envelope.wrapped_key, 'base64'));
    const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
    if (key.length !== 32 || iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(AAD); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw new DeepSeekError('REVIEW_DECRYPT_FAILED'); }
  finally { key?.fill(0); }
}
