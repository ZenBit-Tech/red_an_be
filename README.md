# red-an-be

A production-ready NestJS backend template with TypeORM (MySQL), ESLint (Airbnb rules), Husky, Swagger, and a fully working user module.

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
│   │       └── user.entity.ts
│   └── utils/
│       └── isMySqlError.ts           # MySQL error type guard
├── migrations/
│   └── <timestamp>-Init.ts           # Generated migrations go here
├── modules/
│   ├── user/
│   │   ├── dto/
│   │   │   ├── createUser.dto.ts
│   │   │   └── returnUser.dto.ts
│   │   ├── user.constants.ts
│   │   ├── user.controller.ts
│   │   ├── user.module.ts
│   │   └── user.service.ts
│   └── mail/
│       ├── mail.constants.ts
│       ├── mail.module.ts
│       └── mail.service.ts
├── templates/
│   ├── contact-lead.html
│   └── magic-link-email.html
├── app.controller.ts
├── app.module.ts
├── app.service.ts
└── main.ts
```

### Module Example

The `user` module demonstrates the standard pattern for all modules:

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
JWT_SECRET=replace_with_strong_random_secret
JWT_EXPIRATION=3600

DB_TYPE=mysql
DB_HOST=localhost
DB_PORT=3306
DB_USERNAME=app_user
DB_PASSWORD=your_password
DB_ROOT_PASSWORD=your_root_password
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

### Docker Compose (production profile)

Use the dedicated production compose file so MySQL and Presidio services are not exposed via host ports.

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Stop services:

```bash
docker compose -f docker-compose.prod.yml down
```

### Docker Compose (development infra only)

Run only infrastructure services (MySQL + Presidio) and keep NestJS running locally with watch mode.

```bash
docker compose -f docker-compose.dev.yml up -d
npm run start:dev
```

Stop infrastructure:

```bash
docker compose -f docker-compose.dev.yml down
```

### 5. Open Swagger UI

```
http://localhost:3000/api
```

---

## Database (TypeORM)

This project uses **TypeORM with Query Builder** — no `.find()` / `.save()` shortcuts.

All DB operations go through `createQueryBuilder()`. Example from `user.service.ts`:

```ts
// SELECT
const users = await this.userRepository.createQueryBuilder('user').getMany();

// INSERT
await this.userRepository
  .createQueryBuilder()
  .insert()
  .into(User)
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

Development workflow guides are in [CONTRIBUTING.md](./CONTRIBUTING.md).
