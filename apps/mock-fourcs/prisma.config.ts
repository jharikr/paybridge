import { definePrismaConfig } from "prisma/config";
import { defineConfig } from "@prisma/orm-sqlite/config";

export default definePrismaConfig({
  orm: defineConfig({
    contract: "./contract.prisma",
    migrations: { dir: "./migrations" },
  }),
});
