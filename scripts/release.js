'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const lib = require('./release-lib.js');

function git(args) { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
function preflight(opts) {
  const version = opts.version || require('../package.json').version;
  const result = lib.runCheck({
    cwd: process.cwd(),
    version,
    packageVersion: require('../package.json').version,
    changelog: fs.readFileSync('CHANGELOG.md', 'utf8'),
    readmeText: fs.readFileSync('README.md', 'utf8'),
    statusText: git(['status', '--porcelain']),
    tags: git(['tag', '--list']).split(/\r?\n/).filter(Boolean),
    allowExistingTag: !!opts.check || !!opts['allow-existing-tag']
  });
  if (!result.ok) { console.error(result.errors.join('\n')); process.exit(1); }
  // 发布文档检查仅在完整模式执行；--check 只做代码/版本预检
  if (!opts.check) {
    for (const key of ['change-card', 'review-evidence']) {
      if (!opts[key] || !fs.existsSync(opts[key])) { console.error('缺少 --' + key); process.exit(1); }
    }
    execFileSync('python', ['scripts/check_change_card.py', opts['change-card'], '--json'], { stdio: 'inherit' });
    execFileSync('python', ['scripts/check_review_evidence.py', opts['review-evidence'], '--json', '--require-second'], { stdio: 'inherit' });
  }
  console.log('release preflight OK: v' + version);
  return version;
}

if (require.main === module) {
  const opts = lib.parseReleaseArgs(process.argv.slice(2));
  preflight(opts);
}
module.exports = { preflight };
