import { WebSocketServer, WebSocket } from 'ws';
import { prisma } from '../lib/prisma.js';

interface WsClient {
  ws: WebSocket;
  walletAddress?: string;
  type?: string;
}

const clients: Set<WsClient> = new Set();

export function setupWebSocket(wss: WebSocketServer) {
  wss.on('connection', (ws, req) => {
    const client: WsClient = { ws };
    clients.add(client);

    console.log(`WebSocket client connected. Total: ${clients.size}`);

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'subscribe') {
          client.walletAddress = message.walletAddress?.toLowerCase();
          client.type = message.subscriptionType || 'referral';
          ws.send(JSON.stringify({ type: 'subscribed', walletAddress: client.walletAddress }));
          
          // Send initial data immediately
          if (client.walletAddress) {
            await sendReferralUpdate(client);
          }
        }

        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      clients.delete(client);
      console.log(`WebSocket client disconnected. Total: ${clients.size}`);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
      clients.delete(client);
    });

    // Send welcome
    ws.send(JSON.stringify({ 
      type: 'connected',
      message: 'Launchpad WebSocket connected',
      timestamp: new Date().toISOString()
    }));
  });

  // Broadcast referral updates every 3 seconds (skip in tests to prevent open handles)
  if (process.env.NODE_ENV !== 'test') {
    setInterval(async () => {
      for (const client of clients) {
        if (client.ws.readyState === WebSocket.OPEN && client.walletAddress && client.type === 'referral') {
          await sendReferralUpdate(client);
        }
      }
    }, 3000);
  }
}

async function sendReferralUpdate(client: WsClient) {
  if (!client.walletAddress || client.ws.readyState !== WebSocket.OPEN) return;
  
  try {
    const referrals = await prisma.referral.findMany({
      where: { referrerId: client.walletAddress }
    });

    const total = referrals.length;
    const successful = referrals.filter(r => r.status === 'completed').length;
    const pending = referrals.filter(r => r.status === 'pending').length;
    const rewards = successful * 100;
    const byPlatform = {
      telegram: referrals.filter(r => r.platform === 'telegram').length,
      twitter: referrals.filter(r => r.platform === 'twitter').length,
      facebook: referrals.filter(r => r.platform === 'facebook').length,
    };

    client.ws.send(JSON.stringify({
      type: 'referral_update',
      data: { total, successful, pending, rewards, byPlatform },
      timestamp: new Date().toISOString()
    }));
  } catch (err) {
    // Client might have disconnected
  }
}

// Broadcast to all clients of a specific wallet
export function broadcastToWallet(walletAddress: string, data: any) {
  for (const client of clients) {
    if (client.walletAddress === walletAddress.toLowerCase() && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(data));
    }
  }
}

// Broadcast to all connected clients
export function broadcastAll(data: any) {
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(data));
    }
  }
}
