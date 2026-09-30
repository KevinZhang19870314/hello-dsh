#!/usr/bin/env node
/**
 * Generate the static GitHub Pages site in `docs/`.
 *
 *   npm run build:pages
 *
 * GitHub Pages serves static files only, so the Node server is replaced by
 * `site/local-api.js`, which patches `window.fetch` and answers `/api/**` from
 * `localStorage` with the same reply engine (`src/local-replies.js`).
 *
 * Generated into `docs/` (everything else in that folder, e.g. the README
 * screenshot, is left untouched):
 *
 *   index.html        rewritten copy of public/index.html
 *   app.js            verbatim copy of public/app.js
 *   styles.css        verbatim copy of public/styles.css
 *   boot.js           verbatim copy of site/boot.js
 *   local-api.js      verbatim copy of site/local-api.js
 *   local-replies.js  verbatim copy of src/local-replies.js
 *   text-utils.js     verbatim copy of src/text-utils.js
 *   .nojekyll         skip Jekyll processing
 *
 * This script is the single source of truth for the Pages bundle: any rewrite
 * of `public/index.html` is asserted, so the build fails loudly instead of
 * silently shipping a site that points at the wrong URLs.
 */

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs');

/**
 * `public/index.html` uses absolute URLs (`/styles.css`) because the Node server
 * always serves the app from the domain root. A GitHub Pages *project* site is
 * published under `/<repo>/`, so every asset URL must become relative.
 * @type {{ from: string, to: string, what: string }[]}
 */
const REWRITES = [
  {
    from: 'href="/styles.css"',
    to: 'href="./styles.css"',
    what: '样式表链接（/styles.css → ./styles.css）',
  },
  {
    from: '<script type="module" src="/app.js"></script>',
    to: '<script type="module" src="./boot.js"></script>',
    what: '入口脚本（/app.js → ./boot.js，先装载本地 API 垫片）',
  },
  {
    from: '<title>hello-dsh · 聊天</title>',
    to: '<title>hello-dsh · 聊天（在线演示）</title>',
    what: '页面标题',
  },
];

/** Verbatim copies: [source, destination filename]. Exported so `npm test` can
 * assert that `docs/` is not stale. */
export const COPIES = [
  ['public/app.js', 'app.js'],
  ['public/styles.css', 'styles.css'],
  ['site/boot.js', 'boot.js'],
  ['site/local-api.js', 'local-api.js'],
  ['src/local-replies.js', 'local-replies.js'],
  ['src/text-utils.js', 'text-utils.js'],
];

/** Where the generated site lives, relative to the repo root. */
export const OUTPUT_DIR = 'docs';

/**
 * @param {string} html
 * @returns {string}
 */
function rewriteHtml(html) {
  let output = html;
  for (const rule of REWRITES) {
    if (!output.includes(rule.from)) {
      throw new Error(
        `public/index.html 里找不到需要替换的${rule.what}：\n  ${rule.from}\n` +
          '请同步更新 scripts/build-pages.js 的 REWRITES。',
      );
    }
    output = output.replace(rule.from, rule.to);
  }
  return output;
}

/**
 * Fail the build if `docs/index.html` points at a file we did not produce.
 * @param {string} html
 */
async function assertAssetsExist(html) {
  const referenced = new Set(
    [...html.matchAll(/(?:href|src)="\.\/([^"?#]+)/g)].map((match) => match[1]),
  );
  const missing = [];
  for (const asset of referenced) {
    const found = await stat(join(outDir, asset)).catch(() => null);
    if (!found?.isFile()) missing.push(asset);
  }
  if (missing.length > 0) {
    throw new Error(`docs/index.html 引用了不存在的文件：${missing.join(', ')}`);
  }
  return [...referenced].sort();
}

export async function main() {
  await mkdir(outDir, { recursive: true });

  const sourceHtml = await readFile(join(root, 'public', 'index.html'), 'utf8');
  const html = rewriteHtml(sourceHtml);
  await writeFile(join(outDir, 'index.html'), html, 'utf8');

  for (const [source, destination] of COPIES) {
    await copyFile(join(root, source), join(outDir, destination));
  }

  // Without this, Pages runs Jekyll over the output; we ship plain ES modules.
  await writeFile(join(outDir, '.nojekyll'), '');

  const assets = await assertAssetsExist(html);

  console.log('已生成 GitHub Pages 站点 → docs/');
  for (const name of ['index.html', ...COPIES.map(([, destination]) => destination), '.nojekyll']) {
    console.log(`  docs/${name}`);
  }
  console.log(`  index.html 引用并校验通过：${assets.join(', ')}`);
}

// Only build when run as a script; `npm test` imports COPIES from this module.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`build-pages 失败：${error.message}`);
    process.exitCode = 1;
  });
}
