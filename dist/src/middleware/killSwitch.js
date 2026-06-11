import { prisma } from '../lib/prisma.js';
/**
 * killSwitch Middleware
 * Checks the global killSwitch flag in the database. If active, it blocks incoming
 * API requests with a 503 Service Unavailable response. Administrative and auth-related
 * routes are bypassed to permit recovery.
 */
export const killSwitch = async (req, res, next) => {
    const path = req.path;
    // Allow admins to access admin/auth routes to deactivate the kill switch,
    // let anyone fetch the status, and allow health check.
    if (path.startsWith('/auth') ||
        path.startsWith('/admin') ||
        path === '/admin/kill-switch/status' ||
        path === '/health') {
        return next();
    }
    try {
        const ks = await prisma.killSwitch.findFirst({
            orderBy: { createdAt: 'desc' }
        });
        if (ks?.active) {
            return res.status(503).json({
                error: 'Platform is temporarily unavailable (kill switch active)',
                status: 'paused'
            });
        }
        next();
    }
    catch (err) {
        console.error('KillSwitch middleware error:', err);
        next();
    }
};
//# sourceMappingURL=killSwitch.js.map