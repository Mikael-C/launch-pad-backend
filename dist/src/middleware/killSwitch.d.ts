import { Request, Response, NextFunction } from 'express';
/**
 * killSwitch Middleware
 * Checks the global killSwitch flag in the database. If active, it blocks incoming
 * API requests with a 503 Service Unavailable response. Administrative and auth-related
 * routes are bypassed to permit recovery.
 */
export declare const killSwitch: (req: Request, res: Response, next: NextFunction) => Promise<void | Response<any, Record<string, any>>>;
//# sourceMappingURL=killSwitch.d.ts.map