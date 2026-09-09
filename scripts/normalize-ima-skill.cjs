#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKILLS_ROOT = path.join(ROOT, '.agents', 'skills');
const SKILL_DIR = path.join(SKILLS_ROOT, '@tencent-adm', 'ima-skills');
const ROOT_SKILL = path.join(SKILL_DIR, 'SKILL.md');
const LOCKFILE = path.join(SKILLS_ROOT, '.skills_store_lock.json');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(ROOT_SKILL)) {
  fail(`IMA skill not found: ${ROOT_SKILL}`);
}

for (const moduleName of ['knowledge-base', 'notes']) {
  const moduleDir = path.join(SKILL_DIR, moduleName);
  const nestedSkill = path.join(moduleDir, 'SKILL.md');
  const guide = path.join(moduleDir, 'GUIDE.md');

  if (fs.existsSync(nestedSkill) && fs.existsSync(guide)) {
    fail(`Both SKILL.md and GUIDE.md exist in ${moduleDir}`);
  }
  if (fs.existsSync(nestedSkill)) {
    fs.renameSync(nestedSkill, guide);
  }
  if (!fs.existsSync(guide)) {
    fail(`Module guide not found: ${guide}`);
  }
}

let rootSkill = fs.readFileSync(ROOT_SKILL, 'utf8');
rootSkill = rootSkill.replace(
  /^homepage: https:\/\/ima\.qq\.com\nmetadata:\n/m,
  'metadata:\n  homepage: https://ima.qq.com\n',
);
rootSkill = rootSkill
  .replaceAll('knowledge-base/SKILL.md', 'knowledge-base/GUIDE.md')
  .replaceAll('notes/SKILL.md', 'notes/GUIDE.md')
  .replace('must first read the SKILL.md files', 'must first read the GUIDE.md files')
  .replace('必须先读取两个模块的 SKILL.md', '必须先读取两个模块的 GUIDE.md');
fs.writeFileSync(ROOT_SKILL, rootSkill, 'utf8');

if (fs.existsSync(LOCKFILE)) {
  const lock = JSON.parse(fs.readFileSync(LOCKFILE, 'utf8'));
  const entry = lock.skills && lock.skills['@tencent-adm/ima-skills'];
  if (entry) {
    entry.installDir = SKILL_DIR;
    fs.writeFileSync(LOCKFILE, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  }
}

process.stdout.write(`Normalized IMA skill: ${SKILL_DIR}\n`);
