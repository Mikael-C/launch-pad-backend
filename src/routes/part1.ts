import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireSuperAdmin, AuthRequest, verifyWalletSignature } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const part1Router = Router();

// ─── Validation Schemas ───────────────────────────────────────
const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100),
  symbol: z.string().min(1).max(10),
  description: z.string().optional(),
  logoUrl: z.string().url().optional(),
  website: z.string().url().optional(),
  category: z.string().default('DeFi'),
  chain: z.string().default('Hoodi'),
  tier: z.string().default('Standard'),
  rate: z.number().positive(),
  softCap: z.number().positive(),
  hardCap: z.number().positive(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  tokenAddress: z.string().optional(),
});

const WhitelistSchema = z.object({
  projectId: z.string(),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  tier: z.enum(['BRONZE', 'SILVER', 'GOLD', 'PLATINUM']),
});

const InvestSchema = z.object({
  projectId: z.string(),
  amount: z.number().positive(),
  stablecoin: z.enum(['USDC', 'USDT', 'DAI']),
  txHash: z.string().optional(),
  signature: z.string(),
  message: z.string(),
});

const TIER_LIMITS: Record<string, number> = {
  BRONZE: 1000,
  SILVER: 5000,
  GOLD: 25000,
  PLATINUM: 100000,
};

// ─── GET /api/projects ────────────────────────────────────────
part1Router.get('/projects', asyncHandler(async (req, res: Response) => {
  const { 
    status, chain, category, tier, 
    page = '1', limit = '10', 
    sortBy = 'createdAt', order = 'desc' 
  } = req.query;

  const where: any = {};
  if (status) where.status = status;
  if (chain) where.chain = chain;
  if (category) where.category = category;
  if (tier) where.tier = tier;

  const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
  const take = Math.min(parseInt(limit as string), 50);

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      skip,
      take,
      orderBy: { [sortBy as string]: order },
      include: {
        stats: true,
        _count: { select: { investments: true, whitelistEntries: true } }
      }
    }),
    prisma.project.count({ where })
  ]);

  res.json({
    projects,
    pagination: {
      page: parseInt(page as string),
      limit: take,
      total,
      pages: Math.ceil(total / take)
    }
  });
}));

// ─── GET /api/projects/:id ────────────────────────────────────
part1Router.get('/projects/:id', asyncHandler(async (req, res: Response) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: {
      stats: true,
      _count: { select: { investments: true, whitelistEntries: true, comments: true } }
    }
  });

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  res.json(project);
}));

// ─── POST /api/projects ───────────────────────────────────────
part1Router.post('/projects', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const data = CreateProjectSchema.parse(req.body);
  
  if (new Date(data.startTime) >= new Date(data.endTime)) {
    return res.status(400).json({ error: 'Start time must be before end time' });
  }
  
  if (data.softCap >= data.hardCap) {
    return res.status(400).json({ error: 'Soft cap must be less than hard cap' });
  }

  const project = await prisma.project.create({
    data: {
      ...data,
      startTime: new Date(data.startTime),
      endTime: new Date(data.endTime),
      status: 'pending',
      stats: {
        create: { tvl: 0, investorCount: 0 }
      }
    },
    include: { stats: true }
  });

  res.status(201).json({ 
    message: 'Project created and pending approval',
    project 
  });
}));

// ─── PUT /api/projects/:id/approve ───────────────────────────
part1Router.put('/projects/:id/approve', requireAuth, requireSuperAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { action, adminNotes, operationId } = req.body;
  
  if (!['approved', 'rejected'].includes(action)) {
    return res.status(400).json({ error: 'Action must be approved or rejected' });
  }

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.status !== 'pending') {
    return res.status(400).json({ error: 'Project is not pending approval' });
  }

  const updated = await prisma.project.update({
    where: { id },
    data: { status: action, adminNotes }
  });

  res.json({ 
    message: `Project ${action}`, 
    project: updated 
  });
}));

