import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
    console.log('🌱 Seeding database...');
    // Create super admins
    const admins = [
        { walletAddress: '0x1111111111111111111111111111111111111111' },
        { walletAddress: '0x2222222222222222222222222222222222222222' },
        { walletAddress: '0x3333333333333333333333333333333333333333' },
    ];
    for (const admin of admins) {
        await prisma.superAdmin.upsert({
            where: { walletAddress: admin.walletAddress },
            create: { ...admin, masterDeviceSerial: `DEVICE-${admin.walletAddress.slice(-4)}` },
            update: {}
        });
        await prisma.user.upsert({
            where: { walletAddress: admin.walletAddress },
            create: { walletAddress: admin.walletAddress, role: 'super_admin' },
            update: { role: 'super_admin' }
        });
    }
    // Create sample projects
    const projects = [
        {
            name: 'AquaProtocol',
            symbol: 'AQUA',
            description: 'Next-generation DeFi liquidity protocol with automated market making',
            category: 'DeFi',
            chain: 'Hoodi',
            tier: 'Gold',
            rate: 10,
            softCap: 100000,
            hardCap: 500000,
            startTime: new Date(Date.now() + 60000),
            endTime: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            status: 'approved',
            logoUrl: 'https://picsum.photos/seed/aqua/100',
            website: 'https://aquaprotocol.io',
        },
        {
            name: 'NexaChain',
            symbol: 'NEXA',
            description: 'Layer 2 scaling solution with zero-knowledge proofs for enterprise',
            category: 'Infrastructure',
            chain: 'Base Sepolia',
            tier: 'Platinum',
            rate: 5,
            softCap: 500000,
            hardCap: 2000000,
            startTime: new Date(Date.now() + 60000),
            endTime: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
            status: 'approved',
            logoUrl: 'https://picsum.photos/seed/nexa/100',
            website: 'https://nexachain.io',
        },
        {
            name: 'MetaVault',
            symbol: 'MVT',
            description: 'Decentralized asset management platform for institutional investors',
            category: 'Asset Management',
            chain: 'Hoodi',
            tier: 'Silver',
            rate: 20,
            softCap: 50000,
            hardCap: 200000,
            startTime: new Date(Date.now() + 60000),
            endTime: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
            status: 'approved',
            logoUrl: 'https://picsum.photos/seed/meta/100',
            website: 'https://metavault.fi',
        },
        {
            name: 'GreenToken',
            symbol: 'GRT',
            description: 'Carbon credit tokenization platform for ESG compliance',
            category: 'RWA',
            chain: 'Hoodi',
            tier: 'Bronze',
            rate: 50,
            softCap: 10000,
            hardCap: 50000,
            startTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
            endTime: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
            status: 'pending',
            logoUrl: 'https://picsum.photos/seed/green/100',
        },
        {
            name: 'OmniDEX',
            symbol: 'OMNI',
            description: 'Cross-chain DEX aggregator supporting 30+ blockchains',
            category: 'DeFi',
            chain: 'Base Sepolia',
            tier: 'Gold',
            rate: 8,
            softCap: 200000,
            hardCap: 1000000,
            startTime: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
            endTime: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
            status: 'active',
            logoUrl: 'https://picsum.photos/seed/omni/100',
        },
    ];
    for (const p of projects) {
        const project = await prisma.project.upsert({
            where: { id: `seed-${p.symbol.toLowerCase()}` },
            create: {
                id: `seed-${p.symbol.toLowerCase()}`,
                ...p,
                stats: {
                    create: {
                        tvl: Math.random() * p.hardCap * 0.4,
                        investorCount: Math.floor(Math.random() * 200) + 10
                    }
                }
            },
            update: {}
        });
        console.log(`  ✅ Project: ${project.name}`);
    }
    // Create a demo stablecoin account
    await prisma.stablecoinAccount.upsert({
        where: { sxId: '0x1234567890123456789012345678901234567890' },
        create: {
            sxId: '0x1234567890123456789012345678901234567890',
            usdcBalance: 5000,
            usdtBalance: 2500,
            daiBalance: 1000,
            unifiedBalance: 7501
        },
        update: {}
    });
    // Create kill switch record (inactive)
    const existingKS = await prisma.killSwitch.findFirst();
    if (!existingKS) {
        await prisma.killSwitch.create({ data: { active: false } });
    }
    console.log('\n✅ Database seeded successfully!');
    console.log('Super admins:', admins.map(a => a.walletAddress));
    console.log('Projects:', projects.map(p => p.name));
}
main()
    .catch(e => { console.error('❌ Seed error:', e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
//# sourceMappingURL=seed.js.map