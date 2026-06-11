export const errorHandler = (err, _req, res, _next) => {
    console.error('Error:', err.message);
    const statusCode = err.statusCode || 500;
    const message = process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message;
    // Handle Prisma unique constraint violations
    if (err.code === 'P2002') {
        return res.status(409).json({ error: 'Resource already exists' });
    }
    // Handle Prisma not found
    if (err.code === 'P2025') {
        return res.status(404).json({ error: 'Resource not found' });
    }
    res.status(statusCode).json({
        error: message,
        ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
    });
};
export const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};
//# sourceMappingURL=errorHandler.js.map