// ─── POST /api/whitelist/add ──────────────────────────────────
part1Router.post('/whitelist/add', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const data = WhitelistSchema.parse(req.body);
  
  const project = await prisma.project.findUnique({ where: { id: data.projectId } });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const existing = await prisma.whitelistEntry.findUnique({
    where: { 
      projectId_walletAddress: { 
        projectId: data.projectId, 
        walletAddress: data.walletAddress.toLowerCase() 
      }
    }
  });

  if (existing) {
    return res.status(409).json({ error: 'Address already whitelisted for this project' });
  }

  const maxAllocation = TIER_LIMITS[data.tier];
  const entry = await prisma.whitelistEntry.create({
    data: {
      projectId: data.projectId,
      walletAddress: data.walletAddress.toLowerCase(),
      tier: data.tier,
      maxAllocation
    }
  });

  res.status(201).json({ 
    message: 'Address whitelisted successfully',
    entry 
  });
}));

// ─── GET /api/whitelist/check ────────────────────────────────
part1Router.get('/whitelist/check', asyncHandler(async (req, res: Response) => {
  const { projectId, walletAddress } = req.query;
  
  if (!projectId || !walletAddress) {
    return res.status(400).json({ error: 'projectId and walletAddress required' });
  }

  const entry = await prisma.whitelistEntry.findUnique({
    where: {
      projectId_walletAddress: {
        projectId: projectId as string,
        walletAddress: (walletAddress as string).toLowerCase()
      }
    }
  });

  const invested = entry ? await prisma.investment.aggregate({
    where: { userId: (walletAddress as string).toLowerCase(), projectId: projectId as string },
    _sum: { amount: true }
  }) : null;

  res.json({
    whitelisted: !!entry,
    tier: entry?.tier || null,
    maxAllocation: entry?.maxAllocation || 0,
    totalInvested: invested?._sum?.amount || 0,
    remainingAllocation: entry ? (entry.maxAllocation - (invested?._sum?.amount || 0)) : 0
  });
}));

// ─── POST /api/invest ─────────────────────────────────────────
part1Router.post('/invest', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const data = InvestSchema.parse(req.body);
  const walletAddress = req.user!.walletAddress.toLowerCase();

  // Verify wallet signature
  const isValid = verifyWalletSignature(data.message, data.signature, walletAddress);
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid wallet signature' });
  }

  // Check project exists and is active
  const project = await prisma.project.findUnique({ where: { id: data.projectId } });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.status !== 'approved' && project.status !== 'active') {
    return res.status(400).json({ error: 'Project is not accepting investments' });
  }

  const now = new Date();
  if (now < project.startTime || now > project.endTime) {
    return res.status(400).json({ error: 'Sale is not active' });
  }

  // Check whitelist
  const whitelistEntry = await prisma.whitelistEntry.findUnique({
    where: {
      projectId_walletAddress: {
        projectId: data.projectId,
        walletAddress
      }
    }
  });

  if (!whitelistEntry) {
    return res.status(403).json({ error: 'Address not whitelisted for this project' });
  }

  // Check tier limit
  const totalInvested = await prisma.investment.aggregate({
    where: { userId: walletAddress, projectId: data.projectId },
    _sum: { amount: true }
  });

  const alreadyInvested = totalInvested._sum.amount || 0;
  if (alreadyInvested + data.amount > whitelistEntry.maxAllocation) {
    return res.status(400).json({ 
      error: 'Investment exceeds tier allocation limit',
      maxAllocation: whitelistEntry.maxAllocation,
      alreadyInvested,
      remaining: whitelistEntry.maxAllocation - alreadyInvested
    });
  }

  // Check hard cap
  const totalRaised = await prisma.investment.aggregate({
    where: { projectId: data.projectId },
    _sum: { amount: true }
  });
  const raised = totalRaised._sum.amount || 0;
  if (raised + data.amount > project.hardCap) {
    return res.status(400).json({ error: 'Investment exceeds hard cap' });
  }

  // Create investment and vesting schedule
  const [investment] = await prisma.$transaction([
    prisma.investment.create({
      data: {
        userId: walletAddress,
        projectId: data.projectId,
        amount: data.amount,
        stablecoin: data.stablecoin,
        txHash: data.txHash
      }
    }),
    prisma.projectStats.upsert({
      where: { projectId: data.projectId },
      create: { projectId: data.projectId, tvl: data.amount, investorCount: 1 },
      update: { 
        tvl: { increment: data.amount },
        investorCount: { increment: 1 }
      }
    })
  ]);

  // Create or update vesting schedule
  const cliffDuration = 90 * 24 * 60 * 60 * 1000; // 90 days
  const vestingDuration = 365 * 24 * 60 * 60 * 1000; // 1 year
  const cliffEnd = new Date(project.endTime.getTime() + cliffDuration);
  const vestingEnd = new Date(cliffEnd.getTime() + vestingDuration);
  const tokensAllocated = data.amount * project.rate;

  await prisma.vestingSchedule.upsert({
    where: { userId_projectId: { userId: walletAddress, projectId: data.projectId } },
    create: {
      userId: walletAddress,
      projectId: data.projectId,
      totalAmount: tokensAllocated,
      cliffEnd,
      vestingEnd
    },
    update: {
      totalAmount: { increment: tokensAllocated }
    }
  });

  res.status(201).json({
    message: 'Investment recorded successfully',
    investment,
    tokensAllocated
  });
}));

