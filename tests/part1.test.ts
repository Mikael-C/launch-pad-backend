import request from 'supertest';
import { app } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { generateToken } from '../src/middleware/auth.js';

describe('Part 1 — Launchpad API Tests', () => {
  let authToken: string;
  let adminToken: string;
  let projectId: string;
  const walletAddress = '0xabcdef1234567890abcdef1234567890abcdef12';
  const adminWallet = '0x1111111111111111111111111111111111111111';

  beforeAll(async () => {
    authToken = generateToken(walletAddress, 'user');
    adminToken = generateToken(adminWallet, 'super_admin');

    // Ensure admin exists
    await prisma.superAdmin.upsert({
      where: { walletAddress: adminWallet },
      create: { walletAddress: adminWallet },
      update: {}
    });
    await prisma.user.upsert({
      where: { walletAddress: adminWallet },
      create: { walletAddress: adminWallet, role: 'super_admin' },
      update: {}
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ─── Test: GET /api/projects ────────────────────────────────
  describe('GET /api/projects', () => {
    it('returns a list of projects with pagination', async () => {
      const res = await request(app)
        .get('/api/projects')
        .expect(200);

      expect(res.body).toHaveProperty('projects');
      expect(res.body).toHaveProperty('pagination');
      expect(Array.isArray(res.body.projects)).toBe(true);
    });

    it('filters by status', async () => {
      const res = await request(app)
        .get('/api/projects?status=approved')
        .expect(200);

      expect(res.body.projects.every((p: any) => p.status === 'approved')).toBe(true);
    });

    it('filters by chain', async () => {
      const res = await request(app)
        .get('/api/projects?chain=Hoodi')
        .expect(200);

      res.body.projects.forEach((p: any) => {
        expect(p.chain).toBe('Hoodi');
      });
    });

    it('paginates correctly', async () => {
      const res = await request(app)
        .get('/api/projects?page=1&limit=2')
        .expect(200);

      expect(res.body.projects.length).toBeLessThanOrEqual(2);
      expect(res.body.pagination.limit).toBe(2);
    });
  });

  // ─── Test: POST /api/projects ───────────────────────────────
  describe('POST /api/projects', () => {
    it('creates a project when authenticated', async () => {
      const res = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'TestProject',
          symbol: 'TST',
          description: 'Test project for unit tests',
          category: 'DeFi',
          chain: 'Hoodi',
          tier: 'Silver',
          rate: 10,
          softCap: 10000,
          hardCap: 50000,
          startTime: new Date(Date.now() + 60000).toISOString(),
          endTime: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201);

      expect(res.body.project).toHaveProperty('id');
      expect(res.body.project.status).toBe('pending');
      expect(res.body.project.name).toBe('TestProject');
      projectId = res.body.project.id;
    });

    it('rejects project creation without auth', async () => {
      await request(app)
        .post('/api/projects')
        .send({ name: 'Unauthorized', symbol: 'UNA' })
        .expect(401);
    });

    it('rejects invalid cap values', async () => {
      await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Invalid',
          symbol: 'INV',
          rate: 1,
          softCap: 100000, // softCap > hardCap is invalid
          hardCap: 1000,
          startTime: new Date(Date.now() + 60000).toISOString(),
          endTime: new Date(Date.now() + 86400000).toISOString(),
        })
        .expect(400);
    });
  });

  // ─── Test: Whitelist ─────────────────────────────────────────
  describe('POST /api/whitelist/add', () => {
    it('adds address to whitelist with tier', async () => {
      if (!projectId) return;
      
      const res = await request(app)
        .post('/api/whitelist/add')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          projectId,
          walletAddress,
          tier: 'SILVER'
        })
        .expect(201);

      expect(res.body.entry.tier).toBe('SILVER');
      expect(res.body.entry.maxAllocation).toBe(5000);
    });

    it('rejects duplicate whitelist entries', async () => {
      if (!projectId) return;
      
      await request(app)
        .post('/api/whitelist/add')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ projectId, walletAddress, tier: 'GOLD' })
        .expect(409);
    });

    it('enforces tier allocation limits', async () => {
      if (!projectId) return;
      
      const checkRes = await request(app)
        .get(`/api/whitelist/check?projectId=${projectId}&walletAddress=${walletAddress}`)
        .expect(200);

      expect(checkRes.body.maxAllocation).toBe(5000); // SILVER tier
      expect(checkRes.body.whitelisted).toBe(true);
    });
  });

  // ─── Test: Vesting ───────────────────────────────────────────
  describe('GET /api/vesting/claimable', () => {
    it('returns vesting schedules for authenticated user', async () => {
      const res = await request(app)
        .get('/api/vesting/claimable')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(res.body).toHaveProperty('schedules');
      expect(Array.isArray(res.body.schedules)).toBe(true);
    });

    it('correctly identifies locked tokens before cliff', async () => {
      const schedules = (await request(app)
        .get('/api/vesting/claimable')
        .set('Authorization', `Bearer ${authToken}`)
      ).body.schedules;

      // Tokens in cliff period should be locked
      schedules.forEach((s: any) => {
        if (s.status === 'locked') {
          expect(s.claimableAmount).toBe(0);
        }
      });
    });
  });

  // ─── Test: Health ────────────────────────────────────────────
  describe('GET /health', () => {
    it('returns healthy status', async () => {
      const res = await request(app).get('/health').expect(200);
      expect(res.body.status).toBe('healthy');
    });
  });
});
