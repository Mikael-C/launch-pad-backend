import { Request, Response, NextFunction } from 'express';
import * as jose from 'jose';
import { createHash } from 'crypto';
import { prisma } from '../lib/prisma.js';

function computeJwkThumbprint(jwk: any): string {
  // Canonical JWK format
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(canonical).digest('base64url');
}

/**
 * verifyDPoP Middleware
 * Enforces Demonstrating Proof-of-Possession (DPoP) on protected routes.
 * Validates the DPoP JWT in the `DPoP` header, cryptographically verifying its signature
 * using the embedded public JWK, and binds it to the access token's registered thumbprint (JKT).
 */
export const verifyDPoP = async (req: Request, res: Response, next: NextFunction) => {
  // Bypass registration route since it establishes the DPoP binding
  if (req.path === '/register' || req.path === '/register/') {
    return next();
  }

  const dpopHeader = req.headers['dpop'];
  if (!dpopHeader || typeof dpopHeader !== 'string') {
    return res.status(401).json({ error: 'DPoP proof required' });
  }

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Authentication token required' });
  }

  try {
    // 1. Find the device session associated with this token
    const session = await prisma.deviceSession.findFirst({
      where: { accessToken: token, revoked: false }
    });

    if (!session) {
      return res.status(401).json({ error: 'Invalid or revoked device session' });
    }

    // 2. Decode the DPoP JWT protected header to get the client public key
    const protectedHeader = jose.decodeProtectedHeader(dpopHeader);
    const jwk = protectedHeader.jwk;
    if (!jwk) {
      return res.status(401).json({ error: 'DPoP proof missing JWK in header' });
    }

    // 3. Cryptographically verify the DPoP thumbprint matches the session JKT
    const calculatedJkt = computeJwkThumbprint(jwk);
    if (calculatedJkt !== session.dpopJkt) {
      return res.status(401).json({ error: 'DPoP thumbprint mismatch (Stolen token rejected)' });
    }

    // 4. Verify the DPoP JWT signature using the public key
    const publicKey = await jose.importJWK(jwk, protectedHeader.alg || 'ES256');
    const { payload } = await jose.jwtVerify(dpopHeader, publicKey, {
      algorithms: [protectedHeader.alg || 'ES256']
    });

    // 5. Verify claims
    const expectedHtm = req.method;
    const expectedHtuPath = req.originalUrl.split('?')[0];
    const requestHost = req.get('host') || 'localhost:3001';
    const protocol = req.protocol || 'http';
    const expectedHtu = `${protocol}://${requestHost}${expectedHtuPath}`;

    if (payload.htm !== expectedHtm) {
      return res.status(401).json({ error: 'DPoP htm claim mismatch' });
    }

    const payloadHtu = payload.htu as string;
    if (!payloadHtu || (!payloadHtu.endsWith(expectedHtuPath) && !expectedHtu.endsWith(payloadHtu))) {
      return res.status(401).json({ error: 'DPoP htu claim mismatch' });
    }

    if (!payload.jti) {
      return res.status(401).json({ error: 'DPoP nonce (jti) missing' });
    }

    next();
  } catch (err: any) {
    console.error('DPoP validation error:', err);
    return res.status(401).json({ error: `DPoP verification failed: ${err.message}` });
  }
};
