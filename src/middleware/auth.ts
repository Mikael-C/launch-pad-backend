import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import { prisma } from '../lib/prisma.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';

export interface AuthRequest extends Request {
  user?: {
    walletAddress: string;
    role: string;
    deviceId?: string;
  };
}

// ─── Wallet Signature Verification ────────────────────────────
export const verifyWalletSignature = (
  message: string,
  signature: string,
  expectedAddress: string
): boolean => {
  // In test environment, bypass signature check
  if (process.env.NODE_ENV === 'test') return true;
  try {
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
};

// ─── JWT Auth Middleware ───────────────────────────────────────
export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    req.user = {
      walletAddress: payload.walletAddress,
      role: payload.role,
      deviceId: payload.deviceId
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// ─── Optional Auth (doesn't fail if no token) ─────────────────
export const optionalAuth = (req: AuthRequest, _res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      req.user = { walletAddress: payload.walletAddress, role: payload.role };
    } catch {
      // ignore
    }
  }
  next();
};

// ─── Super Admin Check ─────────────────────────────────────────
export const requireSuperAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  const admin = await prisma.superAdmin.findUnique({
    where: { walletAddress: req.user.walletAddress }
  });
  
  if (!admin || !admin.active) {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  
  next();
};

// ─── JWT Token Generation ──────────────────────────────────────
export const generateToken = (walletAddress: string, role: string, deviceId?: string): string => {
  return jwt.sign(
    { walletAddress, role, deviceId },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
};
