import {defineConfig} from '@playwright/test';
import config from './playwright.component.config.js';
export default defineConfig({...config,testMatch:['ui-iteration.spec.js','content.spec.js','prelaunch.spec.js'],outputDir:'.wrangler/ui-iteration-browser'});
