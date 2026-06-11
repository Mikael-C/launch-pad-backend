import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { generateToken, verifyWalletSignature, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { authenticator } from 'otplib';
import { createHash } from 'crypto';
export const authRouter = Router();
// ─── GET /api/auth/nonce ──────────────────────────────────────
authRouter.get('/nonce', asyncHandler(async (req, res) => {
    const { walletAddress } = req.query;
    if (!walletAddress || !walletAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
        return res.status(400).json({ error: 'Valid wallet address required' });
    }
    const nonce = createHash('sha256')
        .update(`${walletAddress}:${Date.now()}:${Math.random()}`)
        .digest('hex')
        .slice(0, 32);
    const message = `Welcome to Launchpad Platform!\n\nSign this message to verify your wallet.\n\nNonce: ${nonce}`;
    // Store nonce for verification
    await prisma.user.upsert({
        where: { walletAddress: walletAddress.toLowerCase() },
        create: { walletAddress: walletAddress.toLowerCase(), nonce },
        update: { nonce }
    });
    res.json({ nonce, message });
}));
// ─── POST /api/auth/login ─────────────────────────────────────
authRouter.post('/login', asyncHandler(async (req, res) => {
    const { walletAddress, signature, totpCode } = req.body;
    if (!walletAddress || !signature) {
        return res.status(400).json({ error: 'walletAddress and signature required' });
    }
    const normalizedAddress = walletAddress.toLowerCase();
    // Get user and their stored nonce
    const user = await prisma.user.findUnique({ where: { walletAddress: normalizedAddress } });
    if (!user || !user.nonce) {
        return res.status(400).json({ error: 'Request a nonce first via GET /api/auth/nonce' });
    }
    const message = `Welcome to Launchpad Platform!\n\nSign this message to verify your wallet.\n\nNonce: ${user.nonce}\nTimestamp:`;
    // Verify wallet signature (partial message match for demo flexibility)
    const isValid = verifyWalletSignature(`Welcome to Launchpad Platform!\n\nSign this message to verify your wallet.\n\nNonce: ${user.nonce}`, signature, walletAddress);
    if (!isValid) {
        return res.status(401).json({ error: 'Invalid signature' });
    }
    // Check TOTP if enabled
    if (user.totpEnabled && user.totpSecret) {
        if (!totpCode) {
            return res.status(200).json({
                requiresTOTP: true,
                message: 'TOTP code required'
            });
        }
        const isValidTOTP = authenticator.verify({
            token: totpCode,
            secret: user.totpSecret
        });
        if (!isValidTOTP) {
            return res.status(401).json({ error: 'Invalid TOTP code' });
        }
    }
    // Invalidate nonce (prevent replay)
    await prisma.user.update({
        where: { walletAddress: normalizedAddress },
        data: { nonce: null }
    });
    // Get role
    const superAdmin = await prisma.superAdmin.findUnique({ where: { walletAddress: normalizedAddress } });
    const role = superAdmin?.active ? 'super_admin' : user.role;
    const token = generateToken(normalizedAddress, role);
    res.json({
        message: 'Login successful',
        token,
        user: {
            walletAddress: normalizedAddress,
            role,
            totpEnabled: user.totpEnabled
        }
    });
}));
// ─── POST /api/auth/totp/setup ────────────────────────────────
authRouter.post('/totp/setup', requireAuth, asyncHandler(async (req, res) => {
    const walletAddress = req.user.walletAddress.toLowerCase();
    const secret = authenticator.generateSecret();
    const otpAuthUrl = authenticator.keyuri(walletAddress, 'LaunchpadPlatform', secret);
    // Temporarily store secret (confirmed on verify)
    await prisma.user.upsert({
        where: { walletAddress },
        create: { walletAddress, totpSecret: secret },
        update: { totpSecret: secret }
    });
    res.json({
        secret,
        otpAuthUrl,
        manualEntryKey: secret,
        issuer: 'LaunchpadPlatform',
        account: walletAddress
    });
}));
// ─── POST /api/auth/totp/verify ───────────────────────────────
authRouter.post('/totp/verify', requireAuth, asyncHandler(async (req, res) => {
    const { totpCode } = req.body;
    const walletAddress = req.user.walletAddress.toLowerCase();
    const user = await prisma.user.findUnique({ where: { walletAddress } });
    if (!user?.totpSecret) {
        return res.status(400).json({ error: 'TOTP not set up' });
    }
    const isValid = authenticator.verify({ token: totpCode, secret: user.totpSecret });
    if (!isValid) {
        return res.status(401).json({ error: 'Invalid TOTP code' });
    }
    await prisma.user.update({
        where: { walletAddress },
        data: { totpEnabled: true }
    });
    res.json({ message: 'TOTP enabled successfully', totpEnabled: true });
}));
// ─── GET /api/auth/me ─────────────────────────────────────────
authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const walletAddress = req.user.walletAddress.toLowerCase();
    const user = await prisma.user.findUnique({
        where: { walletAddress },
        select: { walletAddress: true, role: true, totpEnabled: true, createdAt: true }
    });
    const superAdmin = await prisma.superAdmin.findUnique({
        where: { walletAddress },
        include: { devices: { select: { isMasterDevice: true, trustScore: true } } }
    });
    res.json({
        ...user,
        role: superAdmin?.active ? 'super_admin' : user?.role,
        isSuperAdmin: !!superAdmin?.active,
        hasMasterDevice: superAdmin?.devices.some(d => d.isMasterDevice) || false
    });
}));
//# sourceMappingURL=auth.js.map