import 'dotenv/config';
declare const app: import("express-serve-static-core").Express;
declare const httpServer: import("http").Server<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>;
declare const wss: import("ws").Server<typeof import("ws").default, typeof import("http").IncomingMessage>;
export { app, httpServer, wss };
//# sourceMappingURL=index.d.ts.map