// ─── GET /api/vesting/claimable ───────────────────────────────
part1Router.get('/vesting/claimable', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const walletAddress = req.user!.walletAddress.toLowerCase();
  const { projectId } = req.query;

  const where: any = { userId: walletAddress };
  if (projectId) where.projectId = projectId as string;

  const schedules = await prisma.vestingSchedule.findMany({
    where,
    include: { project: { select: { name: true, symbol: true } } }
  });

  const now = new Date();
  const claimable = schedules.map(s => {
    let claimableAmount = 0;
    
    if (now >= s.cliffEnd) {
      if (now >= s.vestingEnd) {
        claimableAmount = s.totalAmount - s.claimedAmount;
      } else {
        const elapsed = now.getTime() - s.cliffEnd.getTime();
        const totalVesting = s.vestingEnd.getTime() - s.cliffEnd.getTime();
        const vested = (s.totalAmount * elapsed) / totalVesting;
        claimableAmount = Math.max(0, vested - s.claimedAmount);
      }
    }

    return {
      id: s.id,
      projectId: s.projectId,
      projectName: s.project.name,
      projectSymbol: s.project.symbol,
      totalAmount: s.totalAmount,
      claimedAmount: s.claimedAmount,
      claimableAmount,
      cliffEnd: s.cliffEnd,
      vestingEnd: s.vestingEnd,
      status: now < s.cliffEnd ? 'locked' : now >= s.vestingEnd ? 'fully_vested' : 'vesting'
    };
  });

  res.json({ schedules: claimable });
}));

// ─── POST /api/vesting/claim ─────────────────────────────────
part1Router.post('/vesting/claim', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, signature, message } = req.body;
  const walletAddress = req.user!.walletAddress.toLowerCase();

  if (!verifyWalletSignature(message, signature, walletAddress)) {
    return res.status(401).json({ error: 'Invalid wallet signature' });
  }

  const schedule = await prisma.vestingSchedule.findUnique({
    where: { userId_projectId: { userId: walletAddress, projectId } }
  });

  if (!schedule) return res.status(404).json({ error: 'No vesting schedule found' });

  const now = new Date();
  if (now < schedule.cliffEnd) {
    return res.status(400).json({ 
      error: 'Cliff period not ended',
      cliffEnd: schedule.cliffEnd 
    });
  }

  let claimableAmount = 0;
  if (now >= schedule.vestingEnd) {
    claimableAmount = schedule.totalAmount - schedule.claimedAmount;
  } else {
    const elapsed = now.getTime() - schedule.cliffEnd.getTime();
    const totalVesting = schedule.vestingEnd.getTime() - schedule.cliffEnd.getTime();
    const vested = (schedule.totalAmount * elapsed) / totalVesting;
    claimableAmount = Math.max(0, vested - schedule.claimedAmount);
  }

  if (claimableAmount <= 0) {
    return res.status(400).json({ error: 'No tokens available to claim' });
  }

  const updated = await prisma.vestingSchedule.update({
    where: { userId_projectId: { userId: walletAddress, projectId } },
    data: { claimedAmount: { increment: claimableAmount } }
  });

  res.json({
    message: `${claimableAmount.toFixed(4)} tokens claimed successfully`,
    claimedAmount: claimableAmount,
    totalClaimed: updated.claimedAmount,
    remaining: updated.totalAmount - updated.claimedAmount
  });
}));

// ─── GET /api/investments ─────────────────────────────────────
part1Router.get('/investments', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const walletAddress = req.user!.walletAddress.toLowerCase();
  
  const investments = await prisma.investment.findMany({
    where: { userId: walletAddress },
    include: { project: { select: { name: true, symbol: true, status: true, endTime: true } } },
    orderBy: { createdAt: 'desc' }
  });

  res.json({ investments });
}));
