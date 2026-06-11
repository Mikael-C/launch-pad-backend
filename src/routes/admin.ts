import { Router, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireSuperAdmin, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const adminRouter = Router();

// ─── GET /api/admin/super-admins ─────────────────────────────
adminRouter.get('/super-admins', requireAuth, requireSuperAdmin, asyncHandler(async (_req, res: Response) => {
  const admins = await prisma.superAdmin.findMany({
    where: { active: true },
    select: {
      walletAddress: true,
      masterDeviceSerial: true,
      attestationHash: true,
      registeredAt: true,
      devices: { select: { deviceId: true, platform: true, trustScore: true } }
    }
  });

  res.json({ admins, count: admins.length });
}));

// ─── POST /api/admin/super-admins ────────────────────────────
adminRouter.post('/super-admins', requireAuth, requireSuperAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { walletAddress } = req.body;

  const existing = await prisma.superAdmin.findUnique({ where: { walletAddress } });
  if (existing) return res.status(409).json({ error: 'Admin already exists' });

  const admin = await prisma.superAdmin.create({
    data: { walletAddress: walletAddress.toLowerCase() }
  });

  res.status(201).json({ message: 'Super admin registered', admin });
}));

// ─── POST /api/admin/operations/propose ──────────────────────
adminRouter.post('/operations/propose', requireAuth, requireSuperAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { operationType, description, payload, projectId } = req.body;
  const proposedBy = req.user!.walletAddress.toLowerCase();

  const VALID_OPERATIONS = [
    'CREATE_SALE', 'APPROVE_PROJECT', 'FUND_WITHDRAWAL',
    'KILL_SWITCH_DEACTIVATE', 'WHITELIST_WALLET',
    'USER_ROLE_ELEVATION', 'DATABASE_MIGRATION'
  ];

  if (!VALID_OPERATIONS.includes(operationType)) {
    return res.status(400).json({ error: 'Invalid operation type' });
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  // Proposer counts as first approver
  const admin = await prisma.superAdmin.findUnique({ where: { walletAddress: proposedBy } });
  const signatures = JSON.stringify([{
    adminWallet: proposedBy,
    deviceSerial: admin?.masterDeviceSerial || 'unknown',
    timestamp: new Date().toISOString()
  }]);

  const operation = await prisma.pendingOperation.create({
    data: {
      operationType,
      description,
      payload: payload ? JSON.stringify(payload) : null,
      nonce,
      status: 'pending',
      approvalCount: 1,
      requiredApprovals: operationType === 'KILL_SWITCH_ACTIVATE' ? 1 : 3,
      signatures,
      projectId,
      proposedBy,
      expiresAt
    }
  });

  res.status(201).json({
    message: 'Operation proposed (1/3 approvals)',
    operation: {
      id: operation.id,
      operationType,
      nonce,
      approvalCount: 1,
      requiredApprovals: operation.requiredApprovals,
      expiresAt,
      status: 'pending'
    }
  });
}));

