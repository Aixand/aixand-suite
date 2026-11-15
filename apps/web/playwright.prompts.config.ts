import { defineConfig } from '@playwright/test'
import base from './playwright.builder.config'

export default defineConfig({
  ...base,
  testMatch: 'prompts.spec.ts',
  outputDir: 'test-results/prompts',
})
