import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth, verifyWalletSignature } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
export const part2Router = Router();
// ─── GET /api/marketplace/projects ───────────────────────────
part2Router.get('/projects', asyncHandler(async (req, res) => {
    const { chain, category, tier, status = 'approved', sortBy = 'tvl', order = 'desc', page = '1', limit = '12', search } = req.query;
    const where = {};
    if (status)
        where.status = { in: status === 'all' ? ['approved', 'active', 'completed'] : [status] };
    if (chain)
        where.chain = chain;
    if (category)
        where.category = category;
    if (tier)
        where.tier = tier;
    if (search) {
        where.OR = [
            { name: { contains: search } },
            { symbol: { contains: search } },
            { description: { contains: search } }
        ];
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = Math.min(parseInt(limit), 50);
    // Sort by stats fields requires a different approach
    const orderBy = sortBy === 'tvl'
        ? { stats: { tvl: order } }
        : sortBy === 'investors'
            ? { stats: { investorCount: order } }
            : sortBy === 'ending'
                ? { endTime: order }
                : { createdAt: order };
    const [projects, total] = await Promise.all([
        prisma.project.findMany({
            where,
            skip,
            take,
            orderBy,
            include: {
                stats: true,
                _count: { select: { investments: true, watchlistEntries: true, upvotes: true } }
            }
        }),
        prisma.project.count({ where })
    ]);
    // Calculate time remaining
    const enriched = projects.map(p => ({
        ...p,
        timeRemaining: Math.max(0, new Date(p.endTime).getTime() - Date.now()),
        fundingPercent: p.stats ? Math.min(100, (p.stats.tvl / p.hardCap) * 100) : 0
    }));
    res.json({
        projects: enriched,
        pagination: {
            page: parseInt(page),
            limit: take,
            total,
            pages: Math.ceil(total / take)
        },
        filters: {
            chains: await prisma.project.findMany({ distinct: ['chain'], select: { chain: true } }).then(r => r.map(x => x.chain)),
            categories: await prisma.project.findMany({ distinct: ['category'], select: { category: true } }).then(r => r.map(x => x.category)),
        }
    });
}));
// ─── GET /api/marketplace/projects/:id/stats ─────────────────
part2Router.get('/projects/:id/stats', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [project, stats, investments] = await Promise.all([
        prisma.project.findUnique({ where: { id } }),
        prisma.projectStats.findUnique({ where: { projectId: id } }),
        prisma.investment.findMany({
            where: { projectId: id },
            orderBy: { createdAt: 'asc' },
            select: { amount: true, createdAt: true }
        })
    ]);
    if (!project)
        return res.status(404).json({ error: 'Project not found' });
    // Build TVL chart data (daily snapshots)
    const tvlChart = investments.reduce((acc, inv) => {
        const date = inv.createdAt.toISOString().split('T')[0];
        const last = acc[acc.length - 1];
        if (last && last.date === date) {
            last.tvl += inv.amount;
            last.investors++;
        }
        else {
            acc.push({
                date,
                tvl: (last?.tvl || 0) + inv.amount,
                investors: (last?.investors || 0) + 1
            });
        }
        return acc;
    }, []);
    res.json({
        projectId: id,
        name: project.name,
        tvl: stats?.tvl || 0,
        investorCount: stats?.investorCount || 0,
        timeRemaining: Math.max(0, project.endTime.getTime() - Date.now()),
        fundingPercent: stats ? Math.min(100, (stats.tvl / project.hardCap) * 100) : 0,
        softCapReached: (stats?.tvl || 0) >= project.softCap,
        hardCapReached: (stats?.tvl || 0) >= project.hardCap,
        tvlChart,
        lastUpdated: stats?.updatedAt
    });
}));
// ─── GET /api/marketplace/watchlist ──────────────────────────
part2Router.get('/watchlist', requireAuth, asyncHandler(async (req, res) => {
    const sxId = req.user.walletAddress.toLowerCase();
    const watchlist = await prisma.watchlist.findMany({
        where: { sxId },
        include: {
            project: {
                include: { stats: true }
            }
        },
        orderBy: { addedAt: 'desc' }
    });
    res.json({ watchlist: watchlist.map(w => ({ ...w.project, addedAt: w.addedAt })) });
}));
// ─── POST /api/marketplace/watchlist ─────────────────────────
part2Router.post('/watchlist', requireAuth, asyncHandler(async (req, res) => {
    const { projectId } = req.body;
    const sxId = req.user.walletAddress.toLowerCase();
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project)
        return res.status(404).json({ error: 'Project not found' });
    try {
        const entry = await prisma.watchlist.create({
            data: { sxId, projectId }
        });
        res.status(201).json({ message: 'Added to watchlist', entry });
    }
    catch (err) {
        if (err.code === 'P2002') {
            return res.status(409).json({ error: 'Already in watchlist' });
        }
        throw err;
    }
}));
// ─── DELETE /api/marketplace/watchlist/:projectId ─────────────
part2Router.delete('/watchlist/:projectId', requireAuth, asyncHandler(async (req, res) => {
    const sxId = req.user.walletAddress.toLowerCase();
    const { projectId } = req.params;
    const deleted = await prisma.watchlist.deleteMany({
        where: { sxId, projectId }
    });
    if (deleted.count === 0) {
        return res.status(404).json({ error: 'Not in watchlist' });
    }
    res.status(204).send();
}));
// ─── GET /api/marketplace/comments ───────────────────────────
part2Router.get('/comments', asyncHandler(async (req, res) => {
    const { projectId, page = '1', limit = '20' } = req.query;
    if (!projectId)
        return res.status(400).json({ error: 'projectId required' });
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const comments = await prisma.comment.findMany({
        where: { projectId: projectId },
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' }
    });
    res.json({ comments });
}));
// ─── POST /api/marketplace/comments ──────────────────────────
part2Router.post('/comments', requireAuth, asyncHandler(async (req, res) => {
    const { projectId, content, signature, message } = req.body;
    const sxId = req.user.walletAddress.toLowerCase();
    if (!content || content.trim().length < 1) {
        return res.status(400).json({ error: 'Comment cannot be empty' });
    }
    if (content.length > 1000) {
        return res.status(400).json({ error: 'Comment too long (max 1000 chars)' });
    }
    // Verify wallet signature for comment
    if (!verifyWalletSignature(message, signature, sxId)) {
        return res.status(401).json({ error: 'Invalid wallet signature' });
    }
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project)
        return res.status(404).json({ error: 'Project not found' });
    // Sanitize content (prevent XSS)
    const sanitized = content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const comment = await prisma.comment.create({
        data: { projectId, sxId, content: sanitized, signature }
    });
    res.status(201).json({ message: 'Comment posted', comment });
}));
// ─── POST /api/marketplace/upvote ────────────────────────────
part2Router.post('/upvote', requireAuth, asyncHandler(async (req, res) => {
    const { projectId } = req.body;
    const sxId = req.user.walletAddress.toLowerCase();
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project)
        return res.status(404).json({ error: 'Project not found' });
    try {
        await prisma.upvote.create({ data: { projectId, sxId } });
        const count = await prisma.upvote.count({ where: { projectId } });
        res.status(201).json({ message: 'Upvoted', upvotes: count });
    }
    catch (err) {
        if (err.code === 'P2002') {
            // Remove upvote (toggle)
            await prisma.upvote.deleteMany({ where: { projectId, sxId } });
            const count = await prisma.upvote.count({ where: { projectId } });
            return res.json({ message: 'Upvote removed', upvotes: count });
        }
        throw err;
    }
}));
//# sourceMappingURL=part2.js.map