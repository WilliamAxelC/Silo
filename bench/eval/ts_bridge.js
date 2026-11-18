#!/usr/bin/env node
/**
 * Runs Silo's actual TypeScript OCR heuristics (src/services/ocr/MlKitEngine.ts)
 * and prompt OCR filter (src/services/ai/agent.ts) in Node using sucrase from
 * node_modules, stubbing React Native / Expo native dependencies.
 *
 * Reads JSON array of { id, rawText } from stdin and writes JSON array of
 * { id, heuristic, filteredOcrText, heuristicMs } to stdout.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { performance } = require('perf_hooks');

const REPO_ROOT = path.resolve(__dirname, '../..');
const { transform } = require(path.join(REPO_ROOT, 'node_modules/sucrase'));

const noopProxy = new Proxy(() => noopProxy, {
  get: (_, key) => (key === 'default' ? noopProxy : noopProxy),
});

const tsModuleCache = new Map();
function loadTsModule(absPath) {
  if (tsModuleCache.has(absPath)) return tsModuleCache.get(absPath).exports;
  const src = fs.readFileSync(absPath, 'utf8');
  const { code } = transform(src, { transforms: ['typescript', 'imports'] });
  const mod = new Module(absPath);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  tsModuleCache.set(absPath, mod);
  mod._compile(code, absPath);
  return mod.exports;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'expo-constants') {
    return { default: { appOwnership: 'standalone' }, appOwnership: 'standalone' };
  }
  if (request === 'react-native') {
    return { Platform: { OS: 'android' }, Alert: { alert: () => {} } };
  }
  if (request.startsWith('@react-native-ml-kit/')) {
    return {};
  }
  if (request === './types' && parent && parent.filename.endsWith('MlKitEngine.ts')) {
    return {};
  }
  if (parent && parent.filename.endsWith('agent.ts')) {
    if (request === '../ocr/MlKitEngine') {
      return loadTsModule(path.join(REPO_ROOT, 'src/services/ocr/MlKitEngine.ts'));
    }
    if (request.startsWith('.') || request.startsWith('expo') || request === 'llama.rn') {
      return noopProxy;
    }
  }
  return origLoad.apply(this, arguments);
};

const mlkitEngine = loadTsModule(path.join(REPO_ROOT, 'src/services/ocr/MlKitEngine.ts'));
const agentModule = loadTsModule(path.join(REPO_ROOT, 'src/services/ai/agent.ts'));

const input = fs.readFileSync(0, 'utf8');
const items = JSON.parse(input);
const out = items.map((item) => {
  const t0 = performance.now();
  const heuristic = mlkitEngine.parseReceiptTextHeuristic(item.rawText || '');
  const filteredOcrText = agentModule.filterReceiptOcrTextForAi(item.rawText || '');
  const heuristicMs = performance.now() - t0;
  return {
    id: item.id,
    heuristic,
    filteredOcrText,
    heuristicMs: Math.round(heuristicMs * 1000) / 1000,
  };
});

process.stdout.write(JSON.stringify(out));
