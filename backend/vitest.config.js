import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.js'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'json-summary'],
            reportsDirectory: './coverage',
            include: ['index.js', 'routes/**/*.js', 'utils/**/*.js'],
            exclude: ['test/**', 'uploads/**']
        }
    },
});
