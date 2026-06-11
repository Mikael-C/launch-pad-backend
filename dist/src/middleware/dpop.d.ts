import { Request, Response, NextFunction } from 'express';
/**
 * DPoP (Demonstration of Proof-of-Possession) Middleware
 * Validates that access tokens are bound to the device's cryptographic key.
 * Stolen tokens cannot be used on different devices.
 *
 * RFC 9449 implementation
 */
export interface DPoPPayload {
    jti: string;
    htm: string;
    htu: string;
    iat: number;
    ath: string;
}
export declare const validateDPoP: (req: Request, res: Response, next: NextFunction) => Promise<void | Response<any, Record<string, any>>>;
export declare const requireDPoP: (req: Request, res: Response, next: NextFunction) => Promise<void | Response<any, Record<string, any>>>;
//# sourceMappingURL=dpop.d.ts.map