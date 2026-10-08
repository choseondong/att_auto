// @ts-check
import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    locale: 'ko-KR',
    // 결과 스크린샷은 각 스펙이 real_att_results / real_att_day_results 에 직접 저장하므로 test-results 저장은 끈다.
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
});
