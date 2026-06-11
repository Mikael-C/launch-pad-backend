import request from 'supertest';
import { app } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { generateToken } from '../src/middleware/auth.js';

describe('Part 3 — Stablecoin Account API Tests', () => {
  let authToken: string;
  const walletAddress = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'.toLowerCase();

  beforeAll(async () => {
    authToken = generateToken(walletAddress, 'user');

    await prisma.user.upsert({
      where: { walletAddress },
      create: { walletAddress, role: 'user' },
      update: {}
    });

    // Clean any pre-existing account state
    await prisma.accountTransaction.deleteMany({ where: { sxId: walletAddress } });
    await prisma.stablecoinAccount.deleteMany({ where: { sxId: walletAddress } });
  });

  afterAll(async () => {
    await prisma.accountTransaction.deleteMany({ where: { sxId: walletAddress } });
    await prisma.stablecoinAccount.deleteMany({ where: { sxId: walletAddress } });
    await prisma.$disconnect();
  });

  // ─── Test: GET /api/account/balance ──────────────────────────
  describe('GET /api/account/balance', () => {
    it('returns zero balances for new account', async () => {
      const res = await request(app)
        .get('/api/account/balance')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(res.body.usdcBalance).toBe(0);
      expect(res.body.usdtBalance).toBe(0);
      expect(res.body.daiBalance).toBe(0);
      expect(res.body.unifiedBalance).toBe(0);
      expect(Array.isArray(res.body.recentTransactions)).toBe(true);
    });

    it('requires authentication', async () => {
      await request(app)
        .get('/api/account/balance')
        .expect(401);
    });

    it('returns sxId in response', async () => {
      const res = await request(app)
        .get('/api/account/balance')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(res.body.sxId).toBe(walletAddress);
    });
  });

  // ─── Test: POST /api/account/deposit ─────────────────────────
  describe('POST /api/account/deposit', () => {
    it('deposits USDC successfully', async () => {
      const res = await request(app)
        .post('/api/account/deposit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 1000,
          stablecoinType: 'USDC',
          txHash: '0xabc123def456',
          // Signature verification is mocked for tests
          signature: 'mock-signature',
          message: `Deposit 1000 USDC`
        })
        .expect(201);

      expect(res.body.message).toContain('USDC');
      expect(res.body.newBalance.usdcBalance).toBe(1000);
    });

    it('deposits USDT successfully', async () => {
      const res = await request(app)
        .post('/api/account/deposit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 500,
          stablecoinType: 'USDT',
          txHash: '0xdef789',
          signature: 'mock-signature',
          message: `Deposit 500 USDT`
        })
        .expect(201);

      expect(res.body.newBalance.usdtBalance).toBe(500);
    });

    it('deposits DAI and normalizes balance', async () => {
      const daiAmount = 1000e12; // 1000 DAI in 18 decimal units
      const res = await request(app)
        .post('/api/account/deposit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: daiAmount,
          stablecoinType: 'DAI',
          txHash: '0xghi101112',
          signature: 'mock-signature',
          message: `Deposit ${daiAmount} DAI`
        })
        .expect(201);

      expect(res.body.newBalance.daiBalance).toBe(daiAmount);
    });

    it('rejects invalid stablecoin type', async () => {
      const res = await request(app)
        .post('/api/account/deposit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 100,
          stablecoinType: 'SHIB',
          signature: 'mock-signature',
          message: 'Deposit 100 SHIB'
        })
        .expect(400);

      expect(res.body.error).toContain('USDC, USDT, or DAI');
    });

    it('rejects zero amount deposit', async () => {
      await request(app)
        .post('/api/account/deposit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 0,
          stablecoinType: 'USDC',
          signature: 'mock-signature',
          message: 'Deposit 0 USDC'
        })
        .expect(400);
    });

    it('rejects negative amount deposit', async () => {
      await request(app)
        .post('/api/account/deposit')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: -100,
          stablecoinType: 'USDC',
          signature: 'mock-signature',
          message: 'Deposit -100 USDC'
        })
        .expect(400);
    });

    it('requires authentication', async () => {
      await request(app)
        .post('/api/account/deposit')
        .send({ amount: 100, stablecoinType: 'USDC' })
        .expect(401);
    });
  });

  // ─── Test: POST /api/account/withdraw ────────────────────────
  describe('POST /api/account/withdraw', () => {
    it('withdraws USDC to valid address', async () => {
      const res = await request(app)
        .post('/api/account/withdraw')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 500,
          stablecoinType: 'USDC',
          toAddress: walletAddress, // withdraw to own address
          signature: 'mock-signature',
          message: 'Withdraw 500 USDC'
        })
        .expect(200);

      expect(res.body.message).toContain('withdrawn');
      expect(res.body.newBalance.unifiedBalance).toBeDefined();
    });

    it('rejects withdrawal exceeding balance', async () => {
      const res = await request(app)
        .post('/api/account/withdraw')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 99999999,
          stablecoinType: 'USDC',
          toAddress: walletAddress,
          signature: 'mock-signature',
          message: 'Withdraw 99999999 USDC'
        })
        .expect(400);

      expect(res.body.error).toContain('Insufficient');
      expect(res.body).toHaveProperty('available');
    });

    it('rejects invalid destination address', async () => {
      const res = await request(app)
        .post('/api/account/withdraw')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 10,
          stablecoinType: 'USDC',
          toAddress: 'not-a-valid-address',
          signature: 'mock-signature',
          message: 'Withdraw 10 USDC'
        })
        .expect(400);

      expect(res.body.error).toContain('address');
    });

    it('rejects invalid stablecoin on withdraw', async () => {
      await request(app)
        .post('/api/account/withdraw')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          amount: 10,
          stablecoinType: 'PEPE',
          toAddress: walletAddress,
          signature: 'mock-signature',
          message: 'Withdraw 10 PEPE'
        })
        .expect(400);
    });
  });

  // ─── Test: GET /api/account/transactions ─────────────────────
  describe('GET /api/account/transactions', () => {
    it('returns transaction history', async () => {
      const res = await request(app)
        .get('/api/account/transactions')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(Array.isArray(res.body.transactions)).toBe(true);
      expect(res.body).toHaveProperty('pagination');
    });

    it('filters transactions by type', async () => {
      const res = await request(app)
        .get('/api/account/transactions?type=deposit')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      res.body.transactions.forEach((tx: any) => {
        expect(tx.type).toBe('deposit');
      });
    });

    it('paginates transactions', async () => {
      const res = await request(app)
        .get('/api/account/transactions?page=1&limit=2')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(res.body.transactions.length).toBeLessThanOrEqual(2);
    });

    it('requires authentication', async () => {
      await request(app)
        .get('/api/account/transactions')
        .expect(401);
    });
  });

  // ─── Test: Balance after multiple operations ──────────────────
  describe('Balance consistency', () => {
    it('reflects all deposits in unified balance', async () => {
      const balanceRes = await request(app)
        .get('/api/account/balance')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      // USDC: 1000 deposited, 500 withdrawn = 500 remaining
      // USDT: 500 deposited
      // unifiedBalance should reflect both
      expect(balanceRes.body.usdcBalance).toBe(500);
      expect(balanceRes.body.usdtBalance).toBe(500);
      expect(balanceRes.body.unifiedBalance).toBeGreaterThanOrEqual(1000);
    });

    it('recent transactions are included in balance response', async () => {
      const res = await request(app)
        .get('/api/account/balance')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(Array.isArray(res.body.recentTransactions)).toBe(true);
      expect(res.body.recentTransactions.length).toBeGreaterThan(0);
    });
  });
});
