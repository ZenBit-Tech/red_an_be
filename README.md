# red-an-be

A production-ready NestJS backend template with TypeORM (MySQL), ESLint (Airbnb rules), Husky, Swagger, and a fully working example module.

---

## Tech Stack

- **Framework:** NestJS v11
- **Database:** MySQL via TypeORM (Query Builder)
- **Validation:** class-validator + class-transformer
- **API Docs:** Swagger / OpenAPI
- **Linting:** ESLint with Airbnb ruleset + Prettier
- **Git Hooks:** Husky (pre-commit: format → lint → test)

---

## Project Structure

```
src/
├── common/
│   ├── constants.ts                  # App-wide constants
│   ├── db/
│   │   ├── datasource.ts             # TypeORM DataSource config
│   │   └── entities/
│   │       └── example.user.entity.ts
│   └── utils/
│       └── isMySqlError.ts           # MySQL error type guard
├── migrations/
│   └── <timestamp>-Init.ts           # Generated migrations go here
├── modules/
│   └── example-user/                 # ← Use this as a module template
│       ├── dto/
│       │   ├── createExampleUser.dto.ts
│       │   └── returnExampleUser.dto.ts
│       ├── example.user.constants.ts
│       ├── example.user.controller.ts
│       ├── example.user.module.ts
│       └── example.user.service.ts
├── app.controller.ts
├── app.module.ts
├── app.service.ts
└── main.ts
```

### Module Example

The `example-user` module demonstrates the standard pattern for all modules:

| File                 | Purpose                             |
| -------------------- | ----------------------------------- |
| `*.module.ts`        | Registers entity, service, exports  |
| `*.controller.ts`    | Route handlers + Swagger decorators |
| `*.service.ts`       | Business logic using Query Builder  |
| `dto/create*.dto.ts` | Request body validation             |
| `dto/return*.dto.ts` | Response shape (with @Expose())     |

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your MySQL credentials:

```env
PORT=3000
NODE_ENV=development

DB_TYPE=mysql
DB_HOST=localhost
DB_PORT=3306
DB_USERNAME=root
DB_PASSWORD=your_password
DB_NAME=red_an_be_db
```

### 3. Run migrations

```bash
npm run migration:run
```

### 4. Start the server

```bash
# development (watch mode)
npm run start:dev

# production
npm run start:prod
```

### 5. Open Swagger UI

```
http://localhost:3000/api
```

---

## Database (TypeORM)

This project uses **TypeORM with Query Builder** — no `.find()` / `.save()` shortcuts.

All DB operations go through `createQueryBuilder()`. Example from `example.user.service.ts`:

```ts
// SELECT
const users = await this.userRepository.createQueryBuilder('templateUser').getMany();

// INSERT
await this.userRepository
  .createQueryBuilder()
  .insert()
  .into(TemplateUser)
  .values([{ email }])
  .execute();
```

### Migrations

```bash
# Generate a new migration (auto-diffs entities vs DB)
npm run migration:generate src/migrations/<MigrationName>

# Apply pending migrations
npm run migration:run

# Revert last migration
npm run migration:revert

# Show migration status
npm run migration:show
```

> Warning: `synchronize` is set to `false` — always use migrations.

---

## Linting & Formatting

ESLint is configured with the **Airbnb** ruleset + TypeScript + Prettier.

```bash
# Lint and auto-fix
npm run lint

# Format with Prettier
npm run format
```

Key rules (`.eslintrc.js`):

- `airbnb-base` + `airbnb-typescript/base`
- `@typescript-eslint/no-explicit-any` → error
- `@typescript-eslint/no-floating-promises` → warn
- `prettier/prettier` → error

---

## Husky (Git Hooks)

A `pre-commit` hook runs automatically before every commit:

```bash
npm run format && npm run lint && npm test
```

If any step fails, the commit is blocked.

To install hooks after cloning:

```bash
npm install   # automatically runs `husky` via `prepare` script
```

---

## Testing

```bash
# Unit tests
npm run test

# Watch mode
npm run test:watch

# Coverage report
npm run test:cov

# E2E tests
npm run test:e2e
```

---

## Creating a New Module

Follow the `example-user` pattern:

1. Create folder: `src/modules/<your-module>/`
2. Add `dto/`, `*.entity.ts` in `common/db/entities/`
3. Create `*.module.ts`, `*.controller.ts`, `*.service.ts`
4. Register entity in `datasource.ts` → `entities: [...]`
5. Import your module in `app.module.ts`
6. Generate a migration: `npm run migration:generate src/migrations/<name>`