// ─── POST /api/admin/operations/:id/approve ──────────────────
adminRouter.post('/operations/:id/approve', requireAuth, requireSuperAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { deviceSerial, signature } = req.body;
  const adminWallet = req.user!.walletAddress.toLowerCase();

  const operation = await prisma.pendingOperation.findUnique({ where: { id } });
  if (!operation) return res.status(404).json({ error: 'Operation not found' });
  if (operation.status !== 'pending') return res.status(400).json({ error: `Operation is ${operation.status}` });
  if (operation.expiresAt < new Date()) {
    await prisma.pendingOperation.update({ where: { id }, data: { status: 'expired' } });
    return res.status(400).json({ error: 'Operation expired' });
  }

  // Check not already approved by this admin
  const existingSigs = JSON.parse(operation.signatures);
  if (existingSigs.some((s: any) => s.adminWallet === adminWallet)) {
    return res.status(409).json({ error: 'Already approved by this admin' });
  }

  // Verify device serial matches registered Master Device
  const admin = await prisma.superAdmin.findUnique({ where: { walletAddress: adminWallet } });
  if (admin?.masterDeviceSerial && deviceSerial && admin.masterDeviceSerial !== deviceSerial) {
    return res.status(403).json({ error: 'Device serial does not match registered Master Device' });
  }

  const newSigs = [...existingSigs, {
    adminWallet,
    deviceSerial: deviceSerial || admin?.masterDeviceSerial || 'unknown',
    signature,
    timestamp: new Date().toISOString()
  }];

  const newApprovalCount = operation.approvalCount + 1;
  const newStatus = newApprovalCount >= operation.requiredApprovals ? 'approved' : 'pending';

  const updated = await prisma.pendingOperation.update({
    where: { id },
    data: {
      approvalCount: newApprovalCount,
      signatures: JSON.stringify(newSigs),
      status: newStatus
    }
  });

  res.json({
    message: `Approval recorded (${newApprovalCount}/${operation.requiredApprovals})`,
    operation: {
      id: updated.id,
      approvalCount: newApprovalCount,
      requiredApprovals: operation.requiredApprovals,
      status: newStatus,
      readyToExecute: newStatus === 'approved'
    }
  });
}));

// ─── POST /api/admin/operations/:id/execute ──────────────────
adminRouter.post('/operations/:id/execute', requireAuth, requireSuperAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  const operation = await prisma.pendingOperation.findUnique({ where: { id } });
  if (!operation) return res.status(404).json({ error: 'Operation not found' });
  if (operation.status !== 'approved') {
    return res.status(400).json({ 
      error: `Cannot execute: operation is ${operation.status}. Need ${operation.requiredApprovals} approvals.`,
      approvalCount: operation.approvalCount,
      required: operation.requiredApprovals
    });
  }
  if (operation.expiresAt < new Date()) {
    return res.status(400).json({ error: 'Operation expired' });
  }

  // Execute based on operation type
  let result: any = {};
  const payload = operation.payload ? JSON.parse(operation.payload) : {};

  switch (operation.operationType) {
    case 'APPROVE_PROJECT':
      if (operation.projectId) {
        await prisma.project.update({
          where: { id: operation.projectId },
          data: { status: 'approved' }
        });
        result = { projectId: operation.projectId, status: 'approved' };
      }
      break;
      
    case 'FUND_WITHDRAWAL':
      result = { 
        message: 'Fund withdrawal authorized — execute on-chain via contract',
        amount: payload.amount,
        recipient: payload.recipient
      };
      break;

    case 'KILL_SWITCH_DEACTIVATE':
      await prisma.killSwitch.updateMany({
        where: { active: true },
        data: { active: false, deactivatedAt: new Date() }
      });
      result = { killSwitchActive: false };
      break;
      
    default:
      result = { message: 'Operation executed', payload };
  }

  await prisma.pendingOperation.update({
    where: { id },
    data: { status: 'executed', executedAt: new Date() }
  });

  res.json({
    message: 'Operation executed successfully',
    operationType: operation.operationType,
    result
  });
}));

// ─── GET /api/admin/operations ───────────────────────────────
adminRouter.get('/operations', requireAuth, requireSuperAdmin, asyncHandler(async (_req, res: Response) => {
  const operations = await prisma.pendingOperation.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { project: { select: { name: true, symbol: true } } }
  });

  res.json({ operations });
}));

