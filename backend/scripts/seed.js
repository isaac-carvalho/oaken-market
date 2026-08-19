const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const oaken = await prisma.seller.upsert({
    where: { slug: 'oaken' },
    update: {},
    create: { slug: 'oaken', name: 'Oaken Cursos' },
  });
  console.log('Seller seed:', oaken);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
