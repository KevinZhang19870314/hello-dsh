#!/usr/bin/env node
/**
 * hello-dsh chat server entry point.
 *
 *   npm start                # http://127.0.0.1:3210
 *   node src/index.js --port 8080 --host 0.0.0.0
 */

import process from 'node:process';
import { DEFAULT_HOST, DEFAULT_PORT, startServer } from './server.js';
import { dataFilePath } from './storage.js';
import { assistantMode } from './assistant.js';
import { loadEnv } from './env.js';

const HELP = `hello-dsh — 一个类似 ChatGPT 的网页聊天应用

用法
  npm start                          启动服务（默认 http://127.0.0.1:3210）
  node src/index.js [选项]

选项
  -p, --port <number>   监听端口（默认 ${DEFAULT_PORT}，0 表示随机端口）
      --host <address>  监听地址（默认 ${DEFAULT_HOST}）
      --env <path>      指定 .env 文件（默认 <项目>/.env）
  -h, --help            显示帮助

环境变量
  PORT / HOST           与 --port / --host 等价
  CHAT_DATA             对话数据文件路径（默认 <项目>/data/conversations.json）
  DEEPSEEK_API_KEY      配置后接入 DeepSeek 实时回复，否则使用本地演示回复
  DEEPSEEK_MODEL        模型名（默认 deepseek-chat）
  DEEPSEEK_BASE_URL     接口地址（默认 https://api.deepseek.com）

配置文件
  项目根目录下的 .env（KEY=VALUE，# 开头为注释）会在启动时自动读取，
  也可以复制 .env.example 作为模板。shell 中已存在的变量优先于 .env。`;

/**
 * Peek at --env before anything else runs, so the file can also define PORT/HOST.
 * @param {string[]} argv
 * @returns {string | undefined}
 */
function envFileFromArgv(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--env') return argv[index + 1];
    if (arg.startsWith('--env=')) return arg.slice('--env='.length) || undefined;
  }
  return undefined;
}

/**
 * @param {string[]} argv
 * @returns {{ port: number, host: string, help: boolean, envFile?: string }}
 */
function parseArgs(argv) {
  const options = {
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    host: process.env.HOST?.trim() || DEFAULT_HOST,
    help: false,
    envFile: envFileFromArgv(argv),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--port' || arg === '-p') {
      options.port = Number(argv[++index]);
    } else if (arg.startsWith('--port=')) {
      options.port = Number(arg.slice('--port='.length));
    } else if (arg === '--host') {
      options.host = String(argv[++index] ?? '');
    } else if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length);
    } else if (arg === '--env') {
      index += 1;
      options.envFile = argv[index] === undefined ? undefined : String(argv[index]);
    } else if (arg.startsWith('--env=')) {
      options.envFile = arg.slice('--env='.length) || undefined;
    } else {
      throw new Error(`未知参数 "${arg}"（试试 --help）`);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`端口不合法："${options.port}"`);
  }
  if (!options.host) {
    throw new Error('监听地址不能为空');
  }
  return options;
}

async function main(argv) {
  // Load .env first: it may define PORT/HOST/CHAT_DATA/DEEPSEEK_* as well.
  const envInfo = loadEnv({ file: envFileFromArgv(argv) });
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const { server, url, port } = await startServer({ port: options.port, host: options.host });
  const mode = assistantMode();

  console.log(`hello-dsh 聊天服务已启动`);
  console.log(`  地址      ${url}`);
  console.log(`  端口      ${port}`);
  console.log(`  数据文件  ${dataFilePath()}`);
  console.log(`  回复模式  ${mode === 'deepseek' ? 'DeepSeek API' : '本地演示（未配置 DEEPSEEK_API_KEY）'}`);
  if (envInfo.found) {
    const skipped = envInfo.skipped.length > 0 ? `，忽略 ${envInfo.skipped.length} 项已存在的变量` : '';
    console.log(`  配置文件  ${envInfo.file}（载入 ${envInfo.applied.length} 项${skipped}）`);
  } else if (options.envFile) {
    console.log(`  配置文件  ${envInfo.file} 不存在，已跳过`);
  } else {
    console.log(`  配置文件  未找到 ${envInfo.file}（可复制 .env.example 作为模板）`);
  }
  console.log(`\n在浏览器中打开上面的地址即可开始聊天，按 Ctrl+C 停止。`);

  const shutdown = () => {
    console.log('\n正在关闭服务…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return undefined;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`hello-dsh: ${error.message}`);
  process.exitCode = 1;
});
