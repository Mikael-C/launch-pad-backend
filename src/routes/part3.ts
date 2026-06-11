import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, AuthRequest, verifyWalletSignature } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const part3Router = Router();

const STABLECOINS = ['USDC', 'USDT', 'DAI'] as const;

// ─── GET /api/account/balance ────────────────────────────────
part3Router.get('/balance', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const sxId = req.user!.walletAddress.toLowerCase();

  const account = await prisma.stablecoinAccount.findUnique({
    where: { sxId },
    include: {
      transactions: {
        orderBy: { createdAt: 'desc' },
        take: 10
      }
    }
  });

  if (!account) {
    return res.json({
      sxId,
      usdcBalance: 0,
      usdtBalance: 0,
      daiBalance: 0,
      unifiedBalance: 0,
      recentTransactions: []
    });
  }

  // Normalize DAI (18 decimals) to 6 decimals for display
  const daiNormalized = account.daiBalance / 1e12;
  const unifiedBalance = account.usdcBalance + account.usdtBalance + daiNormalized;

  res.json({
    sxId,
    usdcBalance: account.usdcBalance,
    usdtBalance: account.usdtBalance,
    daiBalance: account.daiBalance,
    daiNormalized,
    unifiedBalance,
    recentTransactions: account.transactions
  });
}));

// ─── POST /api/account/deposit ────────────────────────────────
part3Router.post('/deposit', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { amount, stablecoinType, txHash, signature, message } = req.body;
  const sxId = req.user!.walletAddress.toLowerCase();

  if (!STABLECOINS.includes(stablecoinType)) {
    return res.status(400).json({ error: 'Invalid stablecoin. Must be USDC, USDT, or DAI' });
  }

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  // Verify wallet signature
  if (!verifyWalletSignature(message, signature, sxId)) {
    return res.status(401).json({ error: 'Invalid wallet signature' });
  }

  // Update balances
  const balanceUpdate: any = {};
  const stablecoinKey = stablecoinType.toLowerCase() + 'Balance';
  balanceUpdate[stablecoinKey] = { increment: amount };

  const account = await prisma.stablecoinAccount.upsert({
    where: { sxId },
    create: {
      sxId,
      [stablecoinKey.replace('Balance', 'Balance').replace('usdc', 'usdc').replace('usdt', 'usdt').replace('dai', 'dai')]: amount,
      unifiedBalance: stablecoinType === 'DAI' ? amount / 1e12 : amount
    },
    update: {
      [stablecoinKey]: { increment: amount },
      unifiedBalance: { increment: stablecoinType === 'DAI' ? amount / 1e12 : amount }
    }
  });

  // Record transaction
  const tx = await prisma.accountTransaction.create({
    data: {
      sxId,
      type: 'deposit',
      amount,
      stablecoinType,
      txHash,
      signature,
      status: txHash ? 'confirmed' : 'pending'
    }
  });

  res.status(201).json({
    message: `${amount} ${stablecoinType} deposited successfully`,
    transaction: tx,
    newBalance: {
      usdcBalance: account.usdcBalance,
      usdtBalance: account.usdtBalance,
      daiBalance: account.daiBalance,
      unifiedBalance: account.unifiedBalance
    }
  });
}));

