import { Request, Response, NextFunction } from 'express';
export interface AuthRequest extends Request {
    user?: {
        walletAddress: string;
        role: string;
        deviceId?: string;
    };
}
export declare const verifyWalletSignature: (message: string, signature: string, expectedAddress: string) => boolean;
export declare const requireAuth: (req: AuthRequest, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const optionalAuth: (req: AuthRequest, _res: Response, next: NextFunction) => void;
export declare const requireSuperAdmin: (req: AuthRequest, res: Response, next: NextFunction) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const generateToken: (walletAddress: string, role: string, deviceId?: string) => string;
//# sourceMappingURL=auth.d.ts.map