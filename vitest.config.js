import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/**/*.vitest.mjs'], environment: 'node', coverage: { reporter: ['text', 'json-summary'] } } });
