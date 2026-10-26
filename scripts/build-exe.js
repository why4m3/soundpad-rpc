'use strict';

// Builds the release: a single soundpad-rpc executable (Node.js SEA, no Node
// install needed) plus the files it ships with, in dist/soundpad-rpc/.
//
//   npm i --no-save esbuild@0.25.0 postject@1.0.0-alpha.6 rcedit@4.0.1
//   node scripts/build-exe.js
//
// The build tools are installed only for the build, the app itself stays
// dependency free. rcedit (exe icon and version info) is used on Windows only.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'soundpad-rpc');
const isWin = process.platform === 'win32';
const pkg = require('../package.json');

async function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const bundle = path.join(DIST, 'bundle.cjs');
  await require('esbuild').build({
    entryPoints: [path.join(ROOT, 'index.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node' + process.versions.node.split('.')[0],
    outfile: bundle,
    logLevel: 'warning',
  });

  const blob = path.join(DIST, 'sea-prep.blob');
  const seaConfig = path.join(DIST, 'sea-config.json');
  fs.writeFileSync(seaConfig, JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
  }));
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

  const exe = path.join(OUT, isWin ? 'soundpad-rpc.exe' : 'soundpad-rpc');
  fs.copyFileSync(process.execPath, exe);
  fs.chmodSync(exe, 0o755);

  if (isWin) {
    const version = pkg.version + '.0';
    await require('rcedit')(exe, {
      icon: path.join(ROOT, 'assets', 'icon.ico'),
      'file-version': version,
      'product-version': version,
      'version-string': {
        FileDescription: 'Discord Rich Presence for Soundpad',
        ProductName: 'soundpad-rpc',
        OriginalFilename: 'soundpad-rpc.exe',
        InternalName: 'soundpad-rpc',
        CompanyName: pkg.author,
        LegalCopyright: 'MIT License',
      },
    });
  }

  await require('postject').inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  });

  for (const f of ['config.example.json', 'README.md', 'README.ru.md', 'LICENSE']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
  }
  fs.cpSync(path.join(ROOT, 'windows'), path.join(OUT, 'windows'), {
    recursive: true,
    filter: (src) => path.basename(src) !== 'node-path.txt',
  });
  fs.mkdirSync(path.join(OUT, 'assets'));
  fs.copyFileSync(path.join(ROOT, 'assets', 'logo.png'), path.join(OUT, 'assets', 'logo.png'));

  console.log('Built ' + path.relative(ROOT, exe) + ' (' + pkg.version + ')');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
