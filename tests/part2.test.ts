import request from 'supertest';
import { app } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { generateToken } from '../src/middleware/auth.js';

describe('Part 2 — Marketplace API Tests', () => {
  let authToken: string;
  let authToken2: string;
  let projectId: string;
  const walletAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'.toLowerCase();
  const walletAddress2 = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'.toLowerCase();

  beforeAll(async () => {
    authToken = generateToken(walletAddress, 'user');
    authToken2 = generateToken(walletAddress2, 'user');

    // Ensure users exist
    await prisma.user.upsert({
      where: { walletAddress },
      create: { walletAddress, role: 'user' },
      update: {}
    });
    await prisma.user.upsert({
      where: { walletAddress: walletAddress2 },
      create: { walletAddress: walletAddress2, role: 'user' },
      update: {}
    });

    // Create a test project to interact with
    const project = await prisma.project.create({
      data: {
        name: 'MarketplaceTestProject',
        symbol: 'MTP',
        description: 'Test project for marketplace tests',
        category: 'DeFi',
        chain: 'Hoodi',
        tier: 'Gold',
        rate: 10,
        softCap: 10000,
        hardCap: 50000,
        startTime: new Date(Date.now() + 60000),
        endTime: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status: 'approved'
      }
    });
    projectId = project.id;

    // Create project stats
    await prisma.projectStats.upsert({
      where: { projectId },
      create: { projectId, tvl: 0, investorCount: 0 },
      update: {}
    });
  });

  afterAll(async () => {
    // Clean up test data
    await prisma.comment.deleteMany({ where: { projectId } });
    await prisma.upvote.deleteMany({ where: { projectId } });
    await prisma.watchlist.deleteMany({ where: { projectId } });
    await prisma.projectStats.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } });
    await prisma.$disconnect();
  });

  // ─── Test: GET /api/marketplace/projects ────────────────────
  describe('GET /api/marketplace/projects', () => {
    it('returns paginated approved projects', async () => {
      const res = await request(app)
        .get('/api/marketplace/projects')
        .expect(200);

      expect(res.body).toHaveProperty('projects');
      expect(res.body).toHaveProperty('pagination');
      expect(Array.isArray(res.body.projects)).toBe(true);
    });

    it('filters by chain', async () => {
      const res = await request(app)
        .get('/api/marketplace/projects?chain=Hoodi')
        .expect(200);

      res.body.projects.forEach((p: any) => {
        expect(p.chain).toBe('Hoodi');
      });
    });

    it('filters by category', async () => {
      const res = await request(app)
        .get('/api/marketplace/projects?category=DeFi')
        .expect(200);

      res.body.projects.forEach((p: any) => {
        expect(p.category).toBe('DeFi');
      });
    });

    it('searches by project name', async () => {
      const res = await request(app)
        .get('/api/marketplace/projects?search=MarketplaceTest')
        .expect(200);

      expect(res.body.projects.some((p: any) => p.name.includes('MarketplaceTest'))).toBe(true);
    });

    it('paginates correctly', async () => {
      const res = await request(app)
        .get('/api/marketplace/projects?page=1&limit=5')
        .expect(200);

      expect(res.body.projects.length).toBeLessThanOrEqual(5);
      expect(res.body.pagination.limit).toBe(5);
    });

    it('returns filter options (chains and categories)', async () => {
      const res = await request(app)
        .get('/api/marketplace/projects')
        .expect(200);

      expect(res.body).toHaveProperty('filters');
      expect(res.body.filters).toHaveProperty('chains');
      expect(res.body.filters).toHaveProperty('categories');
    });
  });

  // ─── Test: GET /api/marketplace/projects/:id/stats ──────────
  describe('GET /api/marketplace/projects/:id/stats', () => {
    it('returns project stats', async () => {
      const res = await request(app)
        .get(`/api/marketplace/projects/${projectId}/stats`)
        .expect(200);

      expect(res.body).toHaveProperty('projectId', projectId);
      expect(res.body).toHaveProperty('tvl');
      expect(res.body).toHaveProperty('investorCount');
      expect(res.body).toHaveProperty('fundingPercent');
      expect(res.body).toHaveProperty('softCapReached');
      expect(res.body).toHaveProperty('hardCapReached');
    });

    it('returns 404 for non-existent project', async () => {
      await request(app)
        .get('/api/marketplace/projects/nonexistent-id/stats')
        .expect(404);
    });

    it('returns tvlChart array', async () => {
      const res = await request(app)
        .get(`/api/marketplace/projects/${projectId}/stats`)
        .expect(200);

      expect(Array.isArray(res.body.tvlChart)).toBe(true);
    });
  });

  // ─── Test: Watchlist ─────────────────────────────────────────
  describe('Watchlist', () => {
    it('adds project to watchlist', async () => {
      const res = await request(app)
        .post('/api/marketplace/watchlist')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ projectId })
        .expect(201);

      expect(res.body.message).toContain('watchlist');
    });

    it('rejects duplicate watchlist entry', async () => {
      await request(app)
        .post('/api/marketplace/watchlist')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ projectId })
        .expect(409);
    });

    it('gets watchlist for authenticated user', async () => {
      const res = await request(app)
        .get('/api/marketplace/watchlist')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(Array.isArray(res.body.watchlist)).toBe(true);
      expect(res.body.watchlist.some((p: any) => p.id === projectId)).toBe(true);
    });

    it('requires authentication to view watchlist', async () => {
      await request(app)
        .get('/api/marketplace/watchlist')
        .expect(401);
    });

    it('removes project from watchlist', async () => {
      await request(app)
        .delete(`/api/marketplace/watchlist/${projectId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(204);
    });

    it('returns 404 when removing non-watchlisted project', async () => {
      await request(app)
        .delete(`/api/marketplace/watchlist/${projectId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);
    });
  });

  // ─── Test: Upvotes ────────────────────────────────────────────
  describe('Upvotes', () => {
    it('upvotes a project', async () => {
      const res = await request(app)
        .post('/api/marketplace/upvote')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ projectId })
        .expect(201);

      expect(res.body.upvotes).toBeGreaterThanOrEqual(1);
    });

    it('toggles upvote (removes on second call)', async () => {
      const res = await request(app)
        .post('/api/marketplace/upvote')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ projectId })
        .expect(200);

      expect(res.body.message).toContain('removed');
    });

    it('requires authentication to upvote', async () => {
      await request(app)
        .post('/api/marketplace/upvote')
        .send({ projectId })
        .expect(401);
    });

    it('different users can upvote the same project', async () => {
      // user1 upvotes
      const res1 = await request(app)
        .post('/api/marketplace/upvote')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ projectId })
        .expect(201);

      // user2 upvotes
      const res2 = await request(app)
        .post('/api/marketplace/upvote')
        .set('Authorization', `Bearer ${authToken2}`)
        .send({ projectId })
        .expect(201);

      expect(res2.body.upvotes).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Test: Comments ───────────────────────────────────────────
  describe('Comments', () => {
    it('returns empty comments list for project', async () => {
      const res = await request(app)
        .get(`/api/marketplace/comments?projectId=${projectId}`)
        .expect(200);

      expect(Array.isArray(res.body.comments)).toBe(true);
    });

    it('returns 400 without projectId', async () => {
      await request(app)
        .get('/api/marketplace/comments')
        .expect(400);
    });

    // Note: POST /comments requires wallet signature verification
    // These tests verify the endpoint rejects invalid/missing signatures
    it('rejects comment without auth', async () => {
      await request(app)
        .post('/api/marketplace/comments')
        .send({ projectId, content: 'Test comment' })
        .expect(401);
    });

    it('posts a comment when authenticated (signature bypassed in test mode)', async () => {
      const res = await request(app)
        .post('/api/marketplace/comments')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          projectId,
          content: 'Integration test comment',
          signature: 'test-mode-sig',
          message: 'sign this message'
        })
        .expect(201);

      expect(res.body.comment).toHaveProperty('id');
      expect(res.body.comment.content).toBe('Integration test comment');
    });

    it('rejects empty comment content', async () => {
      await request(app)
        .post('/api/marketplace/comments')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          projectId,
          content: '',
          signature: 'test-sig',
          message: 'test'
        })
        .expect(400);
    });
  });
});
