#!/usr/bin/env node
/**
 * sync-shared.js
 * ──────────────────────────────────────────────────────────────
 * lambda/shared/utils.js (원본) 를 모든 람다 함수 폴더에
 * shared.js 라는 이름으로 복사한다.
 *
 * 왜 필요한가:
 *   Lambda Layer 는 sam build 단계(npm / make)에 의존하는데,
 *   그 단계가 환경마다 깨졌다. 그래서 Layer 를 폐기하고
 *   공유 코드를 각 함수에 직접 포함하는 방식으로 전환했다.
 *   각 함수는 "./shared.js" 를 상대경로로 import 하므로
 *   빌드 단계에서 의존성 해석이 일절 필요 없다.
 *
 * 사용법 (sam build 전에 1회 실행):
 *   node sync-shared.js
 *
 * 원본은 항상 lambda/shared/utils.js 한 곳만 수정하면 된다.
 * 각 함수 폴더의 shared.js 는 이 스크립트가 덮어쓰므로 직접 건드리지 말 것.
 * ──────────────────────────────────────────────────────────────
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SOURCE = path.join(ROOT, "lambda", "shared", "utils.js");
const FUNCTIONS_DIR = path.join(ROOT, "lambda", "functions");

if (!fs.existsSync(SOURCE)) {
  console.error(`✗ 원본을 찾을 수 없습니다: ${SOURCE}`);
  process.exit(1);
}

const functionDirs = fs
  .readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

let count = 0;
for (const fn of functionDirs) {
  const dest = path.join(FUNCTIONS_DIR, fn, "shared.js");
  fs.copyFileSync(SOURCE, dest);
  console.log(`  ✓ ${fn}/shared.js`);
  count++;
}

console.log(`\n완료: ${count}개 함수에 shared.js 동기화됨`);