// ─── POST /api/admin/kill-switch/activate ────────────────────
adminRouter.post('/kill-switch/activate', requireAuth, requireSuperAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { reason } = req.body;
  const activatedBy = req.user!.walletAddress.toLowerCase();

  // Kill switch activation only requires 1 super admin
  const killSwitch = await prisma.killSwitch.create({
    data: {
      active: true,
      activatedBy,
      activatedAt: new Date(),
      reason
    }
  });

  // Revoke ALL device sessions
  await prisma.deviceSession.updateMany({
    where: { revoked: false },
    data: { revoked: true }
  });

  console.warn(`🚨 KILL SWITCH ACTIVATED by ${activatedBy}. Reason: ${reason}`);

  res.json({
    message: 'Kill switch activated — platform paused',
    killSwitchId: killSwitch.id,
    activatedBy,
    activatedAt: killSwitch.activatedAt,
    reason,
    sessionsRevoked: true
  });
}));

// ─── POST /api/admin/kill-switch/deactivate ──────────────────
// Requires 3-of-3 approval first
adminRouter.post('/kill-switch/deactivate', requireAuth, requireSuperAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { operationId } = req.body;
  
  // Verify the 3-of-3 operation is approved
  const operation = await prisma.pendingOperation.findUnique({ where: { id: operationId } });
  if (!operation || operation.operationType !== 'KILL_SWITCH_DEACTIVATE') {
    return res.status(400).json({ error: 'Valid KILL_SWITCH_DEACTIVATE operation required' });
  }
  if (operation.approvalCount < 3) {
    return res.status(403).json({ 
      error: '3-of-3 approval required to deactivate kill switch',
      currentApprovals: operation.approvalCount
    });
  }

  await prisma.killSwitch.updateMany({
    where: { active: true },
    data: { active: false, deactivatedAt: new Date() }
  });

  await prisma.pendingOperation.update({
    where: { id: operationId },
    data: { status: 'executed', executedAt: new Date() }
  });

  res.json({
    message: 'Kill switch deactivated — platform restored',
    deactivatedAt: new Date()
  });
}));

// ─── GET /api/admin/kill-switch/status ───────────────────────
adminRouter.get('/kill-switch/status', asyncHandler(async (_req, res: Response) => {
  const killSwitch = await prisma.killSwitch.findFirst({
    orderBy: { createdAt: 'desc' }
  });

  res.json({
    active: killSwitch?.active || false,
    activatedBy: killSwitch?.activatedBy,
    activatedAt: killSwitch?.activatedAt,
    reason: killSwitch?.reason
  });
}));

// ─── GET /api/admin/contracts ─────────────────────────────────
adminRouter.get('/contracts', asyncHandler(async (_req, res: Response) => {
  res.json({
    baseSepolia: {
      saleFactory: process.env.SALE_FACTORY_BASE_SEPOLIA || '',
    },
    hoodi: {
      saleFactory: process.env.SALE_FACTORY_HOODI || '',
      stablecoinAccount: process.env.STABLECOIN_ACCOUNT_HOODI || '',
      securityController: process.env.SECURITY_CONTROLLER_HOODI || ''
    }
  });
}));

// ─── GET /api/admin/dashboard ─────────────────────────────────
adminRouter.get('/dashboard', requireAuth, requireSuperAdmin, asyncHandler(async (_req, res: Response) => {
  const [
    totalProjects,
    pendingProjects,
    totalInvestments,
    totalUsers,
    deviceStats,
    killSwitch,
    pendingOps
  ] = await Promise.all([
    prisma.project.count(),
    prisma.project.count({ where: { status: 'pending' } }),
    prisma.investment.aggregate({ _sum: { amount: true } }),
    prisma.user.count(),
    prisma.registeredDevice.groupBy({ by: ['platform'], _count: true }),
    prisma.killSwitch.findFirst({ orderBy: { createdAt: 'desc' } }),
    prisma.pendingOperation.count({ where: { status: 'pending' } })
  ]);

  res.json({
    platform: {
      totalProjects,
      pendingProjects,
      totalInvested: totalInvestments._sum.amount || 0,
      totalUsers
    },
    security: {
      killSwitchActive: killSwitch?.active || false,
      pendingOperations: pendingOps,
      devicesByPlatform: deviceStats
    }
  });
}));
