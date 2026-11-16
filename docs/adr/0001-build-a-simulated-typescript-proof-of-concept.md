# Build a simulated TypeScript proof of concept

The first implementation demonstrates the complete payment journey and tests declines, retries, crashes, and uncertain outcomes using synthetic payments. It follows the supplied reference design for Paybridge, a sample merchant application, and a mock 4Cs provider, with separate local persistence and headless checkout routes; customer release, live provider integration, and production compliance are outside this milestone.

The owner confirmed TypeScript, Fastify, Prisma ORM 8, SQLite, ArkType, `@fastify/swagger`, Vitest, and Bun as package manager. The design review will correct gaps within that plan; implementation must verify the selected packages' compatibility before relying on them.

ASP.NET portability is not a requirement. Go is a possible later implementation, not a reason to add abstractions or translation work to this proof of concept.
