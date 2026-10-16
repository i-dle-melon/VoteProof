// File-backed shared renderer; real workerd/Worker transport tests remain in CI.
import { defineConfig } from '@playwright/test';
import config from './playwright.component.config.js';
import {resolve} from 'node:path';
export default defineConfig({...config,testMatch:['content.spec.js','prelaunch.spec.js','campaign-category.spec.js','admin-export-transport.spec.js'],outputDir:'.wrangler/prelaunch-browser',use:{...config.use,launchOptions:{downloadsPath:resolve('.wrangler/prelaunch-downloads')}}});
