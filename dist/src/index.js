import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { prisma } from './lib/prisma.js';
import { part1Router } from './routes/part1.js';
import { part2Router } from './routes/part2.js';
import { referralRouter } from './routes/referral.js';
import { part3Router } from './routes/part3.js';
import { dmsRouter } from './routes/dms.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { setupWebSocket } from './websocket/referralSocket.js';
import { errorHandler } from './middleware/errorHandler.js';
import { killSwitch } from './middleware/killSwitch.js';
const app = express();
const httpServer = createServer(app);
const PORT = parseInt(process.env.PORT || '3001');
// ─── WebSocket Setup ─────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
setupWebSocket(wss);
// ─── Global Middleware ────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            connectSrc: ["'self'", "wss:", "https:"],
        }
    },
    crossOriginEmbedderPolicy: false
}));
app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175', process.env.CORS_ORIGIN || ''],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'DPoP', 'X-Device-ID']
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// ─── Rate Limiting ────────────────────────────────────────────
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many authentication attempts.' }
});
const investLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { error: 'Too many investment requests.' }
});
app.use('/api/', generalLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/invest', investLimiter);
app.use('/api/account/invest', investLimiter);
// ─── Health Check ─────────────────────────────────────────────
app.get('/health', async (_req, res) => {
    try {
        await prisma.$queryRaw `SELECT 1`;
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '1.0.0',
            parts: ['Part1-Launchpad', 'Part2-Marketplace', 'Part3-Stablecoin', 'Part4-DMS']
        });
    }
    catch (err) {
        res.status(503).json({ status: 'unhealthy', error: 'Database connection failed' });
    }
});
// ─── API Routes ───────────────────────────────────────────────
app.use('/api', killSwitch);
app.use('/api/auth', authRouter);
app.use('/api', part1Router);
app.use('/api/marketplace', part2Router);
app.use('/api/referral', referralRouter);
app.use('/api/account', part3Router);
app.use('/api/dms', dmsRouter);
app.use('/api/admin', adminRouter);
// ─── SSE Endpoint for Referral Dashboard ─────────────────────
app.get('/api/referral/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    const walletAddress = req.query.wallet;
    if (!walletAddress) {
        res.write('data: {"error":"wallet required"}\n\n');
        res.end();
        return;
    }
    // Send initial data
    const sendUpdate = async () => {
        try {
            const referrals = await prisma.referral.findMany({
                where: { referrerId: walletAddress }
            });
            const total = referrals.length;
            const successful = referrals.filter((r) => r.status === 'completed').length;
            const pending = referrals.filter((r) => r.status === 'pending').length;
            const rewards = successful * 100;
            const byPlatform = {
                telegram: referrals.filter((r) => r.platform === 'telegram').length,
                twitter: referrals.filter((r) => r.platform === 'twitter').length,
                facebook: referrals.filter((r) => r.platform === 'facebook').length,
            };
            res.write(`data: ${JSON.stringify({ total, successful, pending, rewards, byPlatform })}\n\n`);
        }
        catch (err) {
            res.write('data: {"error":"fetch failed"}\n\n');
        }
    };
    sendUpdate();
    const interval = setInterval(sendUpdate, 3000);
    req.on('close', () => clearInterval(interval));
});
// ─── Error Handler ────────────────────────────────────────────
app.use(errorHandler);
// ─── Start Server ─────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
    httpServer.listen(PORT, () => {
        console.log(`\n🚀 Launchpad API running on http://localhost:${PORT}`);
        console.log(`📡 WebSocket ready at ws://localhost:${PORT}/ws`);
        console.log(`💚 Health: http://localhost:${PORT}/health\n`);
    });
}
export { app, httpServer, wss };
//# sourceMappingURL=index.js.map