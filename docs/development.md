# Development

Install dependencies and run the complete project check:

```bash
npm ci
npm run check
```

`npm run check` runs formatting, type checks, tests, fixture checks, schema generation checks, build checks, and package validation. Use narrower commands during iteration:

```bash
npm run test
npm run test:coverage
npm run fixtures:check
npm run build
npm run inspector
```

Keep changes focused and include tests for behavior changes. CI fixtures must be synthetic and project-owned; never commit installed-game or third-party-mod content. Public tool or schema changes require compatibility review and a versioned release.

See the package [Security Policy](../SECURITY.md) for private vulnerability reporting.
