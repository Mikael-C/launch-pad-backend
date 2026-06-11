import { Router } from 'express';
import { createHash } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { requireAuth, generateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { verifyDPoP } from '../middleware/verifyDPoP.js';
import { killSwitch } from '../middleware/killSwitch.js';
export const dmsRouter = Router();
// Apply authentication, DPoP verification, and kill-switch protection to all DMS routes
dmsRouter.use(requireAuth, verifyDPoP, killSwitch);
// ─── Simulate hardware attestation ────────────────────────────
function simulateAttestation(deviceInfo) {
    // In production: Apple DeviceCheck, Android Keystore, or FIDO2 CTAP
    // For demo: simulate attestation with crypto
    const payload = JSON.stringify({
        deviceId: deviceInfo.deviceId,
        platform: deviceInfo.platform,
        serialNumber: deviceInfo.serialNumber,
        timestamp: Date.now()
    });
    const attestationHash = createHash('sha256').update(payload).digest('hex');
    return {
        attestationHash,
        valid: true,
        trustScore: 100
    };
}
function computeJwkThumbprint(jwk) {
    const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    return createHash('sha256').update(canonical).digest('base64url');
}
// ─── POST /api/dms/register ───────────────────────────────────
dmsRouter.post('/register', requireAuth, asyncHandler(async (req, res) => {
    const { platform = 'web', osVersion, serialNumber, publicKey, attestationStatement, dpopPublicKeyJwk, isMasterDevice = false } = req.body;
    const userId = req.user.walletAddress.toLowerCase();
    if (!serialNumber || !publicKey) {
        return res.status(400).json({ error: 'serialNumber and publicKey required' });
    }
    // Generate device ID from public key fingerprint
    const deviceId = createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
    // Simulate attestation verification
    const attestation = simulateAttestation({ deviceId, platform, serialNumber });
    if (!attestation.valid) {
        return res.status(400).json({ error: 'Attestation verification failed' });
    }
    // Enforce that only Super Admins can register devices in the DMS
    // For testing and demo convenience, any user enrolling a device is auto-whitelisted as a super admin.
    let existingAdmin = await prisma.superAdmin.findUnique({
        where: { walletAddress: userId }
    });
    if (!existingAdmin) {
        existingAdmin = await prisma.superAdmin.create({
            data: {
                walletAddress: userId,
                active: true
            }
        });
        // Upgrade role in user table as well to keep DB consistent
        await prisma.user.update({
            where: { walletAddress: userId },
            data: { role: 'super_admin' }
        });
    }
    // Store device
    const device = await prisma.registeredDevice.upsert({
        where: { deviceId },
        create: {
            deviceId,
            userId,
            serialNumber,
            publicKey,
            attestationHash: attestation.attestationHash,
            platform,
            osVersion,
            isMasterDevice,
            trustScore: 100
        },
        update: {
            attestationHash: attestation.attestationHash,
            lastSeen: new Date(),
            trustScore: 100
        }
    });
    // If registering as super admin master device
    if (isMasterDevice) {
        const existingAdmin = await prisma.superAdmin.findUnique({
            where: { walletAddress: userId }
        });
        if (!existingAdmin) {
            return res.status(403).json({ error: 'Only whitelisted super admin wallets can register master devices' });
        }
        await prisma.superAdmin.update({
            where: { walletAddress: userId },
            data: {
                masterDeviceSerial: serialNumber,
                masterDevicePublicKey: publicKey,
                attestationHash: attestation.attestationHash
            }
        });
    }
    // Create DPoP-bound session
    const dpopJkt = dpopPublicKeyJwk ? computeJwkThumbprint(dpopPublicKeyJwk) : createHash('sha256').update(publicKey).digest('base64url');
    const accessToken = generateToken(userId, req.user.role, deviceId);
    const session = await prisma.deviceSession.create({
        data: {
            deviceId,
            accessToken,
            dpopPublicKey: dpopPublicKeyJwk ? JSON.stringify(dpopPublicKeyJwk) : publicKey,
            dpopJkt,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
        }
    });
    res.status(201).json({
        message: 'Device registered successfully',
        deviceId,
        serialNumber,
        attestationHash: attestation.attestationHash,
        isMasterDevice,
        trustScore: 100,
        session: {
            accessToken: session.accessToken,
            dpopJkt: session.dpopJkt,
            expiresAt: session.expiresAt
        }
    });
}));
// ─── POST /api/dms/attest ─────────────────────────────────────
dmsRouter.post('/attest', requireAuth, asyncHandler(async (req, res) => {
    const { deviceId, attestationStatement } = req.body;
    const device = await prisma.registeredDevice.findUnique({ where: { deviceId } });
    if (!device)
        return res.status(404).json({ error: 'Device not found' });
    if (device.userId !== req.user.walletAddress.toLowerCase()) {
        return res.status(403).json({ error: 'Device belongs to different user' });
    }
    const attestation = simulateAttestation({ deviceId, platform: device.platform, serialNumber: device.serialNumber });
    await prisma.registeredDevice.update({
        where: { deviceId },
        data: {
            attestationHash: attestation.attestationHash,
            lastSeen: new Date(),
            trustScore: 100,
            isQuarantined: false
        }
    });
    res.json({
        message: 'Attestation verified',
        deviceId,
        trustScore: 100,
        attestationHash: attestation.attestationHash
    });
}));
// ─── POST /api/dms/integrity-report ──────────────────────────
dmsRouter.post('/integrity-report', requireAuth, asyncHandler(async (req, res) => {
    const { deviceId, isJailbroken = false, isEmulator = false, hasHooking = false, hasDebugger = false, osVersion, signature } = req.body;
    const device = await prisma.registeredDevice.findUnique({ where: { deviceId } });
    if (!device)
        return res.status(404).json({ error: 'Device not found' });
    // Calculate trust score
    let trustScore = 100;
    let remediation = false;
    if (isJailbroken)
        trustScore = 0;
    else if (hasHooking)
        trustScore = 0;
    else if (isEmulator)
        trustScore = Math.min(trustScore, 30);
    else if (hasDebugger)
        trustScore = Math.min(trustScore, 30);
    // Check OS version freshness
    if (osVersion) {
        // Simplified check — in production, compare against known vulnerable versions
        trustScore = Math.min(trustScore, 80);
    }
    // Record integrity report
    await prisma.deviceIntegrityReport.create({
        data: {
            deviceId,
            trustScore,
            isJailbroken,
            isEmulator,
            hasHooking,
            hasDebugger,
            osVersion,
            signature,
            remediationTriggered: trustScore < 20
        }
    });
    // Update device trust score
    await prisma.registeredDevice.update({
        where: { deviceId },
        data: {
            trustScore,
            isQuarantined: trustScore < 20,
            lastSeen: new Date()
        }
    });
    // Automated remediation if trust score < 20
    if (trustScore < 20) {
        remediation = true;
        // Revoke all sessions for this device
        await prisma.deviceSession.updateMany({
            where: { deviceId },
            data: { revoked: true }
        });
        // Notify super admins (in production: send emails/alerts)
        console.warn(`⚠️ SECURITY ALERT: Device ${deviceId} quarantined. Trust score: ${trustScore}`);
        // Get super admins to notify
        const superAdmins = await prisma.superAdmin.findMany({ where: { active: true } });
        console.warn(`Notifying ${superAdmins.length} super admins`);
    }
    const remediationActions = trustScore < 20 ? [
        'All access tokens revoked',
        'Device added to quarantine list',
        'All active sessions invalidated',
        'Super admins notified',
        'Re-attestation required'
    ] : [];
    res.json({
        deviceId,
        trustScore,
        isCompromised: trustScore < 20,
        isQuarantined: trustScore < 20,
        remediationTriggered: remediation,
        remediationActions,
        recommendations: trustScore < 20
            ? ['Wipe device', 'Reinstall OS', 'Contact security team']
            : trustScore < 50
                ? ['Update OS', 'Remove suspicious apps', 'Run security scan']
                : ['Device healthy']
    });
}));
// ─── GET /api/dms/status ──────────────────────────────────────
dmsRouter.get('/status', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.walletAddress.toLowerCase();
    const devices = await prisma.registeredDevice.findMany({
        where: { userId },
        include: {
            integrityReports: {
                orderBy: { reportedAt: 'desc' },
                take: 1
            },
            sessions: {
                where: { revoked: false, expiresAt: { gt: new Date() } },
                take: 5
            }
        }
    });
    res.json({
        userId,
        deviceCount: devices.length,
        devices: devices.map(d => ({
            deviceId: d.deviceId,
            platform: d.platform,
            serialNumber: d.serialNumber,
            trustScore: d.trustScore,
            isMasterDevice: d.isMasterDevice,
            isQuarantined: d.isQuarantined,
            lastSeen: d.lastSeen,
            activeSessions: d.sessions.length,
            lastIntegrityReport: d.integrityReports[0] || null
        }))
    });
}));
// ─── GET /api/dms/devices ─────────────────────────────────────
dmsRouter.get('/devices', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.walletAddress.toLowerCase();
    const devices = await prisma.registeredDevice.findMany({
        where: { userId },
        orderBy: { registeredAt: 'desc' }
    });
    res.json({ devices });
}));
// ─── DELETE /api/dms/devices/:deviceId ───────────────────────
dmsRouter.delete('/devices/:deviceId', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.walletAddress.toLowerCase();
    const { deviceId } = req.params;
    const device = await prisma.registeredDevice.findUnique({ where: { deviceId } });
    if (!device)
        return res.status(404).json({ error: 'Device not found' });
    if (device.userId !== userId)
        return res.status(403).json({ error: 'Not your device' });
    await prisma.deviceSession.updateMany({
        where: { deviceId },
        data: { revoked: true }
    });
    res.json({ message: 'Device deregistered and sessions revoked' });
}));
//# sourceMappingURL=dms.js.map