// ─── POST /api/account/withdraw ───────────────────────────────
part3Router.post('/withdraw', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { amount, stablecoinType, toAddress, signature, message } = req.body;
  const sxId = req.user!.walletAddress.toLowerCase();

  if (!STABLECOINS.includes(stablecoinType)) {
    return res.status(400).json({ error: 'Invalid stablecoin' });
  }

  if (!verifyWalletSignature(message, signature, sxId)) {
    return res.status(401).json({ error: 'Invalid wallet signature' });
  }

  // Allow withdrawal to own address for demo purposes
  if (!toAddress || !toAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
    return res.status(400).json({ error: 'Invalid destination address' });
  }

  // Validate destination wallet is whitelisted
  // In production, check against on-chain SecurityController whitelist
  // For demo, check if it's the user's own address or an admin-whitelisted address
  const isWhitelisted = toAddress.toLowerCase() === sxId || 
    process.env[`WHITELISTED_${toAddress.toUpperCase()}`] === 'true';

  if (!isWhitelisted) {
    return res.status(403).json({ error: 'Destination address is not whitelisted' });
  }

  const stablecoinKey = stablecoinType.toLowerCase() + 'Balance';

  try {
    const { updated, tx } = await prisma.$transaction(async (prismaTx) => {
      const account = await prismaTx.stablecoinAccount.findUnique({ where: { sxId } });
      if (!account) throw new Error('No account found');

      const currentBalance = (account as any)[stablecoinKey] || 0;
      if (currentBalance < amount) {
        throw { message: 'Insufficient balance', available: currentBalance };
      }

      const updatedAcc = await prismaTx.stablecoinAccount.update({
        where: { sxId },
        data: {
          [stablecoinKey]: { decrement: amount },
          unifiedBalance: { decrement: stablecoinType === 'DAI' ? amount / 1e12 : amount }
        }
      });

      const txRecord = await prismaTx.accountTransaction.create({
        data: {
          sxId,
          type: 'withdraw',
          amount,
          stablecoinType,
          toAddress,
          signature,
          status: 'confirmed'
        }
      });

      return { updated: updatedAcc, tx: txRecord };
    });

    res.json({
      message: `${amount} ${stablecoinType} withdrawn to ${toAddress}`,
      transaction: tx,
      newBalance: {
        unifiedBalance: updated.unifiedBalance
      }
    });
  } catch (err: any) {
    if (err.available !== undefined) {
      return res.status(400).json({ error: err.message, available: err.available });
    }
    res.status(400).json({ error: err.message || 'Withdrawal failed' });
  }
}));

// ─── POST /api/account/transfer ──────────────────────────────
part3Router.post('/transfer', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { amount, stablecoinType, projectId, signature, message } = req.body;
  const sxId = req.user!.walletAddress.toLowerCase();

  if (!verifyWalletSignature(message, signature, sxId)) {
    return res.status(401).json({ error: 'Invalid wallet signature' });
  }

  const stablecoinKey = stablecoinType.toLowerCase() + 'Balance';

  try {
    const { updated, tx } = await prisma.$transaction(async (prismaTx) => {
      const account = await prismaTx.stablecoinAccount.findUnique({ where: { sxId } });
      if (!account) throw new Error('No account found');

      const currentBalance = (account as any)[stablecoinKey] || 0;
      if (currentBalance < amount) {
        throw new Error('Insufficient balance');
      }

      // Verify project exists
      if (projectId) {
        const project = await prismaTx.project.findUnique({ where: { id: projectId } });
        if (!project) throw new Error('Project not found');
      }

      const updatedAcc = await prismaTx.stablecoinAccount.update({
        where: { sxId },
        data: {
          [stablecoinKey]: { decrement: amount },
          unifiedBalance: { decrement: stablecoinType === 'DAI' ? amount / 1e12 : amount }
        }
      });

      const txRecord = await prismaTx.accountTransaction.create({
        data: {
          sxId,
          type: 'invest',
          amount,
          stablecoinType,
          projectId,
          signature,
          status: 'confirmed'
        }
      });

      return { updated: updatedAcc, tx: txRecord };
    });

    res.json({
      message: `${amount} ${stablecoinType} transferred to project`,
      transaction: tx,
      newBalance: { unifiedBalance: updated.unifiedBalance }
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Transfer failed' });
  }
}));

// ─── GET /api/account/transactions ───────────────────────────
part3Router.get('/transactions', requireAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const sxId = req.user!.walletAddress.toLowerCase();
  const { page = '1', limit = '20', type } = req.query;

  const where: any = { sxId };
  if (type) where.type = type;

  const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

  const [transactions, total] = await Promise.all([
    prisma.accountTransaction.findMany({
      where,
      skip,
      take: parseInt(limit as string),
      orderBy: { createdAt: 'desc' }
    }),
    prisma.accountTransaction.count({ where })
  ]);

  res.json({ 
    transactions, 
    pagination: { page: parseInt(page as string), total } 
  });
}));
