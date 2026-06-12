import { Router, Response } from 'express';
import { z } from 'zod';
const nanoid = (size: number) => {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < size; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
};
import { prisma } from '../lib/prisma.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const referralRouter = Router();

const PLATFORMS = ['telegram', 'twitter', 'facebook'] as const;
const REWARD_AMOUNT = 100; // $100 per successful referral
const MIN_DEPOSIT = 500;   // $500 minimum deposit
const EXPIRY_DAYS = 30;

function generateReferralLinks(code: string, platform: string) {
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const refUrl = encodeURIComponent(`${baseUrl}?ref=${code}`);
  
  const links: Record<string, string> = {
    telegram: `https://t.me/launchpad_bot?start=ref_${code}`,
    twitter: `https://twitter.com/intent/tweet?url=${refUrl}&text=Join%20Launchpad%20Platform%20via%20my%20referral%20link!&ref=${code}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${refUrl}&ref=${code}`
  };
  
  return links[platform] || links['twitter'];
}

// ─── GET /api/referral/links ──────────────────────────────────
referralRouter.get('/links', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const referrerId = req.user!.walletAddress.toLowerCase();
  
  const referrals = await prisma.referral.findMany({
    where: { referrerId },
    select: { id: true, code: true, platform: true, clickCount: true, status: true, rewardIssued: true, createdAt: true }
  });

  const links = referrals.map(r => ({
    id: r.id,
    platform: r.platform,
    code: r.code,
    url: generateReferralLinks(r.code, r.platform),
    clickCount: r.clickCount,
    status: r.status,
    reward: r.rewardIssued ? REWARD_AMOUNT : 0,
    createdAt: r.createdAt.toISOString()
  }));

  // If no links exist yet, generate all three
  if (links.length === 0) {
    const created = [];
    for (const platform of PLATFORMS) {
      const code = nanoid(10);
      const ref = await prisma.referral.create({
        data: {
          referrerId,
          code,
          platform,
          expiresAt: new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000)
        }
      });
      created.push({
        id: ref.id,
        platform,
        code: ref.code,
        url: generateReferralLinks(ref.code, platform),
        clickCount: 0,
        status: 'pending',
        reward: 0,
        createdAt: ref.createdAt.toISOString()
      });
    }
    return res.json({ links: created });
  }

  res.json({ links });
}));

// ─── POST /api/referral/links/generate ───────────────────────
referralRouter.post('/links/generate', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { platform } = req.body;
  const referrerId = req.user!.walletAddress.toLowerCase();

  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: 'Platform must be telegram, twitter, or facebook' });
  }

  // Check for existing active link for this platform
  const existing = await prisma.referral.findFirst({
    where: { referrerId, platform, status: { not: 'expired' } }
  });

  if (existing) {
    return res.status(409).json({ 
      error: `Referral link for ${platform} already exists`,
      link: { platform, code: existing.code, url: generateReferralLinks(existing.code, platform) }
    });
  }

  const code = nanoid(10);
  const referral = await prisma.referral.create({
    data: {
      referrerId,
      code,
      platform,
      expiresAt: new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000)
    }
  });

  res.status(201).json({
    platform,
    code: referral.code,
    url: generateReferralLinks(code, platform)
  });
}));

// ─── GET /api/referral/stats ──────────────────────────────────
referralRouter.get('/stats', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const referrerId = req.user!.walletAddress.toLowerCase();
  
  const referrals = await prisma.referral.findMany({
    where: { referrerId },
    include: { clicks: { select: { clickedAt: true } } }
  });

  const total = referrals.length;
  const successful = referrals.filter(r => r.status === 'completed').length;
  const pending = referrals.filter(r => r.status === 'pending').length;
  const expired = referrals.filter(r => r.status === 'expired').length;
  const totalRewards = successful * REWARD_AMOUNT;
  const pendingRewards = pending * REWARD_AMOUNT; // optimistic
  const totalClicks = referrals.reduce((sum, r) => sum + r.clickCount, 0);

  const byPlatform = PLATFORMS.reduce((acc, p) => {
    const platformRefs = referrals.filter(r => r.platform === p);
    acc[p] = {
      total: platformRefs.length,
      successful: platformRefs.filter(r => r.status === 'completed').length,
      pending: platformRefs.filter(r => r.status === 'pending').length,
      clicks: platformRefs.reduce((s, r) => s + r.clickCount, 0)
    };
    return acc;
  }, {} as any);

  res.json({
    total,
    successful,
    pending,
    expired,
    totalRewards,
    pendingRewards,
    totalClicks,
    byPlatform,
    referrals: referrals.map(r => ({
      id: r.id,
      code: r.code,
      platform: r.platform,
      status: r.status,
      reward: r.rewardIssued ? REWARD_AMOUNT : 0,
      clicks: r.clickCount,
      registeredAt: r.registeredAt,
      depositedAt: r.depositedAt,
      expiresAt: r.expiresAt
    }))
  });
}));

