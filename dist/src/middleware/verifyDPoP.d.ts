import { Request, Response, NextFunction } from 'express';
/**
 * verifyDPoP Middleware
 * Enforces Demonstrating Proof-of-Possession (DPoP) on protected routes.
 * Validates the DPoP JWT in the `DPoP` header, cryptographically verifying its signature
 * using the embedded public JWK, and binds it to the access token's registered thumbprint (JKT).
 */
export declare const verifyDPoP: (req: Request, res: Response, next: NextFunction) => Promise<void | Response<any, Record<string, any>>>;
//# sourceMappingURL=verifyDPoP.d.ts.map