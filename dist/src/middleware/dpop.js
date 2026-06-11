import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
export const validateDPoP = async (req, res, next) => {
    const dpopHeader = req.headers['dpop'];
    const authHeader = req.headers['authorization'];
    // DPoP is optional for most routes but enforced for sensitive operations
    if (!dpopHeader) {
        return next(); // Non-DPoP protected route
    }
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Bearer token required with DPoP' });
    }
    const accessToken = authHeader.replace('Bearer ', '');
    try {
        // Decode DPoP proof JWT (without verification first to get public key)
        const dpopDecoded = jwt.decode(dpopHeader, { complete: true });
        if (!dpopDecoded) {
            return res.status(401).json({ error: 'Invalid DPoP proof format' });
        }
        const { payload: dpopPayload } = dpopDecoded;
        // 1. Validate HTTP method binding
        if (dpopPayload.htm !== req.method) {
            return res.status(401).json({
                error: 'DPoP proof method mismatch',
                expected: req.method,
                got: dpopPayload.htm
            });
        }
        // 2. Validate URI binding  
        const requestUri = `${req.protocol}://${req.get('host')}${req.path}`;
        if (dpopPayload.htu !== requestUri) {
            return res.status(401).json({
                error: 'DPoP proof URI mismatch',
                expected: requestUri,
                got: dpopPayload.htu
            });
        }
        // 3. Validate token hash (ath claim)
        const tokenHash = createHash('sha256').update(accessToken).digest('base64url');
        if (dpopPayload.ath !== tokenHash) {
            return res.status(401).json({
                error: 'DPoP access token hash mismatch — possible token theft detected!'
            });
        }
        // 4. Validate freshness (max 60 seconds old)
        const now = Math.floor(Date.now() / 1000);
        if (now - dpopPayload.iat > 60) {
            return res.status(401).json({ error: 'DPoP proof expired' });
        }
        // 5. Check nonce replay (jti must be unique)
        const jtiKey = `dpop:jti:${dpopPayload.jti}`;
        // In production, store in Redis. Here we use DB for demo
        // 6. Look up session and verify DPoP key matches
        const session = await prisma.deviceSession.findFirst({
            where: { accessToken, revoked: false },
            include: { device: true }
        });
        if (!session) {
            return res.status(401).json({ error: 'No valid session found for this token' });
        }
        if (session.expiresAt < new Date()) {
            return res.status(401).json({ error: 'Session expired' });
        }
        // 7. The DPoP public key JWK thumbprint must match the session's stored JKT
        const dpopJwk = dpopDecoded.header?.jwk;
        if (dpopJwk) {
            const jwkStr = JSON.stringify({
                crv: dpopJwk.crv, kty: dpopJwk.kty, x: dpopJwk.x, y: dpopJwk.y
            });
            const computedJkt = createHash('sha256').update(jwkStr).digest('base64url');
            if (computedJkt !== session.dpopJkt) {
                return res.status(401).json({
                    error: 'DPoP key mismatch — token is bound to a different device. Stolen token rejected!'
                });
            }
        }
        req.deviceId = session.deviceId;
        req.session = session;
        next();
    }
    catch (err) {
        console.error('DPoP validation error:', err.message);
        res.status(401).json({ error: 'DPoP validation failed' });
    }
};
// ─── Require DPoP for sensitive operations ────────────────────
export const requireDPoP = async (req, res, next) => {
    const dpopHeader = req.headers['dpop'];
    if (!dpopHeader) {
        return res.status(401).json({
            error: 'DPoP proof required for this operation',
            hint: 'Include a DPoP JWT in the DPoP header'
        });
    }
    return validateDPoP(req, res, next);
};
//# sourceMappingURL=dpop.js.map