// ─── POST /api/referral/track ─────────────────────────────────
referralRouter.post('/track', asyncHandler(async (req, res: Response) => {
  const { code } = req.body;
  
  const referral = await prisma.referral.findUnique({ where: { code } });
  if (!referral) return res.status(404).json({ error: 'Invalid referral code' });
  
  if (referral.expiresAt < new Date()) {
    await prisma.referral.update({ where: { code }, data: { status: 'expired' } });
    return res.status(410).json({ error: 'Referral link expired' });
  }

  // Record click
  const ipHash = req.ip ? Buffer.from(req.ip).toString('base64') : null;
  await prisma.$transaction([
    prisma.referralClick.create({
      data: { referralId: referral.id, ipHash, userAgent: req.headers['user-agent'] }
    }),
    prisma.referral.update({
      where: { id: referral.id },
      data: { clickCount: { increment: 1 } }
    })
  ]);

  res.json({ 
    valid: true, 
    platform: referral.platform,
    referrerId: referral.referrerId 
  });
}));

// ─── GET /api/referral/validate ───────────────────────────────
referralRouter.get('/validate', asyncHandler(async (req, res: Response) => {
  const { code } = req.query;
  
  const referral = await prisma.referral.findUnique({ 
    where: { code: code as string },
    select: { referrerId: true, platform: true, expiresAt: true, status: true }
  });

  if (!referral) return res.json({ valid: false, reason: 'Code not found' });
  if (referral.expiresAt < new Date()) return res.json({ valid: false, reason: 'Expired' });
  if (referral.status === 'completed') return res.json({ valid: false, reason: 'Already used' });

  res.json({ 
    valid: true, 
    referrerId: referral.referrerId,
    platform: referral.platform 
  });
}));

// ─── POST /api/referral/register ─────────────────────────────
// Called when a referred user registers with a referral code
referralRouter.post('/register', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { code } = req.body;
  const referredId = req.user!.walletAddress.toLowerCase();

  const referral = await prisma.referral.findUnique({ where: { code } });
  if (!referral) return res.status(404).json({ error: 'Invalid referral code' });
  if (referral.referrerId === referredId) {
    return res.status(400).json({ error: 'Cannot refer yourself' });
  }
  if (referral.referredId) {
    return res.status(409).json({ error: 'Referral code already used' });
  }

  await prisma.referral.update({
    where: { code },
    data: { referredId, registeredAt: new Date(), status: 'pending' }
  });

  res.json({ message: 'Referral registered. Deposit $500 to unlock rewards.' });
}));

// ─── POST /api/referral/complete ──────────────────────────────
// Called when referred user makes first deposit >= $500
referralRouter.post('/complete', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { code, depositAmount } = req.body;
  const referredId = req.user!.walletAddress.toLowerCase();

  if (depositAmount < MIN_DEPOSIT) {
    return res.status(400).json({ 
      error: `Minimum deposit of $${MIN_DEPOSIT} required to earn referral reward` 
    });
  }

  const referral = await prisma.referral.findFirst({
    where: { code, referredId, status: 'pending' }
  });

  if (!referral) {
    return res.status(404).json({ error: 'No pending referral found for this code' });
  }

  // Mark as completed and issue rewards
  await prisma.referral.update({
    where: { id: referral.id },
    data: {
      status: 'completed',
      rewardIssued: true,
      depositedAt: new Date()
    }
  });

  // In production, credit $100 to both accounts
  // Here we update their stablecoin accounts
  const creditAmount = REWARD_AMOUNT;
  
  for (const userId of [referral.referrerId, referredId]) {
    await prisma.stablecoinAccount.upsert({
      where: { sxId: userId },
      create: { sxId: userId, usdcBalance: creditAmount, unifiedBalance: creditAmount },
      update: { 
        usdcBalance: { increment: creditAmount },
        unifiedBalance: { increment: creditAmount }
      }
    });
    
    await prisma.accountTransaction.create({
      data: {
        sxId: userId,
        type: 'referral_reward',
        amount: creditAmount,
        stablecoinType: 'USDC',
        status: 'confirmed'
      }
    });
  }

  res.json({
    message: `Referral completed! Both referrer and referred user received $${REWARD_AMOUNT} USDC`,
    referrerId: referral.referrerId,
    referredId,
    rewardAmount: REWARD_AMOUNT
  });
}));

// ─── GET /api/referral/simulate ───────────────────────────────
// Demo endpoint to simulate referrals for testing
referralRouter.post('/simulate', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { count = 5, platform = 'twitter' } = req.body;
  const referrerId = req.user!.walletAddress.toLowerCase();

  if (count > 20) return res.status(400).json({ error: 'Max 20 simulations at once' });

  const created = [];
  for (let i = 0; i < count; i++) {
    const code = nanoid(10);
    const referredId = `0x${Array.from({length: 40}, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;
    const isCompleted = i < Math.floor(count * 0.6); // 60% complete

    const referral = await prisma.referral.create({
      data: {
        referrerId,
        referredId,
        code,
        platform: PLATFORMS[i % 3],
        status: isCompleted ? 'completed' : 'pending',
        rewardIssued: isCompleted,
        clickCount: Math.floor(Math.random() * 10) + 1,
        registeredAt: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000),
        depositedAt: isCompleted ? new Date() : null,
        expiresAt: new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000)
      }
    });

    if (isCompleted) {
      await prisma.stablecoinAccount.upsert({
        where: { sxId: referrerId },
        create: { sxId: referrerId, usdcBalance: REWARD_AMOUNT, unifiedBalance: REWARD_AMOUNT },
        update: { 
          usdcBalance: { increment: REWARD_AMOUNT },
          unifiedBalance: { increment: REWARD_AMOUNT }
        }
      });
    }

    created.push({ id: referral.id, platform: referral.platform, status: referral.status });
  }

  res.json({ 
    message: `${count} referrals simulated`,
    referrals: created 
  });
}));
